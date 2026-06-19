import { beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import type { TowerMigration } from "../src/tower-db.ts";

const secretKey = new Uint8Array(32).fill(8);
const pubkey = getPublicKey(secretKey);

process.env.KINDLING_DB_MODE = "tower";
process.env.WINGMAN_URL = "http://127.0.0.1:9";
process.env.WAPP_OWNER_NPUB = nip19.npubEncode(pubkey);

const { handleApi, runAutomatedProspectingLoop, startKindlingBackgroundTasks } = await import("../src/server.ts");
const { createTowerStore, resetTowerStoreForTests, towerHasAccess } = await import("../src/tower-store.ts");
const { TowerDbError, initializeTowerDbRuntime } = await import("../src/tower-db.ts");
const { db } = await import("../src/db.ts");

type Call = { op: string; table?: string; id?: string; input?: Record<string, unknown> };

class FakeTowerClient {
  calls: Call[] = [];
  throwOnMissingGet = false;
  tables = new Map<string, Map<string, Record<string, unknown>>>();

  async provision(appSlug: string) {
    this.calls.push({ op: "provision", input: { appSlug } });
    return { ok: true };
  }

  async runMigrations(migrations: TowerMigration[]) {
    this.calls.push({ op: "migrations", input: { count: migrations.length } });
    return { applied: migrations.map((migration) => migration.version) };
  }

  async createRow(table: string, data: Record<string, unknown>, id?: string) {
    this.calls.push({ op: "create", table, id, input: data });
    const tableRows = this.table(table);
    const rowId = id || String(data.id ?? data.pubkey ?? data.token ?? data.key);
    const existing = tableRows.get(rowId) || {};
    const row = { ...existing, ...data };
    tableRows.set(rowId, row);
    return { row };
  }

  async getRow(table: string, id: string) {
    this.calls.push({ op: "get", table, id });
    const row = this.table(table).get(id);
    if (!row && this.throwOnMissingGet) throw new TowerDbError("row not found", 404, { error: "row not found" });
    return { row: row ?? null };
  }

  async queryRows(table: string, input: Record<string, unknown>) {
    this.calls.push({ op: "query", table, input });
    let rows = [...this.table(table).values()];
    const where = input.where && typeof input.where === "object" && !Array.isArray(input.where) ? input.where as Record<string, Record<string, unknown>> : {};
    rows = rows.filter((row) => Object.entries(where).every(([field, op]) => {
      if ("eq" in op) return row[field] === op.eq;
      if ("in" in op && Array.isArray(op.in)) return op.in.includes(row[field]);
      return true;
    }));
    const order = Array.isArray(input.order) ? input.order as Array<{ field: string; dir?: string }> : [];
    for (const entry of [...order].reverse()) {
      rows.sort((a, b) => {
        const av = String(a[entry.field] ?? "");
        const bv = String(b[entry.field] ?? "");
        return entry.dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }
    const offset = Math.max(0, Number(input.offset ?? 0));
    const limit = Math.max(1, Number(input.limit ?? 500));
    return { rows: rows.slice(offset, offset + limit) };
  }

  async patchRow(table: string, id: string, set: Record<string, unknown>) {
    this.calls.push({ op: "patch", table, id, input: set });
    const tableRows = this.table(table);
    const row = { ...(tableRows.get(id) || { id }), ...set };
    tableRows.set(id, row);
    return { row };
  }

  async deleteRow(table: string, id: string) {
    this.calls.push({ op: "delete", table, id });
    this.table(table).delete(id);
    return { ok: true };
  }

  table(name: string) {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = new Map();
      this.tables.set(name, rows);
    }
    return rows;
  }
}

let fake: FakeTowerClient;
let token = "";

beforeEach(async () => {
  fake = new FakeTowerClient();
  resetTowerStoreForTests(createTowerStore(fake as never));
  token = "";
  await fake.createRow("access_rules", {
    pubkey,
    npub: "npub-test",
    role: "edit",
    created_at: 1,
  }, `${pubkey}:edit`);
});

async function api(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  });
  const req = new Request(`http://kindling.test${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const res = await handleApi(req, new URL(req.url));
  if (!res) throw new Error(`No response for ${path}`);
  const payload = await res.json().catch(() => ({}));
  return { res, payload };
}

function loginEvent(content: string) {
  return finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  }, secretKey);
}

describe("Tower-mode Kindling API facade", () => {
  test("startup provisions and migrates before route data access", async () => {
    fake.calls = [];
    const result = await initializeTowerDbRuntime(fake as never, true);

    expect(result.mode).toBe("tower");
    expect(fake.calls[0]?.op).toBe("provision");
    expect(fake.calls[1]?.op).toBe("migrations");
  });

  test("login, session, and access checks use Tower rows", async () => {
    const challenge = await api("/api/auth/challenge", { method: "POST", body: { pubkey } });
    expect(challenge.res.status).toBe(200);
    expect(fake.calls.some((call) => call.op === "create" && call.table === "login_challenges")).toBe(true);

    const verified = await api("/api/auth/verify", {
      method: "POST",
      body: { event: loginEvent(String(challenge.payload.content)) },
    });
    expect(verified.res.status).toBe(200);
    token = String(verified.payload.token);

    const me = await api("/api/me");
    expect(me.payload.pubkey).toBe(pubkey);
    expect(me.payload.access).toMatchObject({ login: true, read: true, edit: true });
    expect(fake.calls.some((call) => call.op === "get" && call.table === "sessions")).toBe(true);
  });

  test("login challenge upsert tolerates Tower missing-row responses", async () => {
    fake.throwOnMissingGet = true;

    const challenge = await api("/api/auth/challenge", { method: "POST", body: { pubkey } });

    expect(challenge.res.status).toBe(200);
    expect(fake.calls).toContainEqual({ op: "get", table: "login_challenges", id: pubkey });
    expect(fake.calls.some((call) => call.op === "create" && call.table === "login_challenges")).toBe(true);
  });

  test("configured Tower WApp owner prevents empty access table from opening all access", async () => {
    fake.table("access_rules").clear();
    const otherPubkey = getPublicKey(new Uint8Array(32).fill(9));

    expect(await towerHasAccess(pubkey, "edit")).toBe(true);
    expect(await towerHasAccess(otherPubkey, "read")).toBe(false);
    expect(await towerHasAccess(otherPubkey, "edit")).toBe(false);
  });

  test("target segment CRUD/list routes call Tower table APIs", async () => {
    token = (await api("/api/auth/verify", {
      method: "POST",
      body: { event: loginEvent(String((await api("/api/auth/challenge", { method: "POST", body: { pubkey } })).payload.content)) },
    })).payload.token as string;

    const created = await api("/api/kindling/target-segments", {
      method: "POST",
      body: { id: "tower-segment", label: "Tower Segment", tier: 1 },
    });
    expect(created.res.status).toBe(201);
    expect(created.payload.segment.id).toBe("tower-segment");

    const listed = await api("/api/kindling/target-segments");
    expect(listed.payload.segments.map((segment: { id: string }) => segment.id)).toContain("tower-segment");
    expect(fake.calls.some((call) => call.op === "create" && call.table === "target_segments")).toBe(true);
    expect(fake.calls.some((call) => call.op === "query" && call.table === "target_segments")).toBe(true);
  });

  test("company create/list/detail/patch routes use Tower as authoritative storage", async () => {
    token = (await api("/api/auth/verify", {
      method: "POST",
      body: { event: loginEvent(String((await api("/api/auth/challenge", { method: "POST", body: { pubkey } })).payload.content)) },
    })).payload.token as string;

    const created = await api("/api/kindling/companies", {
      method: "POST",
      body: { name: "Tower Co", industry: "Accounting", location: "Perth", website: "https://tower.example" },
    });
    expect(created.res.status).toBe(201);
    const companyId = String(created.payload.company.id);

    const listed = await api("/api/kindling/companies?industry=Accounting");
    expect(listed.payload.total).toBe(1);
    expect(listed.payload.companies[0].name).toBe("Tower Co");

    const patched = await api(`/api/kindling/companies/${companyId}`, {
      method: "PATCH",
      body: { name: "Tower Co Updated", confidence: 0.8 },
    });
    expect(patched.payload.company.name).toBe("Tower Co Updated");

    const detail = await api(`/api/kindling/companies/${companyId}`);
    expect(detail.payload.company.name).toBe("Tower Co Updated");
    expect(fake.calls.some((call) => call.op === "create" && call.table === "companies")).toBe(true);
    expect(fake.calls.some((call) => call.op === "query" && call.table === "companies")).toBe(true);
    expect(fake.calls.some((call) => call.op === "patch" && call.table === "companies")).toBe(true);
  });

  test("Tower-mode Kindling dashboard routes use Tower rows instead of SQLite fallback", async () => {
    const sqliteCountsBefore = {
      companies: db.query("SELECT COUNT(*) AS count FROM companies").get() as { count: number },
      chats: db.query("SELECT COUNT(*) AS count FROM chats").get() as { count: number },
      messages: db.query("SELECT COUNT(*) AS count FROM messages").get() as { count: number },
      kindlingPipelineRuns: db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs").get() as { count: number },
      workQueue: db.query("SELECT COUNT(*) AS count FROM work_queue").get() as { count: number },
    };
    await fake.createRow("pipeline_roles", {
      id: "scan_target_list",
      role_key: "scan_target_list",
      display_name: "Scan Target List",
      active_pipeline_slug: "scan-target-list",
      pipeline_label: "Scan Target List",
      required_input_fields_json: "[]",
      expected_output_shape: "json",
      enabled: 1,
      updated_at: 1,
    }, "scan_target_list");
    await fake.createRow("work_queue", {
      id: "queue-1",
      kind: "enrich_company",
      target_type: "company",
      target_id: "company-1",
      status: "queued",
      priority: 10,
      created_at: 1,
      updated_at: 1,
    }, "queue-1");
    token = (await api("/api/auth/verify", {
      method: "POST",
      body: { event: loginEvent(String((await api("/api/auth/challenge", { method: "POST", body: { pubkey } })).payload.content)) },
    })).payload.token as string;

    const routes = [
      { label: "summary/reporting", path: "/api/kindling/summary?compact=1", method: "GET" },
      { label: "scheduler settings", path: "/api/kindling/scheduler-settings", method: "GET" },
      { label: "scheduler preview", path: "/api/kindling/scheduler/preview", method: "GET" },
      { label: "work queue", path: "/api/kindling/work-queue", method: "GET" },
      { label: "pipeline roles", path: "/api/kindling/pipeline-roles", method: "GET" },
      { label: "coverage slices", path: "/api/kindling/coverage-slices", method: "GET" },
      { label: "top targets", path: "/api/kindling/top-targets", method: "GET" },
      { label: "todays targets", path: "/api/kindling/todays-targets", method: "GET" },
      { label: "chat list", path: "/api/chats", method: "GET" },
    ];

    for (const route of routes) {
      const response = await api(route.path, { method: route.method });
      expect(response.res.status, route.label).not.toBe(501);
      expect(response.res.status, route.label).toBeLessThan(500);
    }

    const createdChat = await api("/api/chats", { method: "POST", body: {} });
    expect(createdChat.res.status).toBe(201);
    const chatId = String(createdChat.payload.chat.id);
    const message = await api(`/api/chats/${chatId}/messages`, { method: "POST", body: { content: "Hello Tower" } });
    expect(message.res.status).toBe(201);
    expect(fake.calls.some((call) => call.op === "create" && call.table === "chats")).toBe(true);
    expect(fake.calls.some((call) => call.op === "create" && call.table === "messages")).toBe(true);

    expect(db.query("SELECT COUNT(*) AS count FROM companies").get()).toEqual(sqliteCountsBefore.companies);
    expect(db.query("SELECT COUNT(*) AS count FROM chats").get()).toEqual(sqliteCountsBefore.chats);
    expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual(sqliteCountsBefore.messages);
    expect(db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs").get()).toEqual(sqliteCountsBefore.kindlingPipelineRuns);
    expect(db.query("SELECT COUNT(*) AS count FROM work_queue").get()).toEqual(sqliteCountsBefore.workQueue);
  });

  test("Tower mode disables legacy startup automation loops", async () => {
    const sqliteCountsBefore = {
      kindlingPipelineRuns: db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs").get() as { count: number },
      schedulerRuns: db.query("SELECT COUNT(*) AS count FROM scheduler_runs").get() as { count: number },
      workQueue: db.query("SELECT COUNT(*) AS count FROM work_queue").get() as { count: number },
    };

    expect(startKindlingBackgroundTasks()).toEqual({
      enabled: false,
      reason: "tower-db-runtime",
      timers: 0,
    });
    expect(await runAutomatedProspectingLoop()).toBeNull();

    expect(db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs").get()).toEqual(sqliteCountsBefore.kindlingPipelineRuns);
    expect(db.query("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual(sqliteCountsBefore.schedulerRuns);
    expect(db.query("SELECT COUNT(*) AS count FROM work_queue").get()).toEqual(sqliteCountsBefore.workQueue);
  });
});
