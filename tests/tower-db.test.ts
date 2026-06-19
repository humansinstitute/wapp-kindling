import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, test } from "bun:test";
import { getPublicKey, nip19, verifyEvent, type Event } from "nostr-tools";
import { initializeTowerDbRuntime, loadTowerMigrations, TowerDbClient, type TowerMigration } from "../src/tower-db.ts";

const secretKey = new Uint8Array(32).fill(9);
const appNpub = nip19.npubEncode(getPublicKey(secretKey));
const appNsec = nip19.nsecEncode(secretKey);
const workspaceOwnerNpub = "npub1workspaceowner000000000000000000000000000000000000000000q5sc7p";

function decodeAuthorization(value: string | null): Event {
  expect(value?.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(String(value).slice("Nostr ".length))) as Event;
}

describe("TowerDbClient", () => {
  test("signs provision requests with app NIP-98 and payload hash", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new TowerDbClient({
      towerUrl: "https://tower.test/",
      workspaceOwnerNpub,
      appNpub,
      appNsec,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }) as typeof fetch,
    });

    await client.provision("kindling");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://tower.test/api/v4/workspaces/${encodeURIComponent(workspaceOwnerNpub)}/apps/${encodeURIComponent(appNpub)}/db/provision`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ app_slug: "kindling" }));
    const event = decodeAuthorization(new Headers(calls[0]!.init.headers).get("authorization"));
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(event.kind).toBe(27235);
    expect(event.tags).toContainEqual(["u", calls[0]!.url]);
    expect(event.tags).toContainEqual(["method", "POST"]);
    expect(event.tags).toContainEqual(["payload", bytesToHex(sha256(new TextEncoder().encode(String(calls[0]!.init.body))))]);
  });

  test("sends migrations to Tower without exposing APP_NSEC in request data", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = new TowerDbClient({
      towerUrl: "https://tower.test",
      workspaceOwnerNpub,
      appNpub,
      appNsec,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ applied: [] }), { status: 200 });
      }) as typeof fetch,
    });
    const migrations: TowerMigration[] = [{ version: "001_test", checksum: "sha256:" + "a".repeat(64), sql: "CREATE TABLE IF NOT EXISTS test_rows (id text PRIMARY KEY);" }];

    await client.runMigrations(migrations);

    expect(requests[0]!.url.endsWith("/db/migrations")).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toEqual({ migrations });
    expect(requests[0]!.body.includes(appNsec)).toBe(false);
  });

  test("loads ordered Tower migration files with sha256 checksums", () => {
    const migrations = loadTowerMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.version)).toEqual([...migrations.map((migration) => migration.version)].sort());
    for (const migration of migrations) {
      expect(migration.checksum).toBe(`sha256:${bytesToHex(sha256(new TextEncoder().encode(migration.sql)))}`);
      expect(migration.sql).not.toMatch(/\b(CREATE\s+TRIGGER|CREATE\s+(OR\s+REPLACE\s+)?FUNCTION|AS\s+SELECT|CREATE\s+TABLE\s+.+LIKE)\b/i);
    }
  });

  test("Tower startup provisions before applying migrations", async () => {
    const calls: string[] = [];
    const client = {
      async provision(appSlug: string) {
        calls.push(`provision:${appSlug}`);
      },
      async runMigrations(migrations: TowerMigration[]) {
        calls.push(`migrate:${migrations.length}`);
      },
    };

    const result = await initializeTowerDbRuntime(client as unknown as TowerDbClient, true);

    expect(result.mode).toBe("tower");
    expect(calls[0]).toBe("provision:kindling");
    expect(calls[1]?.startsWith("migrate:")).toBe(true);
  });

  test("SQLite startup does not require Tower key material", async () => {
    const result = await initializeTowerDbRuntime(undefined, false);
    expect(result).toEqual({ mode: "sqlite" });
  });
});
