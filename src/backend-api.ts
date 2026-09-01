import {
  BUILD_VERSION,
  KINDLING_API_COMPATIBILITY,
  KINDLING_API_ALLOWED_URLS,
  KINDLING_API_URL,
  KINDLING_API_VERSION,
  KINDLING_SCHEMA_VERSION,
} from "./config.ts";

export interface CompanyContract {
  id: string;
  name: string;
  location: string;
  industry: string;
  website: string;
  dataRing: string;
  duplicateStatus: string;
  enrichmentStatus: string;
  confidence: number;
  profile: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  rowVersion?: string | number;
  canonical: Record<string, unknown>;
}

export interface CompanyPageContract {
  companies: CompanyContract[];
  total: number;
  returned: number;
  limit: number;
  offset: number;
  cursor?: string;
  nextCursor?: string;
  etag?: string;
  schemaVersion: string;
  bandCounts?: Record<string, number>;
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;
export const BACKEND_TARGET_HEADER = "x-kindling-backend-url";

export interface BackendTargetPolicy {
  defaultOrigin: string;
  allowedOrigins: readonly string[];
}

const configuredBackendPolicy: BackendTargetPolicy = {
  defaultOrigin: new URL(KINDLING_API_URL).origin,
  allowedOrigins: KINDLING_API_ALLOWED_URLS,
};

export function canonicalBackendTarget(value: string | null | undefined, policy: BackendTargetPolicy = configuredBackendPolicy): string {
  if (!value?.trim()) return policy.defaultOrigin;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Backend URL must be a valid trusted HTTPS origin");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Backend URL must be an origin without credentials, path, query, or fragment");
  }
  if (parsed.protocol !== "https:" && parsed.origin !== policy.defaultOrigin) {
    throw new Error("Backend URL must use HTTPS");
  }
  const canonical = parsed.origin;
  if (!policy.allowedOrigins.includes(canonical)) throw new Error("Backend URL is not trusted");
  return canonical;
}

export function requestBackendTarget(request: Request): string {
  return canonicalBackendTarget(request.headers.get(BACKEND_TARGET_HEADER));
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeBackendCompany(value: unknown): CompanyContract {
  const raw = object(value);
  const canonical = object(raw.canonical ?? raw.target ?? raw);
  const location = object(raw.location ?? canonical.location);
  const industry = object(raw.industry ?? canonical.industry);
  const profile = object(raw.profile ?? raw.workspace_overlay ?? raw.workspaceOverlay);
  const rawRowVersion = raw.row_version ?? raw.rowVersion;
  const rowVersion = typeof rawRowVersion === "string" || typeof rawRowVersion === "number" ? rawRowVersion : undefined;
  const updatedAt = timestamp(raw.updatedAt ?? raw.updated_at ?? raw.modified_at ?? canonical.updatedAt ?? canonical.updated_at);
  const createdAt = timestamp(raw.createdAt ?? raw.created_at ?? canonical.createdAt ?? canonical.created_at);
  return {
    id: text(raw.id ?? raw.company_id ?? raw.companyId ?? canonical.id),
    name: text(raw.name ?? raw.display_name ?? raw.displayName ?? canonical.displayName ?? canonical.canonicalName),
    location: typeof raw.location === "string" ? raw.location : text(location.text ?? [location.city, location.state, location.country].filter(Boolean).join(", ")),
    industry: typeof raw.industry === "string" ? raw.industry : text(object(industry.level2).label ?? object(industry.level1).label ?? industry.label),
    website: text(raw.website ?? raw.website_url ?? raw.websiteUrl ?? canonical.websiteUrl),
    dataRing: text(raw.data_ring ?? raw.dataRing ?? profile.data_ring ?? "found"),
    duplicateStatus: text(raw.duplicate_status ?? raw.duplicateStatus ?? "unknown"),
    enrichmentStatus: text(raw.enrichment_status ?? raw.enrichmentStatus ?? canonical.enrichmentStatus ?? "not_started"),
    confidence: Number(raw.confidence ?? canonical.confidence ?? 0),
    profile,
    createdAt,
    updatedAt,
    ...(rowVersion !== undefined ? { rowVersion } : {}),
    canonical,
  };
}

export function normalizeCompanyPage(payload: unknown, requestUrl: URL, etag = ""): CompanyPageContract {
  const raw = object(payload);
  const values = Array.isArray(raw.companies) ? raw.companies : Array.isArray(raw.targets) ? raw.targets : Array.isArray(raw.items) ? raw.items : [];
  const companies = values.map(normalizeBackendCompany).filter((company) => company.id);
  const limit = Number(raw.limit ?? requestUrl.searchParams.get("limit") ?? companies.length);
  const offset = Number(raw.offset ?? requestUrl.searchParams.get("offset") ?? 0);
  return {
    companies,
    total: Number(raw.total ?? raw.totalCount ?? raw.count ?? companies.length),
    returned: companies.length,
    limit: Number.isFinite(limit) ? limit : companies.length,
    offset: Number.isFinite(offset) ? offset : 0,
    ...(raw.cursor ? { cursor: text(raw.cursor) } : {}),
    ...(raw.next_cursor || raw.nextCursor || object(raw.page).nextCursor ? { nextCursor: text(raw.next_cursor ?? raw.nextCursor ?? object(raw.page).nextCursor) } : {}),
    ...(etag ? { etag } : {}),
    schemaVersion: text(raw.schema_version ?? raw.schemaVersion ?? KINDLING_SCHEMA_VERSION),
    ...(raw.band_counts || raw.bandCounts ? { bandCounts: object(raw.band_counts ?? raw.bandCounts) as Record<string, number> } : {}),
  };
}

function proxyHeaders(request: Request): Headers {
  const headers = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization", "content-type", "if-none-match", "origin", "referer", "x-csrf-token", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers({ "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const name of ["etag", "set-cookie", "vary", "x-csrf-token", "x-kindling-schema-version", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function call(url: URL, request: Request, fetchImpl: FetchLike): Promise<Response> {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer();
  return fetchImpl(url, { method: request.method, headers: proxyHeaders(request), body, redirect: "manual" });
}

async function proxyJson(path: string, request: Request, fetchImpl: FetchLike, transform?: (payload: unknown) => unknown): Promise<Response> {
  const response = await call(new URL(path, `${requestBackendTarget(request)}/`), request, fetchImpl);
  const headers = responseHeaders(response);
  if (!transform || !response.ok) return new Response(await response.arrayBuffer(), { status: response.status, headers });
  const payload = await response.json().catch(() => ({}));
  return Response.json(transform(payload), { status: response.status, headers });
}

function workspaceId(request: Request, url: URL): string {
  return text(request.headers.get("x-kindling-workspace-id") || url.searchParams.get("workspaceId") || url.searchParams.get("workspace_id")).trim();
}

function companyPaths(id: string | null, workspace: string): string[] {
  const suffix = id ? `/${encodeURIComponent(id)}` : "";
  const workspacePath = workspace ? `/api/${KINDLING_API_VERSION}/workspaces/${encodeURIComponent(workspace)}/companies${suffix}` : "";
  const targetsPath = `/api/${KINDLING_API_VERSION}/targets${suffix}`;
  if (KINDLING_API_COMPATIBILITY === "workspace") return workspacePath ? [workspacePath] : [];
  if (KINDLING_API_COMPATIBILITY === "targets") return [targetsPath];
  return workspacePath ? [workspacePath, targetsPath] : [targetsPath];
}

function backendUrl(path: string, frontendUrl: URL, request: Request): URL {
  const target = new URL(path, `${requestBackendTarget(request)}/`);
  target.search = frontendUrl.search;
  target.searchParams.delete("workspaceId");
  target.searchParams.delete("workspace_id");
  return target;
}

async function companyResponse(request: Request, frontendUrl: URL, id: string | null, fetchImpl: FetchLike): Promise<Response> {
  const paths = companyPaths(id, workspaceId(request, frontendUrl));
  if (!paths.length) return Response.json({ error: "workspace is required" }, { status: 400 });
  let response: Response | null = null;
  for (const path of paths) {
    response = await call(backendUrl(path, frontendUrl, request), request, fetchImpl);
    if (![404, 405].includes(response.status) || path === paths.at(-1)) break;
  }
  if (!response) return Response.json({ error: "backend route unavailable" }, { status: 502 });
  const headers = responseHeaders(response);
  if (!response.ok || request.method !== "GET") return new Response(await response.arrayBuffer(), { status: response.status, headers });
  const payload = await response.json().catch(() => ({}));
  if (id) {
    const raw = object(payload);
    const company = normalizeBackendCompany(raw.company ?? raw.target ?? raw.item ?? raw);
    return Response.json({ ...raw, company, canonicalTarget: company.canonical, companySource: "kindling-be", schemaVersion: text(raw.schema_version ?? raw.schemaVersion ?? KINDLING_SCHEMA_VERSION) }, { headers });
  }
  return Response.json(normalizeCompanyPage(payload, frontendUrl, response.headers.get("etag") || ""), { headers });
}

export async function handleBackendApi(request: Request, url: URL, fetchImpl: FetchLike = fetch): Promise<Response | null> {
  if (url.pathname === "/api/runtime-config" && request.method === "GET") {
    return Response.json({ apiVersion: KINDLING_API_VERSION, schemaVersion: KINDLING_SCHEMA_VERSION, buildVersion: BUILD_VERSION, companySource: "kindling-be", persistence: "bounded-indexeddb", defaultBackendOrigin: configuredBackendPolicy.defaultOrigin, allowedBackendOrigins: [...configuredBackendPolicy.allowedOrigins] });
  }
  if (url.pathname === "/api/auth/challenge" && request.method === "POST") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/auth/challenge`, request, fetchImpl);
  }
  if (url.pathname === "/api/auth/agent-challenge" && request.method === "POST") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/auth/agent-challenge`, request, fetchImpl);
  }
  if (url.pathname === "/api/auth/agent-session" && request.method === "POST") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/auth/agent-session`, request, fetchImpl);
  }
  if (url.pathname === "/api/auth/verify" && request.method === "POST") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/auth/session`, request, fetchImpl);
  }
  if (url.pathname === "/api/auth/session" && request.method === "DELETE") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/auth/session`, request, fetchImpl);
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    return proxyJson(`/api/${KINDLING_API_VERSION}/me`, request, fetchImpl, (payload) => {
      const raw = object(payload);
      const me = { ...raw, ...object(raw.user) };
      const role = text(me.role ?? object(me.membership).role ?? "viewer");
      return { ...me, access: me.access ?? { login: true, read: true, edit: ["owner", "admin", "contributor"].includes(role) } };
    });
  }
  const companyMatch = url.pathname.match(/^\/api\/kindling\/companies(?:\/([^/]+))?$/);
  if (companyMatch) return companyResponse(request, url, companyMatch[1] ? decodeURIComponent(companyMatch[1]) : null, fetchImpl);
  if (url.pathname === "/api/kindling/top-targets" && request.method === "GET") {
    const response = await companyResponse(request, url, null, fetchImpl);
    if (!response.ok) return response;
    const page = await response.json() as CompanyPageContract;
    return Response.json({
      targets: page.companies.map((company) => ({ companyId: company.id, company, band: url.searchParams.get("band") || "unscored" })),
      total: page.total,
      returned: page.returned,
      limit: page.limit,
      offset: page.offset,
      nextCursor: page.nextCursor,
      schemaVersion: page.schemaVersion,
      companySource: "kindling-be",
    });
  }
  if (url.pathname === "/api/kindling/summary" && request.method === "GET") {
    const countUrl = new URL(url);
    countUrl.pathname = "/api/kindling/companies";
    countUrl.search = "?limit=1";
    const response = await companyResponse(request, countUrl, null, fetchImpl);
    if (!response.ok) return response;
    const page = await response.json() as CompanyPageContract;
    return Response.json({ companies: [], counts: { companies: page.total }, companyList: { returned: 0, total: page.total, limit: 0 }, compact: true, companySource: "kindling-be", schemaVersion: page.schemaVersion });
  }
  const workspaceResource = url.pathname.match(/^\/api\/kindling\/(target-lists|value-propositions|assessment-campaigns|signals)(\/.*)?$/);
  if (workspaceResource) {
    const workspace = workspaceId(request, url);
    if (!workspace) return Response.json({ error: "workspace is required" }, { status: 400 });
    const resource = workspaceResource[1];
    const suffix = workspaceResource[2] ?? "";
    return call(backendUrl(`/api/${KINDLING_API_VERSION}/workspaces/${encodeURIComponent(workspace)}/${resource}${suffix}`, url, request), request, fetchImpl);
  }
  if (url.pathname === "/api/kindling/profile" && request.method === "GET") {
    const workspace = workspaceId(request, url);
    if (!workspace) return Response.json({ error: "workspace is required" }, { status: 400 });
    return proxyJson(`/api/${KINDLING_API_VERSION}/workspaces/${encodeURIComponent(workspace)}/value-propositions`, request, fetchImpl, (payload) => {
      const raw = object(payload);
      const offerings = Array.isArray(raw.items) ? raw.items : [];
      const selected = offerings.find((item) => object(item).active !== false) ?? offerings[0] ?? null;
      return { ...raw, offerings, profile: selected };
    });
  }
  if (url.pathname === "/api/kindling/service-offering" && request.method === "POST") {
    const workspace = workspaceId(request, url);
    if (!workspace) return Response.json({ error: "workspace is required" }, { status: 400 });
    const body = object(await request.clone().json().catch(() => ({})));
    const id = text(body.id ?? body.valuePropositionId).trim();
    const path = `/api/${KINDLING_API_VERSION}/workspaces/${encodeURIComponent(workspace)}/value-propositions${id ? `/${encodeURIComponent(id)}` : ""}`;
    const forwarded = new Request(request, { method: id ? "PATCH" : "POST" });
    return proxyJson(path, forwarded, fetchImpl);
  }
  const outreach = url.pathname.match(/^\/api\/kindling\/outreach\/(results|sent|undo|dismiss|respond|snooze)$/);
  if (outreach && ((outreach[1] === "results" && request.method === "GET") || (outreach[1] !== "results" && request.method === "POST"))) {
    const workspace = workspaceId(request, url);
    if (!workspace) return Response.json({ error: "workspace is required" }, { status: 400 });
    return call(backendUrl(`/api/${KINDLING_API_VERSION}/workspaces/${encodeURIComponent(workspace)}/outreach/${outreach[1]}`, url, request), request, fetchImpl);
  }
  return null;
}

export async function backendReachability(request?: Request, fetchImpl: FetchLike = fetch): Promise<{ reachable: boolean; status: number | null; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  const origin = request ? requestBackendTarget(request) : configuredBackendPolicy.defaultOrigin;
  try {
    const response = await fetchImpl(new URL("/healthz", `${origin}/`), { signal: AbortSignal.timeout(1500), headers: { accept: "application/json" } });
    return { reachable: response.ok, status: response.status, checkedAt };
  } catch {
    return { reachable: false, status: null, checkedAt };
  }
}
