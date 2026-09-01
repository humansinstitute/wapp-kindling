import { describe, expect, test } from "bun:test";
import { handleBackendApi, normalizeBackendCompany, normalizeCompanyPage } from "../src/backend-api.ts";
import { handleSaasRequest } from "../src/saas-server.ts";

describe("Kindling SaaS backend adapter", () => {
  test("production health reports configuration and reachability without replica state", async () => {
    const response = await handleSaasRequest(new Request("https://frontend.test/api/health"), async () => Response.json({ ok: true }));
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, ready: true, companySource: "kindling-be", serverPersistenceRequired: false, api: { reachable: true, status: 200 } });
    expect(payload.canonicalApi).toBeUndefined();
    expect(payload.syncCursor).toBeUndefined();
  });

  test("maps the browser login contract to a secure backend session", async () => {
    const paths: string[] = [];
    const session = await handleBackendApi(
      new Request("https://frontend.test/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: { id: "signed" } }) }),
      new URL("https://frontend.test/api/auth/verify"),
      async (input) => {
        paths.push(new URL(String(input)).pathname);
        return Response.json({ user: { id: "user-a" } }, { headers: { "set-cookie": "kindling_session=opaque; HttpOnly; Secure; SameSite=Lax" } });
      },
    );
    expect(paths).toEqual(["/api/v1/auth/session"]);
    expect(session?.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("normalizes documented workspace company pages with paging and version metadata", () => {
    const url = new URL("https://frontend.test/api/kindling/companies?limit=25&offset=50&sort=name");
    const page = normalizeCompanyPage({
      companies: [{ id: "c-1", display_name: "Acme", website_url: "https://acme.test", updated_at: "2026-09-01T00:00:00Z", row_version: 7 }],
      total: 6832,
      next_cursor: "next-1",
      schema_version: "3",
    }, url, '"page-7"');
    expect(page.total).toBe(6832);
    expect(page.offset).toBe(50);
    expect(page.nextCursor).toBe("next-1");
    expect(page.etag).toBe('"page-7"');
    expect(page.schemaVersion).toBe("3");
    expect(page.companies[0]).toMatchObject({ id: "c-1", name: "Acme", website: "https://acme.test", rowVersion: 7 });
  });

  test("normalizes current targets compatibility responses", () => {
    const company = normalizeBackendCompany({
      id: "target-1",
      displayName: "Target One",
      location: { city: "Perth", state: "WA" },
      industry: { level2: { label: "Engineering" } },
      websiteUrl: "https://target.test",
      enrichmentStatus: "complete",
      changeSeq: 9,
    });
    expect(company).toMatchObject({ id: "target-1", name: "Target One", location: "Perth, WA", industry: "Engineering", website: "https://target.test", enrichmentStatus: "complete" });
  });

  test("first company render is a live backend request with no sync or cursor prerequisite", async () => {
    const calls: URL[] = [];
    const response = await handleBackendApi(
      new Request("https://frontend.test/api/kindling/companies?limit=2", { headers: { cookie: "kindling_session=secure", "x-kindling-workspace-id": "workspace-a" } }),
      new URL("https://frontend.test/api/kindling/companies?limit=2"),
      async (input, init) => {
        calls.push(new URL(String(input)));
        expect(new Headers(init?.headers).get("cookie")).toBe("kindling_session=secure");
        return Response.json({ companies: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], total: 2 });
      },
    );
    expect(response?.status).toBe(200);
    expect(calls[0]?.pathname).toBe("/api/v1/workspaces/workspace-a/companies");
    expect(calls[0]?.searchParams.get("limit")).toBe("2");
    expect(await response?.json()).toMatchObject({ total: 2, returned: 2 });
  });

  test("the existing On Deck landing reads authoritative companies", async () => {
    const response = await handleBackendApi(
      new Request("https://frontend.test/api/kindling/top-targets?band=high&limit=40", { headers: { "x-kindling-workspace-id": "workspace-a" } }),
      new URL("https://frontend.test/api/kindling/top-targets?band=high&limit=40"),
      async () => Response.json({ companies: [{ id: "company-a", name: "Company A" }], total: 1 }),
    );
    expect(await response?.json()).toMatchObject({ targets: [{ companyId: "company-a", band: "high", company: { name: "Company A" } }], total: 1, companySource: "kindling-be" });
  });

  test("falls back to /api/v1/targets compatibility on an unavailable workspace route", async () => {
    const paths: string[] = [];
    const response = await handleBackendApi(
      new Request("https://frontend.test/api/kindling/companies/c-9", { headers: { "x-kindling-workspace-id": "workspace-a" } }),
      new URL("https://frontend.test/api/kindling/companies/c-9"),
      async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        return path.includes("/workspaces/") ? Response.json({ error: "not implemented" }, { status: 404 }) : Response.json({ id: "c-9", displayName: "Compatibility Co" });
      },
    );
    expect(paths).toEqual(["/api/v1/workspaces/workspace-a/companies/c-9", "/api/v1/targets/c-9"]);
    expect(await response?.json()).toMatchObject({ company: { id: "c-9", name: "Compatibility Co" }, companySource: "kindling-be" });
  });

  test("writes are forwarded and never materialised by the frontend", async () => {
    let received = "";
    const response = await handleBackendApi(
      new Request("https://frontend.test/api/kindling/companies/c-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataRing: "active" }) }),
      new URL("https://frontend.test/api/kindling/companies/c-1"),
      async (_input, init) => { received = await new Response(init?.body).text(); return Response.json({ ok: true }); },
    );
    expect(response?.ok).toBeTrue();
    expect(JSON.parse(received)).toEqual({ dataRing: "active" });
  });
});
