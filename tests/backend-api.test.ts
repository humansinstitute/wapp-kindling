import { describe, expect, test } from "bun:test";
import { canonicalBackendTarget, handleBackendApi, normalizeBackendCompany, normalizeCompanyPage } from "../src/backend-api.ts";
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

  test("passes the supervised-agent session bootstrap through unchanged", async () => {
    const paths: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      return paths.length === 1
        ? Response.json({ event: { kind: 30078, tags: [["d", "kindling-agent-session"]], content: "exact" } })
        : Response.json({ role: "owner", workspaceId: "workspace-a" }, { headers: { "set-cookie": "kindling_session=opaque; HttpOnly; Secure; SameSite=Strict" } });
    };
    const challenge = await handleBackendApi(
      new Request("https://frontend.test/api/auth/agent-challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ npub: "npub1agent" }) }),
      new URL("https://frontend.test/api/auth/agent-challenge"),
      fetcher as typeof fetch,
    );
    expect(await challenge?.json()).toMatchObject({ event: { kind: 30078, content: "exact" } });
    const session = await handleBackendApi(
      new Request("https://frontend.test/api/auth/agent-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ npub: "npub1agent", event: { kind: 30078 } }) }),
      new URL("https://frontend.test/api/auth/agent-session"),
      fetcher as typeof fetch,
    );
    expect(paths).toEqual(["/api/v1/auth/agent-challenge", "/api/v1/auth/agent-session"]);
    expect(session?.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  test("proxies challenge and initial me without requiring a frontend workspace header", async () => {
	  const paths: string[] = [];
	  const fetcher = async (input: RequestInfo | URL) => {
		  paths.push(new URL(String(input)).pathname);
		  return Response.json(paths.length === 1
			  ? { nonce: "nonce-1", content: "kindling-login:nonce-1", npub: "npub1test", workspaceId: "workspace-a" }
			  : { id: "user-a", npub: "npub1test", role: "owner", workspace: { id: "workspace-a" }, organisation: { id: "org-a" }, membership: { role: "owner" } });
	  };
	  const challenge = await handleBackendApi(new Request("https://frontend.test/api/auth/challenge", { method: "POST", body: JSON.stringify({ pubkey: "a".repeat(64) }) }), new URL("https://frontend.test/api/auth/challenge"), fetcher as typeof fetch);
	  expect(await challenge?.json()).toMatchObject({ nonce: "nonce-1", workspaceId: "workspace-a" });
	  const me = await handleBackendApi(new Request("https://frontend.test/api/me", { headers: { authorization: "Bearer opaque" } }), new URL("https://frontend.test/api/me"), fetcher as typeof fetch);
	  expect(await me?.json()).toMatchObject({ id: "user-a", role: "owner", workspace: { id: "workspace-a" }, access: { login: true, read: true, edit: true } });
	  expect(paths).toEqual(["/api/v1/auth/challenge", "/api/v1/me"]);
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

  test("normalizes PostgreSQL list and detail envelopes", async () => {
	  const list = await handleBackendApi(
		  new Request("https://frontend.test/api/kindling/companies?limit=1", { headers: { "x-kindling-workspace-id": "workspace-a" } }),
		  new URL("https://frontend.test/api/kindling/companies?limit=1"),
		  async () => Response.json({ items: [{ id: "co-a", displayName: "Alpha" }], totalCount: 6832, page: { limit: 1, nextCursor: "cursor-a", hasMore: true } }),
	  );
	  expect(await list?.json()).toMatchObject({ total: 6832, returned: 1, nextCursor: "cursor-a", companies: [{ id: "co-a", name: "Alpha" }] });
	  const detail = await handleBackendApi(
		  new Request("https://frontend.test/api/kindling/companies/co-a", { headers: { "x-kindling-workspace-id": "workspace-a" } }),
		  new URL("https://frontend.test/api/kindling/companies/co-a"),
		  async () => Response.json({ item: { id: "co-a", displayName: "Alpha" } }),
	  );
	  expect(await detail?.json()).toMatchObject({ company: { id: "co-a", name: "Alpha" } });
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

  test("proxies value proposition list, create, detail and immutable version update", async () => {
    const calls: Array<{ method: string; url: URL; body: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method || "GET", url: new URL(String(input)), body: init?.body ? await new Response(init.body).text() : "" });
      return Response.json({ items: [], total: 0 });
    };
    const headers = { "x-kindling-workspace-id": "workspace-a", "x-kindling-backend-url": "https://kindling-be.a.otherstuff.ai", "content-type": "application/json" };
    for (const [path, method, body] of [
      ["/api/kindling/value-propositions", "GET", undefined],
      ["/api/kindling/value-propositions", "POST", { name: "Advisory", specification: { summary: "Brief" } }],
      ["/api/kindling/value-propositions/vp-1", "GET", undefined],
      ["/api/kindling/value-propositions/vp-1", "PATCH", { specification: { summary: "Version two" } }],
    ] as const) {
      const request = new Request(`https://frontend.test${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect((await handleBackendApi(request, new URL(request.url), fetcher as typeof fetch))?.status).toBe(200);
    }
    expect(calls.map(({ method, url }) => [method, url.origin + url.pathname])).toEqual([
      ["GET", "https://kindling-be.a.otherstuff.ai/api/v1/workspaces/workspace-a/value-propositions"],
      ["POST", "https://kindling-be.a.otherstuff.ai/api/v1/workspaces/workspace-a/value-propositions"],
      ["GET", "https://kindling-be.a.otherstuff.ai/api/v1/workspaces/workspace-a/value-propositions/vp-1"],
      ["PATCH", "https://kindling-be.a.otherstuff.ai/api/v1/workspaces/workspace-a/value-propositions/vp-1"],
    ]);
    expect(JSON.parse(calls[3]!.body)).toEqual({ specification: { summary: "Version two" } });
  });

  test("keeps legacy service offering adapters compatible without fabricating a profile", async () => {
    const offering = { id: "vp-1", name: "Advisory", active: true, currentVersion: 1, version: { version: 1, specification: { summary: "Brief" }, approvalState: "draft" } };
    const listRequest = new Request("https://frontend.test/api/kindling/profile", { headers: { "x-kindling-workspace-id": "workspace-a" } });
    const list = await handleBackendApi(listRequest, new URL(listRequest.url), async () => Response.json({ items: [offering], total: 1 }));
    expect(await list?.json()).toMatchObject({ offerings: [offering], profile: offering, total: 1 });

    const updateRequest = new Request("https://frontend.test/api/kindling/service-offering", { method: "POST", headers: { "content-type": "application/json", "x-kindling-workspace-id": "workspace-a" }, body: JSON.stringify({ id: "vp-1", specification: { summary: "Next" } }) });
    let method = "";
    let path = "";
    await handleBackendApi(updateRequest, new URL(updateRequest.url), async (input, init) => { method = init?.method || ""; path = new URL(String(input)).pathname; return Response.json(offering); });
    expect([method, path]).toEqual(["PATCH", "/api/v1/workspaces/workspace-a/value-propositions/vp-1"]);
  });

  test("proxies empty outreach results and every existing action with paging and auth headers", async () => {
    const calls: Array<{ path: string; search: string; headers: Headers }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      calls.push({ path: target.pathname, search: target.search, headers: new Headers(init?.headers) });
      return Response.json(target.pathname.endsWith("/results") ? { tab: "waiting", items: [], total: 0, returned: 0, limit: 25, offset: 0, counts: { waiting: 0, no_response: 0, meeting: 0, rejected: 0, snoozed: 0 } } : { ok: true }, { headers: { "set-cookie": "kindling_session=rotated; HttpOnly", "x-csrf-token": "csrf-2", "x-request-id": "request-1" } });
    };
    const baseHeaders = { "x-kindling-workspace-id": "workspace-a", cookie: "kindling_session=opaque", "x-csrf-token": "csrf-1", authorization: "Nostr signed" };
    const resultRequest = new Request("https://frontend.test/api/kindling/outreach/results?tab=waiting&q=Acme&limit=25&offset=0", { headers: baseHeaders });
    const results = await handleBackendApi(resultRequest, new URL(resultRequest.url), fetcher as typeof fetch);
    expect(await results?.json()).toMatchObject({ items: [], total: 0, counts: { waiting: 0 } });
    for (const action of ["sent", "undo", "dismiss", "respond", "snooze"]) {
      const request = new Request(`https://frontend.test/api/kindling/outreach/${action}`, { method: "POST", headers: { ...baseHeaders, "content-type": "application/json" }, body: JSON.stringify({ companyId: "co-1" }) });
      const response = await handleBackendApi(request, new URL(request.url), fetcher as typeof fetch);
      expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response?.headers.get("x-csrf-token")).toBe("csrf-2");
      expect(response?.headers.get("x-request-id")).toBe("request-1");
    }
    expect(calls.map((call) => call.path)).toEqual(["results", "sent", "undo", "dismiss", "respond", "snooze"].map((suffix) => `/api/v1/workspaces/workspace-a/outreach/${suffix}`));
    expect(calls[0]?.search).toBe("?tab=waiting&q=Acme&limit=25&offset=0");
    expect(calls[0]?.headers.get("cookie")).toBe("kindling_session=opaque");
    expect(calls[0]?.headers.get("x-csrf-token")).toBe("csrf-1");
    expect(calls[0]?.headers.get("authorization")).toBe("Nostr signed");
  });

  test("requires a workspace on all workspace-scoped frontend adapters", async () => {
    for (const [path, method] of [
      ["/api/kindling/value-propositions", "GET"],
      ["/api/kindling/profile", "GET"],
      ["/api/kindling/service-offering", "POST"],
      ["/api/kindling/outreach/results", "GET"],
      ["/api/kindling/outreach/sent", "POST"],
    ]) {
      const request = new Request(`https://frontend.test${path}`, { method });
      expect((await handleBackendApi(request, new URL(request.url), async () => { throw new Error("must not fetch"); }))?.status).toBe(400);
    }
  });

  test("canonicalizes only exact allow-listed backend origins", () => {
    const policy = { defaultOrigin: "http://127.0.0.1:41038", allowedOrigins: ["http://127.0.0.1:41038", "https://trusted.test"] };
    expect(canonicalBackendTarget(undefined, policy)).toBe("http://127.0.0.1:41038");
    expect(canonicalBackendTarget("https://trusted.test:443/", policy)).toBe("https://trusted.test");
    for (const target of [
      "https://user:pass@trusted.test",
      "https://trusted.test/api",
      "https://trusted.test?next=x",
      "https://trusted.test#fragment",
      "http://trusted.test",
      "https://evil.test",
      "file:///etc/passwd",
      "//trusted.test",
      "not a url",
    ]) expect(() => canonicalBackendTarget(target, policy)).toThrow();
  });

  test("SSRF boundary rejects untrusted target headers before any network request", async () => {
    for (const target of [
      "http://169.254.169.254",
      "http://127.0.0.1:1",
      "https://kindling-be.a.otherstuff.ai/private",
      "https://admin@kindling-be.a.otherstuff.ai",
      "https://kindling-be.a.otherstuff.ai?url=https://evil.test",
      "https://evil.test",
    ]) {
      let fetches = 0;
      const response = await handleSaasRequest(new Request("https://frontend.test/api/me", { headers: { "x-kindling-backend-url": target } }), async () => { fetches += 1; return Response.json({}); });
      expect(response.status).toBe(400);
      expect(fetches).toBe(0);
    }
  });

  test("selected trusted target is used consistently for auth, company and health requests", async () => {
    const urls: URL[] = [];
    const fetcher = async (input: RequestInfo | URL) => { urls.push(new URL(String(input))); return Response.json({ items: [], total: 0 }); };
    for (const path of ["/api/me", "/api/kindling/companies?limit=1", "/api/health"]) {
      const request = new Request(`https://frontend.test${path}`, { headers: { "x-kindling-backend-url": "https://kindling-be.a.otherstuff.ai", "x-kindling-workspace-id": "workspace-a" } });
      expect((await handleSaasRequest(request, fetcher as typeof fetch)).status).toBe(200);
    }
    expect(urls.map((url) => url.origin)).toEqual(Array(3).fill("https://kindling-be.a.otherstuff.ai"));
    expect(urls[2]?.pathname).toBe("/healthz");
  });
});
