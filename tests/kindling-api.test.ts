import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

process.env.CHAT_WAPP_DB_PATH = join(mkdtempSync(join(tmpdir(), "kindling-api-")), "test.sqlite");
process.env.CHAT_WAPP_ALLOW_MOCK = "1";
process.env.WINGMAN_URL = "http://127.0.0.1:9";

const { db, ensureDefaultPipelineRoles } = await import("../src/db.ts");
const { handleApi } = await import("../src/server.ts");

const secretKey = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(secretKey);
const token = "test-token";

function resetData() {
  for (const table of [
    "outreach_drafts",
    "target_rankings",
    "enrichment_requests",
    "scan_strategy_attempts",
    "discovery_jobs",
    "activities",
    "sources",
    "companies",
    "market_profile_versions",
    "market_profiles",
    "kindling_pipeline_runs",
    "sessions",
    "users",
  ]) {
    db.query(`DELETE FROM ${table}`).run();
  }
  db.query("INSERT INTO users(pubkey, npub, created_at, last_seen_at) VALUES (?1, 'npub-test', 1, 1)").run(pubkey);
  db.query("INSERT INTO sessions(token, pubkey, expires_at, created_at) VALUES (?1, ?2, ?3, 1)")
    .run(token, pubkey, Date.now() + 60_000);
}

async function api(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
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

function nip98Headers(path: string, method = "GET", body?: unknown) {
  const tags = [
    ["u", `http://kindling.test${path}`],
    ["method", method],
  ];
  if (["POST", "PUT", "PATCH"].includes(method)) {
    tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(body ?? {}))))]);
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  }, secretKey);
  return { authorization: `Nostr ${btoa(JSON.stringify(event))}` };
}

function seedKindlingRun(roleKey: string, requestId: string, webhookToken: string) {
  db.query(`
    INSERT INTO kindling_pipeline_runs(
      id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, 'running', ?4, '{}', 1, 1)
  `).run(`run-${requestId}`, roleKey, requestId, webhookToken);
}

beforeEach(() => {
  resetData();
});

describe("Kindling API contracts", () => {
  test("seeds and repairs documented working role slugs", () => {
    const roles = db.query("SELECT role_key, active_pipeline_slug, expected_output_shape FROM pipeline_roles WHERE role_key IN ('develop_service_offering', 'scan_target_list', 'enrich_company', 'enrich_industry_segment', 'draft_outreach') ORDER BY role_key")
      .all() as Array<Record<string, string>>;
    expect(roles.map((role) => role.active_pipeline_slug)).toEqual([
      "kindling-develop-service-offering",
      "kindling-draft-outreach",
      "kindling-enrich-company",
      "kindling-enrich-industry-segment",
      "kindling-scan-target-list",
    ]);

    db.query("UPDATE pipeline_roles SET active_pipeline_slug = 'kindling-stub-scan-target-list', pipeline_label = 'kindling-stub-scan-target-list' WHERE role_key = 'scan_target_list'").run();
    ensureDefaultPipelineRoles(123);
    const repaired = db.query("SELECT active_pipeline_slug, pipeline_label, expected_output_shape FROM pipeline_roles WHERE role_key = 'scan_target_list'").get() as Record<string, string>;
    expect(repaired).toMatchObject({
      active_pipeline_slug: "kindling-scan-target-list",
      pipeline_label: "kindling-scan-target-list",
      expected_output_shape: "target_scan_result",
    });
  });

  test("builds documented trigger payload fields and webhook auth header", async () => {
    const { res, payload } = await api("/api/kindling/target-scans", {
      method: "POST",
      body: { industry: "HVAC", location: "Perth" },
    });
    expect(res.status).toBe(201);
    expect(payload.triggerRequest.body.input).toMatchObject({
      source: "kindling-wapp",
      pipelineRole: "scan_target_list",
      industry: "HVAC",
      location: "Perth",
      targetCount: 25,
      scanMode: "interactive",
      localContext: {
        targetCount: 25,
        scanMode: "interactive",
        priorScanStrategies: [],
        writeApi: {
          authHeader: "x-kindling-pipeline-token",
        },
      },
      webhook: {
        authHeader: "x-kindling-pipeline-token",
      },
    });
    expect(payload.triggerRequest.body.input.roleKey).toBe("scan_target_list");
  });

  test("preserves exact round target counts", async () => {
    const { res, payload } = await api("/api/kindling/target-scans", {
      method: "POST",
      body: { industry: "Legal Services", location: "Perth", targetCount: 1000 },
    });
    expect(res.status).toBe(201);
    expect(payload.triggerRequest.body.input.targetCount).toBe(1000);
    expect(payload.triggerRequest.body.input.scanMode).toBe("bulk");
    const job = db.query("SELECT target_count, scan_mode FROM discovery_jobs WHERE id = ?1").get(payload.jobId) as Record<string, unknown>;
    expect(job.target_count).toBe(1000);
    expect(job.scan_mode).toBe("bulk");
  });

  test("lists unprocessed industries and queues an industry enrichment batch", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('tax-1', 'Tax One', 'Perth', 'Tax accountants', '', 'seed', 'unknown', 'not_started', 0.5, '{}', ?1, ?1),
        ('tax-2', 'Tax Two', 'Perth', 'Tax accountants', '', 'seed', 'unknown', 'failed', 0.5, '{}', ?1, ?1),
        ('tax-done', 'Tax Done', 'Perth', 'Tax accountants', '', 'enriched', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('legal-1', 'Legal One', 'Perth', 'Legal Services', '', 'seed', 'unknown', 'not_started', 0.5, '{}', ?1, ?1)
    `).run(now);

    const list = await api("/api/kindling/enrichment-industries");
    expect(list.payload.industries[0]).toMatchObject({
      industry: "Tax accountants",
      unprocessedCount: 2,
      notStartedCount: 1,
      failedCount: 1,
    });
    expect(list.payload.batchLimit).toBe(21);

    const queued = await api("/api/kindling/enrichment-industries/Tax%20accountants/enrich", {
      method: "POST",
      body: { limit: 21 },
    });
    expect(queued.res.status).toBe(201);
    expect(queued.payload.batchSize).toBe(2);
    expect(queued.payload.triggerRequest.body.input).toMatchObject({
      pipelineRole: "enrich_industry_segment",
      industry: "Tax accountants",
      batchSize: 2,
    });
    expect(queued.payload.triggerRequest.body.input.localContext).toMatchObject({
      batchSize: 2,
      batchLimit: 21,
      writeApi: {
        authHeader: "x-kindling-pipeline-token",
      },
    });
    expect(queued.payload.triggerRequest.body.input.localContext.companies.map((company: { id: string }) => company.id)).toEqual(["tax-1", "tax-2"]);
    const statuses = db.query("SELECT id, enrichment_status FROM companies WHERE id IN ('tax-1', 'tax-2', 'tax-done') ORDER BY id").all() as Array<Record<string, string>>;
    expect(statuses).toEqual([
      { id: "tax-1", enrichment_status: "queued" },
      { id: "tax-2", enrichment_status: "queued" },
      { id: "tax-done", enrichment_status: "complete" },
    ]);
  });

  test("returns non-502 JSON when Autopilot pipeline discovery is unreachable", async () => {
    const { res, payload } = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
        autopilotAuthorization: "Nostr test",
      },
    });
    expect(res.status).toBe(424);
    expect(payload.error).toContain("Autopilot pipeline list failed");
    expect(payload.url).toBe("http://127.0.0.1:9/api/pipelines/definitions");
  });

  test("maps public Rick Autopilot URL to the local server URL", async () => {
    const { res, payload } = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: {
        autopilotUrl: "https://rick.runwingman.com",
      },
    });
    expect(res.status).toBe(202);
    expect(payload.triggerRequest.url).toBe("http://127.0.0.1:9/api/pipelines/definitions");
  });

  test("preserves configured Autopilot URL in settings after save", async () => {
    const saved = await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "https://rick.runwingman.com",
        defaultPipeline: "chat-wapp-agent-response",
      },
    });
    expect(saved.res.status).toBe(200);
    expect(saved.payload.settings.autopilotUrl).toBe("https://rick.runwingman.com");

    const loaded = await api("/api/settings");
    expect(loaded.payload.settings.autopilotUrl).toBe("https://rick.runwingman.com");
  });

  test("accepts documented service offering webhook callback", async () => {
    seedKindlingRun("develop_service_offering", "profile-request", "profile-token");
    const { res } = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "profile-token" },
      body: {
        requestId: "profile-request",
        role: "develop_service_offering",
        status: "ok",
        response: "Profile ready",
        result: {
          outputKind: "market_profile_update",
          profileVersionPatch: { summary: "Summary", rationale: "Because", offer: "Offer" },
          nextQuestions: ["Next?"],
        },
      },
    });
    expect(res.status).toBe(200);
    const version = db.query("SELECT summary, rationale, structured_json FROM market_profile_versions LIMIT 1").get() as Record<string, string>;
    expect(version.summary).toBe("Summary");
    expect(version.rationale).toBe("Because");
    expect(JSON.parse(version.structured_json).offer).toBe("Offer");
  });

  test("accepts documented scan webhook callback", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('scan-request', 'HVAC', 'Perth', 'queued', 1, 1)").run();
    seedKindlingRun("scan_target_list", "scan-request", "scan-token");
    const { res } = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "scan-token" },
      body: {
        requestId: "scan-request",
        role: "scan_target_list",
        status: "ok",
        response: "Scan ready",
        result: {
          outputKind: "target_scan_result",
          industry: "HVAC",
          location: "Perth",
          companies: [{ name: "North HVAC", website: "https://north.example", confidence: 0.8 }],
          searchSlices: [{ industry: "HVAC", location: "Perth", strategyType: "google", query: "HVAC Perth", status: "searched", resultCount: 1, notes: "page 1" }],
        },
      },
    });
    expect(res.status).toBe(200);
    const company = db.query("SELECT name, industry, location, website FROM companies LIMIT 1").get() as Record<string, string>;
    expect(company).toMatchObject({ name: "North HVAC", industry: "HVAC", location: "Perth", website: "https://north.example" });
    const strategy = db.query("SELECT strategy_type, query, result_count, notes FROM scan_strategy_attempts LIMIT 1").get() as Record<string, string | number>;
    expect(strategy).toMatchObject({ strategy_type: "google", query: "HVAC Perth", result_count: 1, notes: "page 1" });
    const detail = await api("/api/kindling/discovery-jobs/scan-request");
    expect(detail.res.status).toBe(200);
    expect(detail.payload.input).toMatchObject({ industry: "HVAC", location: "Perth", targetCount: 25 });
    expect(detail.payload.strategies[0]).toMatchObject({ strategyType: "google", query: "HVAC Perth", resultCount: 1 });
    expect(detail.payload.outputs.companyCount).toBe(1);
    expect(detail.payload.outputs.netNewCompanies).toBe(1);
    expect(detail.payload.outputs.remainingTarget).toBe(24);
    expect(detail.payload.searchedStrategies).toHaveLength(1);
  });

  test("exposes scan context over NIP-98 for strategy planning", async () => {
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('company-context', 'Context Accounting', 'Perth', 'Accounting', 'https://context.example', 'seed', 'unknown', 'not_started', 0.7, '{}', 1, 1)
    `).run();
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('context-scan', 'Accounting', 'Perth', 'complete', 1, 1)").run();
    db.query(`
      INSERT INTO scan_strategy_attempts(id, discovery_job_id, industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at)
      VALUES ('strategy-context', 'context-scan', 'Accounting', 'Perth', 'google', 'accountants Perth page 1', 'searched', 1, 'first page', '{}', 1)
    `).run();
    const path = "/api/nip98/kindling/scan-context?industry=Accounting&location=Perth&targetCount=256";
    const { res, payload } = await api(path, { headers: nip98Headers(path) });
    expect(res.status).toBe(200);
    expect(payload.scanContext).toMatchObject({
      industry: "Accounting",
      location: "Perth",
      targetCount: 256,
      scanMode: "batch",
      currentCounts: {
        matchingCompanies: 1,
        withWebsite: 1,
      },
    });
    expect(payload.scanContext.priorScanStrategies[0]).toMatchObject({
      strategyType: "google",
      query: "accountants Perth page 1",
      resultCount: 1,
    });
  });

  test("accepts scan write callback once before completion webhook", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('scan-write-request', 'Accounting', 'Subiaco', 'queued', 1, 1)").run();
    seedKindlingRun("scan_target_list", "scan-write-request", "scan-write-token");
    const write = await api("/api/kindling/pipeline-write/target-scan", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "scan-write-token" },
      body: {
        requestId: "scan-write-request",
        result: {
          outputKind: "target_scan_result",
          industry: "Accounting",
          location: "Subiaco",
          companies: [{ name: "Write Once Co", website: "https://write.example", confidence: 0.8 }],
          companiesArtifact: { path: "/tmp/companies.json", count: 1 },
        },
      },
    });
    expect(write.res.status).toBe(200);
    const webhook = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "scan-write-token" },
      body: {
        requestId: "scan-write-request",
        role: "scan_target_list",
        status: "ok",
        result: {
          outputKind: "target_scan_result",
          industry: "Accounting",
          location: "Subiaco",
          companies: [{ name: "Write Once Co", website: "https://write.example", confidence: 0.8 }],
        },
      },
    });
    expect(webhook.res.status).toBe(200);
    const count = db.query("SELECT COUNT(*) AS count FROM companies WHERE name = 'Write Once Co'").get() as { count: number };
    expect(count.count).toBe(1);
  });

  test("keeps planned scan strategies separate from attempted strategy history", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('scan-planned-request', 'Accounting', 'Perth', 'queued', 1, 1)").run();
    seedKindlingRun("scan_target_list", "scan-planned-request", "scan-planned-token");
    const webhook = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "scan-planned-token" },
      body: {
        requestId: "scan-planned-request",
        role: "scan_target_list",
        status: "partial",
        response: "Scan partial",
        result: {
          outputKind: "target_scan_result",
          industry: "Accounting",
          location: "Perth",
          companies: [{ name: "Planned Split Co", website: "https://planned.example", confidence: 0.8 }],
          searchSlices: [
            { industry: "Accounting", location: "Perth", strategyType: "directory", query: "accountants Perth page 2", status: "searched", resultCount: 1 },
            { industry: "Accounting", location: "Perth", strategyType: "association", query: "CPA Perth next", status: "planned", resultCount: 0 },
          ],
          plannedNextStrategies: [
            { industry: "Accounting", location: "Perth", strategyType: "registry", query: "TPB Perth suburb pass", status: "planned", resultCount: 0 },
          ],
        },
      },
    });
    expect(webhook.res.status).toBe(200);
    const storedStrategies = db.query("SELECT status, query FROM scan_strategy_attempts ORDER BY created_at ASC").all() as Record<string, string>[];
    expect(storedStrategies).toEqual([{ status: "searched", query: "accountants Perth page 2" }]);
    const detail = await api("/api/kindling/discovery-jobs/scan-planned-request");
    expect(detail.payload.strategies).toHaveLength(1);
    expect(detail.payload.plannedStrategies).toHaveLength(1);
    expect(detail.payload.plannedStrategies[0]).toMatchObject({ strategyType: "registry", query: "TPB Perth suburb pass", status: "planned" });
  });

  test("accepts repeatable NIP-98 scan result writes without direct DB access", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('nip98-scan-write', 'Accounting', 'Perth', 'queued', 1, 1)").run();
    const path = "/api/nip98/kindling/scan-results";
    const body = {
      requestId: "nip98-scan-write",
      result: {
        outputKind: "target_scan_result",
        industry: "Accounting",
        location: "Perth",
        companies: [{ name: "Loop Accounting", website: "https://loop.example", confidence: 0.8 }],
        searchSlices: [{ industry: "Accounting", location: "Perth", strategyType: "directory", query: "Xero advisors Perth", status: "searched", resultCount: 1 }],
      },
    };
    const first = await api(path, { method: "POST", body, headers: nip98Headers(path, "POST", body) });
    const second = await api(path, { method: "POST", body, headers: nip98Headers(path, "POST", body) });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    const companyCount = db.query("SELECT COUNT(*) AS count FROM companies WHERE name = 'Loop Accounting'").get() as { count: number };
    const strategyCount = db.query("SELECT COUNT(*) AS count FROM scan_strategy_attempts WHERE query = 'Xero advisors Perth'").get() as { count: number };
    expect(companyCount.count).toBe(1);
    expect(strategyCount.count).toBe(1);
  });

  test("reconciles errored Autopilot scan runs as partial failures when data was written", async () => {
    db.query(`
      INSERT INTO discovery_jobs(id, industry, location, target_count, status, company_count, created_at, updated_at)
      VALUES ('scan-error', 'HVAC', 'Perth', 100, 'running', 3, 1, 1)
    `).run();
    db.query(`
      INSERT INTO companies(id, name, location, industry, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('c1', 'A HVAC', 'Perth', 'HVAC', 'seed', 'unknown', 'not_started', 0, '{}', 1, 1),
        ('c2', 'B HVAC', 'Perth', 'HVAC', 'seed', 'unknown', 'not_started', 0, '{}', 1, 1),
        ('c3', 'C HVAC', 'Perth', 'HVAC', 'seed', 'unknown', 'not_started', 0, '{}', 1, 1)
    `).run();
    seedKindlingRun("scan_target_list", "scan-error", "scan-token");
    db.query("UPDATE kindling_pipeline_runs SET autopilot_run_id = 'remote-error-run' WHERE id = 'run-scan-error'").run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/pipelines/runs/remote-error-run");
      return Response.json({ run: { id: "remote-error-run", status: "error", error: "Request Entity Too Large" } });
    }) as typeof fetch;
    try {
      const { res, payload } = await api("/api/kindling/summary");
      expect(res.status).toBe(200);
      const run = payload.recentRuns.find((entry: Record<string, unknown>) => entry.localRequestId === "scan-error");
      const job = payload.discoveryJobs.find((entry: Record<string, unknown>) => entry.id === "scan-error");
      expect(run.status).toBe("partial_failed");
      expect(run.error).toBe("Request Entity Too Large");
      expect(job.status).toBe("partial_failed");
      expect(job.summary).toContain("Request Entity Too Large");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("accepts documented enrichment webhook callback", async () => {
    db.query("INSERT INTO companies(id, name, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at) VALUES ('company-1', 'North HVAC', 'manual', 'unknown', 'queued', 0, '{}', 1, 1)").run();
    db.query("INSERT INTO enrichment_requests(id, company_id, status, request_kind, created_at, updated_at) VALUES ('enrich-request', 'company-1', 'queued', 'standard', 1, 1)").run();
    seedKindlingRun("enrich_company", "enrich-request", "enrich-token");
    const { res } = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "enrich-token" },
      body: {
        requestId: "enrich-request",
        role: "enrich_company",
        status: "ok",
        response: "Enriched",
        result: {
          outputKind: "company_enrichment",
          companyId: "company-1",
          companyName: "North HVAC",
          fieldsUpdated: ["website"],
          sources: [{ url: "https://north.example", summary: "Website", confidence: 0.9 }],
          confidence: 0.9,
          gaps: ["No owner found"],
        },
      },
    });
    expect(res.status).toBe(200);
    const company = db.query("SELECT enrichment_status, confidence, profile_json FROM companies WHERE id = 'company-1'").get() as Record<string, string | number>;
    expect(company.enrichment_status).toBe("complete");
    expect(Number(company.confidence)).toBe(0.9);
    expect(JSON.parse(String(company.profile_json)).fieldsUpdated).toEqual(["website"]);
  });

  test("accepts documented outreach webhook callback", async () => {
    db.query("INSERT INTO companies(id, name, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at) VALUES ('company-2', 'West Accounting', 'manual', 'unique', 'complete', 0.7, '{}', 1, 1)").run();
    seedKindlingRun("draft_outreach", "outreach-request", "outreach-token");
    const { res } = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "outreach-token" },
      body: {
        requestId: "outreach-request",
        role: "draft_outreach",
        status: "ok",
        response: "Drafted",
        result: {
          outputKind: "outreach_draft",
          companyId: "company-2",
          companyName: "West Accounting",
          subject: "Quick idea",
          body: "Worth comparing notes?",
          rationale: "Good fit",
          confidence: 0.8,
        },
      },
    });
    expect(res.status).toBe(200);
    const draft = db.query("SELECT pitch_text FROM outreach_drafts WHERE company_id = 'company-2'").get() as Record<string, string>;
    expect(draft.pitch_text).toContain("Quick idea");
    expect(draft.pitch_text).toContain("Worth comparing notes?");
  });

  test("stores outreach variants when callback supplies three examples", async () => {
    db.query("INSERT INTO companies(id, name, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at) VALUES ('company-3', 'Variant Accounting', 'manual', 'unique', 'complete', 0.7, '{}', 1, 1)").run();
    seedKindlingRun("draft_outreach", "outreach-variants-request", "outreach-variants-token");
    const { res } = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "outreach-variants-token" },
      body: {
        requestId: "outreach-variants-request",
        role: "draft_outreach",
        status: "ok",
        response: "Drafted",
        result: {
          outputKind: "outreach_draft",
          companyId: "company-3",
          variants: [
            { label: "Direct", subject: "Direct subject", body: "Direct body" },
            { label: "Consultative", subject: "Consultative subject", body: "Consultative body" },
            { label: "Local", subject: "Local subject", body: "Local body" },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    const draft = db.query("SELECT pitch_text FROM outreach_drafts WHERE company_id = 'company-3'").get() as Record<string, string>;
    expect(draft.pitch_text).toContain("## Direct");
    expect(draft.pitch_text).toContain("Consultative body");
    expect(draft.pitch_text).toContain("Local subject");
  });

  test("creates a manual company with only a name", async () => {
    const { res, payload } = await api("/api/kindling/companies", {
      method: "POST",
      body: { name: "Name Only Co" },
    });
    expect(res.status).toBe(201);
    expect(payload.company).toMatchObject({
      name: "Name Only Co",
      dataRing: "manual",
      duplicateStatus: "unknown",
      enrichmentStatus: "not_started",
    });
  });

  test("filters companies by first-demo filter query params", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('match', 'Match Co', 'Perth', 'HVAC', 'https://match.example', 'manual', 'unique', 'complete', 0.8, '{}', ?1, ?1),
        ('miss', 'Miss Co', 'Perth', 'HVAC', '', 'seed', 'unknown', 'not_started', 0.2, '{}', ?1, ?1)
    `).run(now);
    const { payload } = await api("/api/kindling/companies?industry=HVAC&location=Perth&dataRing=manual&duplicateStatus=unique&hasWebsite=yes&enrichmentStatus=complete");
    expect(payload.companies.map((company: { id: string }) => company.id)).toEqual(["match"]);
  });

  test("reports total company counts separately from the 500 row list cap", async () => {
    const now = Date.now();
    const insert = db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, 'Perth', 'Accounting', '', 'seed', 'unknown', ?3, 0.4, '{}', ?4, ?4)
    `);
    for (let index = 0; index < 505; index += 1) {
      insert.run(`company-${index}`, `Company ${index}`, index < 2 ? "complete" : "not_started", now + index);
    }

    const list = await api("/api/kindling/companies");
    expect(list.payload.companies).toHaveLength(500);
    expect(list.payload.returned).toBe(500);
    expect(list.payload.total).toBe(505);
    expect(list.payload.limit).toBe(500);

    const summary = await api("/api/kindling/summary");
    expect(summary.payload.companies).toHaveLength(500);
    expect(summary.payload.counts.companies).toBe(505);
    expect(summary.payload.counts.outreachReady).toBe(2);
    expect(summary.payload.companyList).toMatchObject({
      returned: 500,
      total: 505,
      limit: 500,
    });
  });

  test("queues an industry enrichment batch of up to 21 unprocessed companies", async () => {
    const now = Date.now();
    for (let index = 0; index < 23; index += 1) {
      db.query(`
        INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
        VALUES (?1, ?2, 'Perth', 'Tax accountants', '', 'seed', 'unknown', 'not_started', 0.4, '{}', ?3, ?3)
      `).run(`tax-${index}`, `Tax Co ${index}`, now + index);
    }
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('tax-done', 'Done Tax', 'Perth', 'Tax accountants', '', 'enriched', 'unknown', 'complete', 0.8, '{}', ?1, ?1)
    `).run(now);

    const industries = await api("/api/kindling/enrichment-industries");
    expect(industries.payload.industries[0]).toMatchObject({
      industry: "Tax accountants",
      unprocessedCount: 23,
    });

    const queued = await api("/api/kindling/enrichment-industries/Tax%20accountants/enrich", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    expect(queued.res.status).toBe(202);
    expect(queued.payload.batchSize).toBe(21);
    expect(queued.payload.triggerRequest.body.input).toMatchObject({
      pipelineRole: "enrich_industry_segment",
      industry: "Tax accountants",
      batchSize: 21,
      localContext: {
        industry: "Tax accountants",
        batchSize: 21,
      },
    });
    expect(queued.payload.triggerRequest.body.input.localContext.companies).toHaveLength(21);
    const statusRows = db.query(`
      SELECT enrichment_status, COUNT(*) AS count
      FROM companies
      WHERE industry = 'Tax accountants'
      GROUP BY enrichment_status
      ORDER BY enrichment_status
    `).all() as Array<Record<string, unknown>>;
    expect(statusRows).toEqual([
      { enrichment_status: "complete", count: 1 },
      { enrichment_status: "not_started", count: 2 },
      { enrichment_status: "queued", count: 21 },
    ]);
  });

  test("accepts token-scoped industry enrichment writes per company", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('tax-write', 'Tax Write Co', 'Perth', 'Tax accountants', '', 'seed', 'unknown', 'not_started', 0.4, '{}', ?1, ?1)
    `).run(now);
    const queued = await api("/api/kindling/enrichment-industries/Tax%20accountants/enrich", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    const run = db.query("SELECT webhook_token FROM kindling_pipeline_runs WHERE id = ?1").get(queued.payload.runId) as Record<string, string>;
    const body = {
      batchRequestId: queued.payload.batchId,
      companyId: "tax-write",
      response: "Enriched Tax Write Co",
      company: {
        id: "tax-write",
        website: "https://tax-write.example",
        confidence: 0.82,
        profile: { summary: "Tax advisory practice" },
        sources: [{ url: "https://tax-write.example", summary: "Official site", confidence: 0.9 }],
      },
    };
    const written = await api("/api/kindling/pipeline-write/enrichment-company", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": run.webhook_token },
      body,
    });
    expect(written.res.status).toBe(200);
    const company = db.query("SELECT website, data_ring, enrichment_status FROM companies WHERE id = 'tax-write'").get() as Record<string, string>;
    expect(company).toMatchObject({
      website: "https://tax-write.example",
      data_ring: "enriched",
      enrichment_status: "complete",
    });
  });
});
