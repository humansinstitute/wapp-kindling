import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

process.env.CHAT_WAPP_DB_PATH = join(mkdtempSync(join(tmpdir(), "kindling-api-")), "test.sqlite");
process.env.CHAT_WAPP_ALLOW_MOCK = "1";
process.env.WINGMAN_URL = "http://127.0.0.1:9";

const { db, ensureDefaultPipelineRoles } = await import("../src/db.ts");
const { handleApi } = await import("../src/server.ts");

const pubkey = "1".repeat(64);
const token = "test-token";

function resetData() {
  for (const table of [
    "outreach_drafts",
    "target_rankings",
    "enrichment_requests",
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
    const roles = db.query("SELECT role_key, active_pipeline_slug, expected_output_shape FROM pipeline_roles WHERE role_key IN ('develop_service_offering', 'scan_target_list', 'enrich_company', 'draft_outreach') ORDER BY role_key")
      .all() as Array<Record<string, string>>;
    expect(roles.map((role) => role.active_pipeline_slug)).toEqual([
      "kindling-develop-service-offering",
      "kindling-draft-outreach",
      "kindling-enrich-company",
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
      localContext: {
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

  test("returns JSON when Autopilot pipeline discovery is unreachable", async () => {
    const { res, payload } = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
        autopilotAuthorization: "Nostr test",
      },
    });
    expect(res.status).toBe(502);
    expect(payload.error).toContain("Autopilot pipeline list failed");
    expect(payload.url).toBe("http://127.0.0.1:9/api/pipelines/definitions");
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
        },
      },
    });
    expect(res.status).toBe(200);
    const company = db.query("SELECT name, industry, location, website FROM companies LIMIT 1").get() as Record<string, string>;
    expect(company).toMatchObject({ name: "North HVAC", industry: "HVAC", location: "Perth", website: "https://north.example" });
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
});
