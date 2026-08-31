import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { describe, expect, test } from "bun:test";

process.env.KINDLING_COMPANY_SOURCE ??= "local";

const { initializeTowerDbRuntime, loadTowerMigrations, TowerDbClient } = await import("../src/tower-db.ts");
type TowerMigration = import("../src/tower-db.ts").TowerMigration;

const brokerUrl = "http://127.0.0.1:3600/api/internal/wapps/tower-db";
const capability = "synthetic-installation-capability";

describe("TowerDbClient", () => {
  test("forwards provision through the installation-scoped loopback broker", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new TowerDbClient({
      brokerUrl,
      capability,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init || {} });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }) as typeof fetch,
    });

    await client.provision("kindling");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(brokerUrl);
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${capability}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      method: "POST",
      path: "/provision",
      body: { app_slug: "kindling" },
    });
  });

  test("sends migrations through the broker without exposing its capability in request data", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = new TowerDbClient({
      brokerUrl,
      capability,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ applied: [] }), { status: 200 });
      }) as typeof fetch,
    });
    const migrations: TowerMigration[] = [{ version: "001_test", checksum: "sha256:" + "a".repeat(64), sql: "CREATE TABLE IF NOT EXISTS test_rows (id text PRIMARY KEY);" }];

    await client.runMigrations(migrations);

    expect(requests[0]!.url).toBe(brokerUrl);
    expect(JSON.parse(requests[0]!.body)).toEqual({ method: "POST", path: "/migrations", body: { migrations } });
    expect(requests[0]!.body.includes(capability)).toBe(false);
  });

  test("rejects non-loopback brokers and missing capabilities", () => {
    expect(() => new TowerDbClient({ brokerUrl: "https://tower.test/db", capability })).toThrow("loopback HTTP");
    expect(() => new TowerDbClient({ brokerUrl, capability: "" })).toThrow("WAPP_TOWER_DB_CAPABILITY");
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
