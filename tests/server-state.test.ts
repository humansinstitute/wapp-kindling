import { describe, expect, test } from "bun:test";
import { KindlingServerState, MemoryQueryPersister, scopeId, serverQueryKey, type QueryScope } from "../src/server-state.ts";

const scope = (userId = "user-a", workspaceId = "workspace-a", schemaVersion = "1"): QueryScope => ({
  userId,
  organisationId: "org-a",
  workspaceId,
  backendOrigin: "https://api-a.test",
  apiVersion: "v1",
  schemaVersion,
  membershipVersion: "membership-1",
  role: "viewer",
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("bounded tenant query state", () => {
  test("cache keys isolate user, workspace, schema and normalized filters", () => {
    const a = serverQueryKey(scope(), "/api/kindling/companies?sort=name&limit=25");
    const reordered = serverQueryKey(scope(), "/api/kindling/companies?limit=25&sort=name");
    expect(a).toEqual(reordered);
    expect(a).not.toEqual(serverQueryKey(scope("user-b"), "/api/kindling/companies?sort=name&limit=25"));
    expect(a).not.toEqual(serverQueryKey(scope("user-a", "workspace-b"), "/api/kindling/companies?sort=name&limit=25"));
    expect(a).not.toEqual(serverQueryKey(scope("user-a", "workspace-a", "2"), "/api/kindling/companies?sort=name&limit=25"));
    expect(a).not.toEqual(serverQueryKey({ ...scope(), backendOrigin: "https://api-b.test" }, "/api/kindling/companies?sort=name&limit=25"));
  });

  test("a cached page renders immediately and revalidates in the background", async () => {
    const persister = new MemoryQueryPersister();
    const first = new KindlingServerState(persister);
    await first.setScope(scope());
    expect(await first.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: "cached" }], total: 1, etag: "old" }))).toMatchObject({ total: 1 });

    const restored = new KindlingServerState(persister);
    await restored.setScope(scope());
    let networkCalls = 0;
    const updated = new Promise<unknown>((resolve) => restored.subscribe((event) => resolve(event.data)));
    const immediate = await restored.query("/api/kindling/companies?limit=25", async () => {
      networkCalls += 1;
      return { companies: [{ id: "live" }], total: 1, etag: "new" };
    });
    expect(immediate).toMatchObject({ companies: [{ id: "cached" }] });
    expect(await updated).toMatchObject({ companies: [{ id: "live" }] });
    expect(networkCalls).toBe(1);
  });

  test("workspace switch makes another tenant cache unreadable", async () => {
    const persister = new MemoryQueryPersister();
    const state = new KindlingServerState(persister);
    await state.setScope(scope());
    await state.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: "tenant-a" }] }));
    await state.setScope(scope("user-a", "workspace-b"));
    const result = await state.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: "tenant-b" }] }));
    expect(result).toMatchObject({ companies: [{ id: "tenant-b" }] });
  });

  test("backend switch makes another origin cache unreadable", async () => {
    const persister = new MemoryQueryPersister();
    const state = new KindlingServerState(persister);
    await state.setScope(scope());
    await state.query("/api/kindling/outreach/results?tab=waiting", async () => ({ items: [{ companyId: "backend-a" }] }));
    await state.setScope({ ...scope(), backendOrigin: "https://api-b.test" });
    const result = await state.query("/api/kindling/outreach/results?tab=waiting", async () => ({ items: [{ companyId: "backend-b" }] }));
    expect(result).toMatchObject({ items: [{ companyId: "backend-b" }] });
  });

  test("logout, membership and schema changes purge the appropriate cache", async () => {
    for (const reason of ["logout", "membership"] as const) {
      const persister = new MemoryQueryPersister();
      const state = new KindlingServerState(persister);
      await state.setScope(scope());
      await state.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: reason }] }));
      await state.purge(reason);
      expect(persister.entries.size).toBe(0);
      expect(state.currentScope()).toBeNull();
    }
    const persister = new MemoryQueryPersister();
    const state = new KindlingServerState(persister);
    await state.setScope(scope());
    await state.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: "old-schema" }] }));
    await state.setScope(scope("user-a", "workspace-a", "2"));
    expect(persister.entries.size).toBe(0);
  });

  test("401/403 clears stale data so an authorization failure cannot leak rows", async () => {
    for (const status of [401, 403]) {
      const persister = new MemoryQueryPersister();
      const first = new KindlingServerState(persister);
      await first.setScope(scope());
      await first.query("/api/kindling/companies?limit=25", async () => ({ companies: [{ id: "stale-private-row" }] }));
      const restored = new KindlingServerState(persister);
      await restored.setScope(scope());
      await restored.query("/api/kindling/companies?limit=25", async () => { throw Object.assign(new Error("denied"), { status }); });
      await tick();
      expect(restored.currentScope()).toBeNull();
      expect(persister.entries.size).toBe(0);
      await restored.setScope(scope());
      await expect(restored.query("/api/kindling/companies?limit=25", async () => { throw Object.assign(new Error("denied"), { status }); })).rejects.toThrow("denied");
    }
  });

  test("deleting the disposable cache loses no data because the next read is live", async () => {
    const persister = new MemoryQueryPersister();
    const first = new KindlingServerState(persister);
    await first.setScope(scope());
    await first.query("/api/kindling/companies/c-1", async () => ({ company: { id: "c-1", name: "Cached" } }));
    await persister.deleteScope(scopeId(scope()));
    const fresh = new KindlingServerState(persister);
    await fresh.setScope(scope());
    const detail = await fresh.query("/api/kindling/companies/c-1", async () => ({ company: { id: "c-1", name: "Authoritative" } }));
    expect(detail).toMatchObject({ company: { name: "Authoritative" } });
  });

  test("pages larger than the bounded working set are not persisted", async () => {
    const persister = new MemoryQueryPersister();
    const state = new KindlingServerState(persister);
    await state.setScope(scope());
    await state.query("/api/kindling/companies?limit=500", async () => ({ companies: Array.from({ length: 101 }, (_, id) => ({ id: String(id) })) }));
    expect(persister.entries.size).toBe(0);
  });
});
