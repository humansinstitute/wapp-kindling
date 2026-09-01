import { join } from "node:path";
import { backendReachability, handleBackendApi, requestBackendTarget } from "./backend-api.ts";
import { BUILD_VERSION, KINDLING_API_URL, KINDLING_API_VERSION, KINDLING_SCHEMA_VERSION, PORT } from "./config.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(PUBLIC_DIR, relativePath));
  if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
  const fallback = Bun.file(join(PUBLIC_DIR, "index.html"));
  return await fallback.exists()
    ? new Response(fallback, { headers: { "cache-control": "no-store" } })
    : new Response("public/index.html missing", { status: 500 });
}

export async function handleSaasRequest(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    let backend;
    try {
      backend = await backendReachability(request, fetchImpl);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Backend URL is invalid" }, 400);
    }
    return json({
      ok: true,
      ready: true,
      now: new Date().toISOString(),
      frontend: { buildVersion: BUILD_VERSION },
      api: { baseUrl: requestBackendTarget(request), managedDefaultUrl: KINDLING_API_URL, version: KINDLING_API_VERSION, schemaVersion: KINDLING_SCHEMA_VERSION, ...backend },
      companySource: "kindling-be",
      serverPersistenceRequired: false,
    });
  }
  if (url.pathname.startsWith("/api/")) {
    try {
      const response = await handleBackendApi(request, url, fetchImpl);
      return response ?? json({ error: "backend route is not available in the SaaS frontend contract" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Backend URL is invalid" }, 400);
    }
  }
  return serveStatic(url.pathname);
}

if (import.meta.main) {
  const server = Bun.serve({ port: PORT, fetch: (request) => handleSaasRequest(request) });
  console.log(`kindling-fe SaaS frontend listening on ${server.url}`);
}
