import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { beforeEach, describe, expect, test } from "bun:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

process.env.CHAT_WAPP_DB_PATH = join(mkdtempSync(join(tmpdir(), "kindling-api-")), "test.sqlite");
process.env.WINGMAN_URL = "http://127.0.0.1:9";

const {
  acquireSchedulerLock,
  backfillEnrichmentRequestWorkQueue,
  createSchedulerRun,
  db,
  ensureDefaultPipelineRoles,
  ensureDefaultSchedulerSettings,
  ensureDefaultTargetSegments,
  getSchedulerSettings,
} = await import("../src/db.ts");
const { handleApi, runAutomatedProspectingLoop } = await import("../src/server.ts");
const { runAutoEnrichNextIndustry } = await import("../src/auto-enrichment-job.ts");

const secretKey = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(secretKey);
const token = "test-token";

function resetData() {
  for (const table of [
    "scheduler_locks",
    "scheduler_runs",
    "scheduler_settings",
    "outreach_drafts",
    "target_list_items",
    "target_list_runs",
    "ranking_items",
    "ranking_runs",
    "target_rankings",
    "service_fit_assessments",
    "work_queue",
    "enrichment_requests",
    "scan_strategy_attempts",
    "discovery_jobs",
    "coverage_slices",
    "target_geographies",
    "activities",
    "signals",
    "customer_profile_versions",
    "sources",
    "company_segments",
    "target_segments",
    "companies",
    "service_offerings",
    "market_profile_versions",
    "market_profiles",
    "kindling_pipeline_runs",
    "access_rules",
    "sessions",
    "users",
  ]) {
    db.query(`DELETE FROM ${table}`).run();
  }
  db.query("INSERT INTO users(pubkey, npub, created_at, last_seen_at) VALUES (?1, 'npub-test', 1, 1)").run(pubkey);
  db.query("INSERT INTO sessions(token, pubkey, expires_at, created_at) VALUES (?1, ?2, ?3, 1)")
    .run(token, pubkey, Date.now() + 60_000);
  ensureDefaultTargetSegments(1);
  ensureDefaultSchedulerSettings(1);
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

function seedKindlingRun(roleKey: string, requestId: string, webhookToken: string, triggerPayload: unknown = {}) {
  db.query(`
    INSERT INTO kindling_pipeline_runs(
      id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, 'running', ?4, '{}', 1, 1)
  `).run(`run-${requestId}`, roleKey, requestId, webhookToken);
  db.query("UPDATE kindling_pipeline_runs SET trigger_payload_json = ?1 WHERE id = ?2")
    .run(JSON.stringify(triggerPayload), `run-${requestId}`);
}

function makeCurrentUserReadOnly() {
  db.query("INSERT INTO access_rules(pubkey, npub, role, created_at) VALUES (?1, 'npub-test', 'read', 1)").run(pubkey);
}

function seedSchedulerAcquisitionSlice(sliceId: string) {
  const now = Date.now();
  db.query(`
    UPDATE target_segments
    SET coverage_targets_json = '{"found":0}', default_target_count = 0
    WHERE id = 'adapt-tier-1-sme-advisory-referral-rich'
  `).run();
  db.query(`
    UPDATE target_segments
    SET priority = 1
    WHERE id = 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory'
  `).run();
  db.query(`
    INSERT INTO coverage_slices(
      id, segment_id, geography_id, geography_text, source_family, strategy_type, status,
      target_counts_json, current_counts_json, yield_metrics_json, created_at, updated_at
    )
    VALUES (
      ?1,
      'adapt-tier-1-accounting-tax-bookkeeping-business-advisory',
      NULL,
      'Perth',
      'directory',
      'directory',
      'active',
      '{"found":15}',
      '{}',
      '{}',
      ?2,
      ?2
    )
  `).run(sliceId, now);
  db.query(`
    INSERT INTO discovery_jobs(id, industry, location, segment_id, geography_text, coverage_slice_id, target_count, scan_mode, status, created_at, updated_at)
    VALUES (?1, 'Accounting, tax, bookkeeping, and business advisory', 'Perth', 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 'Perth', ?2, 15, 'interactive', 'complete', ?3, ?3)
  `).run(`prior-${sliceId}`, sliceId, now);
  db.query(`
    INSERT INTO scan_strategy_attempts(
      id, discovery_job_id, segment_id, geography_text, coverage_slice_id, source_family,
      industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at
    )
    VALUES (
      ?1,
      ?2,
      'adapt-tier-1-accounting-tax-bookkeeping-business-advisory',
      'Perth',
      ?3,
      'directory',
      'Accounting, tax, bookkeeping, and business advisory',
      'Perth',
      'directory',
      'prior accounting directory',
      'searched',
      2,
      'prior executed strategy',
      '{}',
      ?4
    )
  `).run(`prior-strategy-${sliceId}`, `prior-${sliceId}`, sliceId, now);
}

beforeEach(() => {
  resetData();
});

describe("Kindling API contracts", () => {
  test("seeds and repairs documented working role slugs", () => {
    const roles = db.query("SELECT role_key, active_pipeline_slug, expected_output_shape FROM pipeline_roles WHERE role_key IN ('develop_service_offering', 'scan_target_list', 'enrich_company', 'enrich_industry_segment', 'score_company_service_fit', 'draft_outreach') ORDER BY role_key")
      .all() as Array<Record<string, string>>;
    expect(roles.map((role) => role.active_pipeline_slug)).toEqual([
      "kindling-develop-service-offering",
      "kindling-draft-outreach",
      "kindling-enrich-company",
      "kindling-enrich-industry-segment",
      "kindling-scan-target-list",
      "kindling-score-company-service-fit",
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

  test("seeds Perth-first target hierarchy and supports company segment confidence", () => {
    const root = db.query("SELECT id, label, tier, priority, status, default_geo FROM target_segments WHERE id = ?1")
      .get("adapt-tier-1-sme-advisory-referral-rich") as Record<string, unknown>;
    expect(root).toMatchObject({
      label: "Tier 1: SME advisory and referral-rich firms",
      tier: 1,
      priority: 10,
      status: "active",
      default_geo: "Perth, WA",
    });

    const tierOneLabels = (db.query(`
      SELECT label
      FROM target_segments
      WHERE parent_id = 'adapt-tier-1-sme-advisory-referral-rich'
      ORDER BY priority ASC
    `).all() as Array<Record<string, string>>).map((segment) => segment.label);
    expect(tierOneLabels).toEqual([
      "Financial planning and wealth advisory",
      "Accounting, tax, bookkeeping, and business advisory",
      "Legal firms serving SMEs, family businesses, succession, commercial law, employment, estate planning, or M&A",
      "HR consulting, leadership advisory, and organisational development",
      "Outsourced CFO, business coaching, and strategy consulting",
      "Insurance, risk, mortgage, finance, and commercial lending brokers with SME owner relationships",
    ]);

    const accounting = db.query(`
      SELECT coverage_targets_json, scan_prompts_json
      FROM target_segments
      WHERE id = 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory'
    `).get() as Record<string, string>;
    expect(JSON.parse(accounting.coverage_targets_json)).toMatchObject({
      found: 140,
      enriched: 56,
      scored: 28,
      outreachReady: 14,
    });
    expect(JSON.parse(accounting.scan_prompts_json).synonyms).toContain("Xero advisors");

    const parked = db.query("SELECT status FROM target_segments WHERE id = 'adapt-tier-5-later-expansion-opportunistic'")
      .get() as Record<string, string>;
    expect(parked.status).toBe("parked");

    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('segment-company', 'Segment Co', 'Perth', 'Tax accountants', '', 'found', 'unknown', 'not_started', 0.4, '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES
        ('segment-company', 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 0.91, 'seed-test', 1),
        ('segment-company', 'adapt-tier-1-outsourced-cfo-business-coaching-strategy', 0.42, 'seed-test', 1)
    `).run();

    const memberships = db.query(`
      SELECT c.industry, cs.confidence, ts.label
      FROM company_segments cs
      JOIN companies c ON c.id = cs.company_id
      JOIN target_segments ts ON ts.id = cs.segment_id
      WHERE cs.company_id = 'segment-company'
      ORDER BY cs.confidence DESC
    `).all() as Array<Record<string, unknown>>;
    expect(memberships).toHaveLength(2);
    expect(memberships[0]).toMatchObject({
      industry: "Tax accountants",
      confidence: 0.91,
      label: "Accounting, tax, bookkeeping, and business advisory",
    });
  });

  test("reads target segment tree and edits segment metadata", async () => {
    const list = await api("/api/kindling/target-segments");
    expect(list.res.status).toBe(200);
    expect(list.payload.tree[0]).toMatchObject({
      id: "adapt-tier-1-sme-advisory-referral-rich",
      label: "Tier 1: SME advisory and referral-rich firms",
    });
    expect(list.payload.tree[0].children[0]).toMatchObject({
      id: "adapt-tier-1-financial-planning-wealth",
    });

    const created = await api("/api/kindling/target-segments", {
      method: "POST",
      body: {
        id: "segment-test-child",
        label: "Boutique advisory partners",
        parentId: "adapt-tier-1-sme-advisory-referral-rich",
        tier: 1,
        priority: 19,
        status: "active",
        targets: { found: 33, enriched: 12 },
        prompts: { prompt: "Find boutique advisory referral partners.", synonyms: ["boutique advisory"] },
      },
    });
    expect(created.res.status).toBe(201);
    expect(created.payload.segment).toMatchObject({
      id: "segment-test-child",
      parentId: "adapt-tier-1-sme-advisory-referral-rich",
      label: "Boutique advisory partners",
      priority: 19,
      status: "active",
      targets: { found: 33, enriched: 12 },
      prompts: { prompt: "Find boutique advisory referral partners." },
    });

    const updated = await api("/api/kindling/target-segments/segment-test-child", {
      method: "PATCH",
      body: {
        label: "Boutique advisory and referral partners",
        parentId: "adapt-tier-2-owner-led-professional-services",
        priority: 31,
        status: "parked",
        coverageTargets: { found: 44, outreachReady: 4 },
        scanPrompts: { prompt: "Parked until Tier 1 coverage is healthy." },
      },
    });
    expect(updated.res.status).toBe(200);
    expect(updated.payload.segment).toMatchObject({
      label: "Boutique advisory and referral partners",
      parentId: "adapt-tier-2-owner-led-professional-services",
      priority: 31,
      status: "parked",
      coverageTargets: { found: 44, outreachReady: 4 },
      scanPrompts: { prompt: "Parked until Tier 1 coverage is healthy." },
    });
  });

  test("rejects invalid target segment parent loops", async () => {
    const loop = await api("/api/kindling/target-segments/adapt-tier-1-sme-advisory-referral-rich", {
      method: "PATCH",
      body: {
        parentId: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
      },
    });
    expect(loop.res.status).toBe(400);
    expect(loop.payload.error).toContain("loop");

    const root = db.query("SELECT parent_id FROM target_segments WHERE id = 'adapt-tier-1-sme-advisory-referral-rich'")
      .get() as Record<string, unknown>;
    expect(root.parent_id).toBeNull();
  });

  test("upserts company segment memberships through the API", async () => {
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('segment-api-company', 'Segment API Co', 'Perth', 'Advisory', '', 'found', 'unknown', 'not_started', 0.4, '{}', 1, 1)
    `).run();

    const patched = await api("/api/kindling/companies/segment-api-company/segments", {
      method: "PATCH",
      body: {
        segments: [
          { segmentId: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory", confidence: 0.88, source: "manual-review" },
          { segmentId: "adapt-tier-1-outsourced-cfo-business-coaching-strategy", confidence: 0.55, source: "manual-review" },
        ],
      },
    });
    expect(patched.res.status).toBe(200);
    expect(patched.payload.segments.map((membership: { segmentId: string }) => membership.segmentId)).toEqual([
      "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
      "adapt-tier-1-outsourced-cfo-business-coaching-strategy",
    ]);
    expect(patched.payload.segments[0]).toMatchObject({
      confidence: 0.88,
      source: "manual-review",
      segment: {
        label: "Accounting, tax, bookkeeping, and business advisory",
      },
    });

    const replaced = await api("/api/kindling/companies/segment-api-company/segments", {
      method: "PATCH",
      body: {
        replace: true,
        segments: [
          { segmentId: "adapt-tier-2-owner-led-professional-services", confidence: 0.7, source: "agent" },
        ],
      },
    });
    expect(replaced.payload.segments).toHaveLength(1);
    expect(replaced.payload.segments[0]).toMatchObject({
      segmentId: "adapt-tier-2-owner-led-professional-services",
      confidence: 0.7,
      source: "agent",
    });

    const detail = await api("/api/kindling/companies/segment-api-company");
    expect(detail.payload.segments[0].segment.label).toBe("Tier 2: Owner-led professional services");

    const invalid = await api("/api/kindling/companies/segment-api-company/segments", {
      method: "PATCH",
      body: { segments: [{ segmentId: "missing-segment", confidence: 0.1 }] },
    });
    expect(invalid.res.status).toBe(400);
    expect(invalid.payload.error).toContain("segment not found");
  });

  test("blocks read-only users from triggering pipelines", async () => {
    makeCurrentUserReadOnly();

    const service = await api("/api/kindling/service-offering", {
      method: "POST",
      body: { prompt: "Update the profile" },
    });
    expect(service.res.status).toBe(403);
    expect(service.payload.error).toBe("edit access required");

    const now = Date.now();
    db.query("INSERT INTO chats(id, pubkey, title, created_at, updated_at) VALUES ('read-chat', ?1, 'Read chat', ?2, ?2)")
      .run(pubkey, now);

    const message = await api("/api/chats/read-chat/messages", {
      method: "POST",
      body: { content: "Trigger the default chat pipeline" },
    });
    expect(message.res.status).toBe(403);
    expect(message.payload.error).toBe("edit access required");

    db.query(`
      INSERT INTO pipeline_runs(
        id, chat_id, user_message_id, assistant_message_id, trigger_status, webhook_token, trigger_payload_json, created_at, updated_at
      )
      VALUES ('read-run', 'read-chat', 'user-message', 'assistant-message', 'awaiting-user-nip98', 'read-token', '{}', ?1, ?1)
    `).run(now);
    const start = await api("/api/pipeline-runs/read-run/start", {
      method: "POST",
      body: { autopilotAuthorization: "Nostr test" },
    });
    expect(start.res.status).toBe(403);
    expect(start.payload.error).toBe("edit access required");
  });

  test("builds documented trigger payload fields and webhook auth header", async () => {
    const { res, payload } = await api("/api/kindling/target-scans", {
      method: "POST",
      body: { industry: "HVAC", location: "Perth", deferAutopilotAuth: true },
    });
    expect(res.status).toBe(202);
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
      body: { industry: "Legal Services", location: "Perth", targetCount: 1000, deferAutopilotAuth: true },
    });
    expect(res.status).toBe(202);
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
      body: { limit: 21, deferAutopilotAuth: true },
    });
    expect(queued.res.status).toBe(202);
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

  test("uses the configured public Rick Autopilot URL without remapping", async () => {
    const { res, payload } = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: {
        autopilotUrl: "https://rick.runwingman.com",
      },
    });
    expect(res.status).toBe(202);
    expect(payload.triggerRequest.url).toBe("https://rick.runwingman.com/api/pipelines/definitions");
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

  test("builds Kindling scan triggers against the saved Autopilot URL exactly", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "https://rick.runwingman.com",
      },
    });

    const { res, payload } = await api("/api/kindling/target-scans", {
      method: "POST",
      body: { industry: "HVAC", location: "Perth", deferAutopilotAuth: true },
    });
    expect(res.status).toBe(202);
    expect(payload.triggerRequest.url).toBe("https://rick.runwingman.com/api/pipelines/triggers/http/kindling-scan-target-list");
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
          profileVersionPatch: {
            summary: "Summary",
            rationale: "Because",
            offer: "Offer",
            services: [
              { key: "ai_consulting", name: "AI consulting", description: "Practical AI advisory." },
              { key: "wingman_implementations", name: "Wingman implementations" },
            ],
            positioningVariants: ["Succession", "Reducing owner dependence"],
          },
          changeSummary: "Changed positioning",
          rationaleNotes: ["Reason one"],
          nextQuestions: ["Next?"],
          evidence: [{ label: "Brief", summary: "User brief", confidence: 0.9 }],
          warnings: ["Needs proof"],
        },
      },
    });
    expect(res.status).toBe(200);
    const version = db.query("SELECT summary, rationale, structured_json FROM market_profile_versions LIMIT 1").get() as Record<string, string>;
    expect(version.summary).toBe("Summary");
    expect(version.rationale).toBe("Because");
    const structured = JSON.parse(version.structured_json);
    expect(structured.offer).toBe("Offer");
    expect(structured.changeSummary).toBe("Changed positioning");
    expect(structured.rationaleNotes).toEqual(["Reason one"]);
    expect(structured.nextQuestions).toEqual(["Next?"]);
    expect(structured.evidence[0].label).toBe("Brief");
    expect(structured.warnings).toEqual(["Needs proof"]);

    const firstVersion = db.query("SELECT id FROM market_profile_versions LIMIT 1").get() as Record<string, string>;
    const offerings = db.query(`
      SELECT market_profile_version_id, key, name, variant_key, status
      FROM service_offerings
      WHERE market_profile_version_id = ?1
      ORDER BY key, variant_key
    `).all(firstVersion.id) as Array<Record<string, string>>;
    expect(offerings.map((offering) => offering.key)).toContain("ai_consulting");
    expect(offerings.map((offering) => offering.key)).toContain("wingman_implementations");
    expect(offerings.map((offering) => offering.key)).toContain("custom_wapps");
    expect(offerings.map((offering) => offering.key)).toContain("training");
    expect(offerings.find((offering) => offering.key === "succession")).toMatchObject({
      variant_key: "succession",
      status: "active",
    });
    expect(offerings.find((offering) => offering.key === "reducing_owner_dependence")).toMatchObject({
      variant_key: "reducing_owner_dependence",
      status: "active",
    });

    const listed = await api("/api/kindling/scoring/offerings");
    expect(listed.res.status).toBe(200);
    expect(listed.payload.marketProfileVersionId).toBe(firstVersion.id);
    expect(listed.payload.offerings.map((offering: { key: string }) => offering.key)).toContain("maximizing_value");
    expect(listed.payload.offerings.every((offering: { id: string }) => offering.id.includes(firstVersion.id))).toBe(true);

    seedKindlingRun("develop_service_offering", "profile-request-2", "profile-token-2");
    const secondCallback = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "profile-token-2" },
      body: {
        requestId: "profile-request-2",
        role: "develop_service_offering",
        status: "ok",
        response: "Profile updated again",
        result: {
          outputKind: "market_profile_update",
          profileVersionPatch: {
            summary: "Second summary",
            services: [{ key: "training", name: "Training" }],
            positioningVariants: ["Scale"],
          },
        },
      },
    });
    expect(secondCallback.res.status).toBe(200);
    const versions = db.query("SELECT id, version_number FROM market_profile_versions ORDER BY version_number")
      .all() as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS count FROM service_offerings WHERE market_profile_version_id = ?1").get(firstVersion.id))
      .toMatchObject({ count: offerings.length });
    const activeAfterUpdate = await api("/api/kindling/scoring/offerings");
    expect(activeAfterUpdate.payload.marketProfileVersionId).toBe(versions[1].id);
    expect(activeAfterUpdate.payload.offerings.every((offering: { id: string }) => offering.id.includes(String(versions[1].id)))).toBe(true);
  });

  test("creates independent service-fit scoring triggers and persists idempotent assessments", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: { autopilotUrl: "https://rick.runwingman.com" },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-1', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('profile-version-1', 'profile-1', 1, '{}', 'Adapt services', 'Initial test profile', '[]', ?1)
    `).run(now);

    const offeringIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const key = `offering_${index}`;
      const id = `service_offering:profile-version-1:${key}:base`;
      offeringIds.push(id);
      db.query(`
        INSERT INTO service_offerings(
          id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
        )
        VALUES (?1, 'profile-version-1', ?2, ?3, '', '{}', 'active', ?4, ?4)
      `).run(id, key, `Offering ${index}`, now);
    }

    const companyIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `company-${index}`;
      companyIds.push(id);
      db.query(`
        INSERT INTO companies(
          id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
        )
        VALUES (?1, ?2, 'Perth', 'Advisory', ?3, 'enhanced', 'unknown', 'complete', 0.8, '{}', ?4, ?4)
      `).run(id, `Company ${index}`, `https://company-${index}.example`, now);
    }
    db.query(`
      INSERT INTO sources(
        id, company_id, source_type, url, title, summary, extracted_data_json, confidence, last_checked_at, terms_notes, created_at
      )
      VALUES ('source-0', 'company-0', 'web', 'https://company-0.example/about', 'About', 'Owner-led advisory firm.', '{}', 0.9, ?1, '', ?1)
    `).run(now);

    let firstTrigger: Record<string, unknown> | null = null;
    for (const companyId of companyIds) {
      for (const serviceOfferingId of offeringIds) {
        const trigger = await api("/api/kindling/service-assessments", {
          method: "POST",
          body: { companyId, serviceOfferingId, deferAutopilotAuth: true },
        });
        expect(trigger.res.status).toBe(202);
        firstTrigger ??= trigger.payload as Record<string, unknown>;
      }
    }

    expect(db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs WHERE role_key = 'score_company_service_fit'").get())
      .toMatchObject({ count: 50 });
    expect(db.query("SELECT COUNT(*) AS count FROM work_queue WHERE kind = 'service_fit_assessment'").get())
      .toMatchObject({ count: 50 });
    expect(db.query("SELECT COUNT(DISTINCT target_id) AS count FROM work_queue WHERE kind = 'service_fit_assessment'").get())
      .toMatchObject({ count: 50 });

    const firstRequest = firstTrigger!;
    const triggerRequest = firstRequest.triggerRequest as {
      body: { input: { requestId: string; webhook: { token: string }; localContext: Record<string, unknown> } };
      url: string;
    };
    expect(triggerRequest.url).toBe("https://rick.runwingman.com/api/pipelines/triggers/http/kindling-score-company-service-fit");
    expect(triggerRequest.body.input.localContext.serviceOffering).toMatchObject({
      id: "service_offering:profile-version-1:offering_0:base",
      marketProfileVersionId: "profile-version-1",
    });
    expect(triggerRequest.body.input.localContext.writeApi).toMatchObject({
      url: "http://kindling.test/api/kindling/pipeline-write/service-assessment",
      authHeader: "x-kindling-pipeline-token",
    });

    const assessmentBody = {
      requestId: triggerRequest.body.input.requestId,
      result: {
        outputKind: "service_fit_assessment",
        companyId: "company-0",
        serviceOfferingId: "service_offering:profile-version-1:offering_0:base",
        marketProfileVersionId: "profile-version-1",
        score: 84,
        band: "high",
        confidence: 0.82,
        drivers: [{ dimension: "service_fit", score: 86, reason: "Owner-led advisory signal" }],
        fitExplanation: "Company shows fit for offering 0.",
        evidence: [{ sourceId: "source-0", url: "https://company-0.example/about", summary: "Owner-led advisory firm." }],
        caveats: ["No decision-maker confirmed"],
        recommendedAction: "Review for outreach positioning",
      },
    };
    const written = await api("/api/kindling/pipeline-write/service-assessment", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": triggerRequest.body.input.webhook.token },
      body: assessmentBody,
    });
    expect(written.res.status).toBe(200);
    expect(written.payload.persisted).toMatchObject({
      companyId: "company-0",
      serviceOfferingId: "service_offering:profile-version-1:offering_0:base",
      marketProfileVersionId: "profile-version-1",
      score: 84,
      band: "high",
      recommendedAction: "Review for outreach positioning",
    });

    const rewritten = await api("/api/kindling/pipeline-write/service-assessment", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": triggerRequest.body.input.webhook.token },
      body: {
        ...assessmentBody,
        result: {
          ...assessmentBody.result,
          score: 91,
          evidence: [{ sourceId: "source-0", summary: "Updated evidence persists." }],
          caveats: ["Updated caveat persists"],
        },
      },
    });
    expect(rewritten.res.status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS count FROM service_fit_assessments").get()).toMatchObject({ count: 1 });
    const stored = db.query("SELECT score, evidence_json, caveats_json FROM service_fit_assessments LIMIT 1").get() as Record<string, unknown>;
    expect(stored.score).toBe(91);
    expect(JSON.parse(String(stored.evidence_json))).toEqual([{ sourceId: "source-0", summary: "Updated evidence persists." }]);
    expect(JSON.parse(String(stored.caveats_json))).toEqual(["Updated caveat persists"]);

    const detail = await api("/api/kindling/companies/company-0");
    expect(detail.payload.company.dataRing).toBe("scored");
    expect(detail.payload.serviceFitAssessments).toHaveLength(1);
    expect(detail.payload.serviceFitAssessments[0]).toMatchObject({
      score: 91,
      caveats: ["Updated caveat persists"],
    });
  });

  test("scores one enriched company against all active service offerings in one run", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: { autopilotUrl: "https://rick.runwingman.com" },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-1', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('profile-version-1', 'profile-1', 1, '{}', 'Adapt services', 'Initial test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('service-offering-a', 'profile-version-1', 'advisory', 'Advisory', 'base', '{"detail":"Advisory offer"}', 'active', ?1, ?1),
        ('service-offering-b', 'profile-version-1', 'automation', 'Automation', 'base', '{"detail":"Automation offer"}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES ('company-batch', 'Batch Company', 'Perth', 'Accounting advisory', 'https://batch.example', 'enhanced', 'unique', 'complete', 0.82, '{}', ?1, ?1)
    `).run(now);

    const trigger = await api("/api/kindling/service-assessments", {
      method: "POST",
      body: { companyId: "company-batch", deferAutopilotAuth: true },
    });
    expect(trigger.res.status).toBe(202);
    expect(trigger.payload.offeringCount).toBe(2);
    const triggerInput = trigger.payload.triggerRequest.body.input as Record<string, unknown>;
    expect(triggerInput.serviceOfferingId).toBe("");
    expect(triggerInput.localContext).toMatchObject({
      companyId: "company-batch",
      serviceOfferingId: "",
      marketProfileVersionId: "profile-version-1",
    });
    expect((triggerInput.localContext as { serviceOfferings: Array<Record<string, unknown>> }).serviceOfferings.map((offering) => offering.id)).toEqual([
      "service-offering-a",
      "service-offering-b",
    ]);
    expect(db.query("SELECT target_id FROM work_queue WHERE id = ?1").get(trigger.payload.queueId)).toEqual({
      target_id: "company-batch:all:profile-version-1",
    });

    const written = await api("/api/kindling/pipeline-write/service-assessment", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": triggerInput.webhook.token },
      body: {
        requestId: triggerInput.requestId,
        result: {
          outputKind: "service_fit_assessment_batch",
          companyId: "company-batch",
          marketProfileVersionId: "profile-version-1",
          assessments: [
            {
              outputKind: "service_fit_assessment",
              companyId: "company-batch",
              serviceOfferingId: "service-offering-a",
              marketProfileVersionId: "profile-version-1",
              score: 77,
              band: "high",
              confidence: 0.74,
              drivers: [{ dimension: "service_fit", score: 77, reason: "Advisory fit" }],
              fitExplanation: "Good advisory fit.",
              evidence: [{ summary: "Enriched profile supports advisory fit." }],
              caveats: [],
              recommendedAction: "Review advisory angle",
            },
            {
              outputKind: "service_fit_assessment",
              companyId: "company-batch",
              serviceOfferingId: "service-offering-b",
              marketProfileVersionId: "profile-version-1",
              score: 64,
              band: "medium",
              confidence: 0.68,
              drivers: [{ dimension: "service_fit", score: 64, reason: "Automation fit" }],
              fitExplanation: "Moderate automation fit.",
              evidence: [{ summary: "Some automation signals." }],
              caveats: ["No explicit AI budget signal"],
              recommendedAction: "Review automation angle",
            },
          ],
        },
      },
    });
    expect(written.res.status).toBe(200);
    expect(written.payload.assessments).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS count FROM service_fit_assessments WHERE company_id = 'company-batch'").get())
      .toEqual({ count: 2 });
    expect(db.query("SELECT data_ring FROM companies WHERE id = 'company-batch'").get()).toEqual({ data_ring: "scored" });
    const topTargets = await api("/api/kindling/top-targets");
    expect(topTargets.payload.targets[0]).toMatchObject({
      companyId: "company-batch",
      bestOffering: { id: "service-offering-a" },
    });
  });

  test("rejects service-fit writes that do not match the triggered company and offering", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: { autopilotUrl: "https://rick.runwingman.com" },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-1', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('profile-version-1', 'profile-1', 1, '{}', 'Adapt services', 'Initial test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('service_offering:profile-version-1:offering_a:base', 'profile-version-1', 'offering_a', 'Offering A', '', '{}', 'active', ?1, ?1),
        ('service_offering:profile-version-1:offering_b:base', 'profile-version-1', 'offering_b', 'Offering B', '', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES
        ('company-a', 'Company A', 'Perth', 'Advisory', 'https://a.example', 'enhanced', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('company-b', 'Company B', 'Perth', 'Advisory', 'https://b.example', 'enhanced', 'unknown', 'complete', 0.8, '{}', ?1, ?1)
    `).run(now);

    const trigger = await api("/api/kindling/service-assessments", {
      method: "POST",
      body: {
        companyId: "company-a",
        serviceOfferingId: "service_offering:profile-version-1:offering_a:base",
        deferAutopilotAuth: true,
      },
    });
    expect(trigger.res.status).toBe(202);
    const triggerRequest = trigger.payload.triggerRequest as {
      body: { input: { requestId: string; webhook: { token: string } } };
    };

    const mismatchedWrite = await api("/api/kindling/pipeline-write/service-assessment", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": triggerRequest.body.input.webhook.token },
      body: {
        requestId: triggerRequest.body.input.requestId,
        result: {
          outputKind: "service_fit_assessment",
          companyId: "company-b",
          serviceOfferingId: "service_offering:profile-version-1:offering_b:base",
          marketProfileVersionId: "profile-version-1",
          score: 88,
          band: "high",
          confidence: 0.8,
          drivers: [{ dimension: "service_fit", score: 88, reason: "Wrong target." }],
          fitExplanation: "This should not persist.",
          evidence: [{ summary: "Wrong company." }],
          caveats: ["Wrong offering."],
          recommendedAction: "Reject",
        },
      },
    });
    expect(mismatchedWrite.res.status).toBe(400);
    expect(mismatchedWrite.payload.error).toContain("companyId does not match");
    expect(db.query("SELECT COUNT(*) AS count FROM service_fit_assessments").get()).toMatchObject({ count: 0 });
  });

  test("builds top-target snapshots from service-fit assessments with caveat penalties", async () => {
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-1', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('profile-version-1', 'profile-1', 1, '{}', 'Adapt services', 'Initial test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('service-high', 'profile-version-1', 'ai_consulting', 'AI consulting', 'scale', '{}', 'active', ?1, ?1),
        ('service-low', 'profile-version-1', 'wapp_build', 'WApp build', 'handover', '{}', 'active', ?1, ?1),
        ('service-second', 'profile-version-1', 'training', 'Training', '', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES
        ('top-high', 'Top High Co', 'Perth', 'Accounting advisory', 'https://top-high.example', 'scored', 'unique', 'complete', 0.8, '{"contactPaths":["contact form"]}', ?1, ?1),
        ('top-low', 'Top Low Co', 'Perth', 'Advisory', 'https://top-low.example', 'scored', 'unique', 'complete', 0.3, '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES ('top-high', 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 0.94, 'test', ?1)
    `).run(now);
    db.query(`
      INSERT INTO sources(
        id, company_id, source_type, url, title, summary, extracted_data_json, confidence, last_checked_at, terms_notes, created_at
      )
      VALUES
        ('source-high', 'top-high', 'web', 'https://top-high.example/about', 'About', 'Owner-led advisory firm.', '{}', 0.9, ?1, '', ?1),
        ('source-low', 'top-low', 'web', 'https://top-low.example/about', 'About', 'Thin public evidence.', '{}', 0.2, ?1, '', ?1)
    `).run(now);
    db.query(`
      INSERT INTO signals(
        id, company_id, signal_type, summary, source_id, source_url, observed_date, strength, confidence, adapt_relevance, evidence_json, created_at
      )
      VALUES ('signal-high', 'top-high', 'growth', 'Hiring operations support.', 'source-high', '', '2026-06-01', 'high', 0.86, 'Timing trigger', '{}', ?1)
    `).run(now);
    db.query(`
      INSERT INTO kindling_pipeline_runs(
        id, role_key, local_request_id, status, webhook_token, trigger_payload_json, result_payload_json, created_at, updated_at
      )
      VALUES
        ('run-high', 'score_company_service_fit', 'request-high', 'complete', 'token-high', '{}', '{}', ?1, ?1),
        ('run-low', 'score_company_service_fit', 'request-low', 'complete', 'token-low', '{}', '{}', ?1, ?1),
        ('run-second', 'score_company_service_fit', 'request-second', 'complete', 'token-second', '{}', '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_fit_assessments(
        id, company_id, service_offering_id, market_profile_version_id, score, band, confidence,
        drivers_json, fit_explanation, evidence_json, caveats_json, recommended_action,
        source_run_id, assessment_json, created_at, updated_at
      )
      VALUES
        (
          'assessment-high', 'top-high', 'service-high', 'profile-version-1', 82, 'high', 0.82,
          '[{"reason":"Owner-led advisory firm with automation trigger"}]',
          'Strong owner-led advisory fit for AI consulting.',
          '[{"sourceId":"source-high","summary":"Owner-led advisory firm."},{"sourceId":"signal-high","summary":"Hiring operations support."}]',
          '[]',
          'Review for outreach positioning',
          'run-high',
          '{}',
          ?1,
          ?1
        ),
        (
          'assessment-low', 'top-low', 'service-low', 'profile-version-1', 95, 'high', 0.35,
          '[{"reason":"Potential fit but weak evidence"}]',
          'High raw fit but weakly supported.',
          '[]',
          '["No decision-maker confirmed","Public evidence unverified","Compliance risk needs review"]',
          'Review caveats before outreach',
          'run-low',
          '{}',
          ?1,
          ?1
        ),
        (
          'assessment-second', 'top-high', 'service-second', 'profile-version-1', 76, 'high', 0.74,
          '[{"reason":"Training fit"}]',
          'Secondary training fit.',
          '[{"sourceId":"source-high","summary":"Training evidence."}]',
          '[]',
          'Consider training angle if consulting is not a fit',
          'run-second',
          '{}',
          ?1,
          ?1
        )
    `).run(now);

    const rebuilt = await api("/api/kindling/top-targets/rebuild", {
      method: "POST",
      body: { reason: "Focused top target test" },
    });
    expect(rebuilt.res.status).toBe(201);
    expect(rebuilt.payload.run).toMatchObject({
      status: "complete",
      candidateCount: 2,
      rankedCount: 2,
      scoreVersion: "top-target-v1",
    });
    expect(rebuilt.payload.targets.map((target: { companyId: string }) => target.companyId)).toEqual(["top-high", "top-low"]);
    expect(rebuilt.payload.targets[0]).toMatchObject({
      reason: "Strong owner-led advisory fit for AI consulting.",
      bestOffering: {
        id: "service-high",
        name: "AI consulting",
        variantKey: "scale",
      },
      confidence: 0.82,
      caveats: [],
      nextAction: "Review for outreach positioning",
    });
    expect(rebuilt.payload.targets[0].scoreJson.secondBestAssessmentScore).toBe(76);
    expect(rebuilt.payload.targets[1].flags).toContain("low_confidence");
    expect(rebuilt.payload.targets[1].flags).toContain("high_caveat");
    expect(rebuilt.payload.targets[1].score).toBeLessThan(rebuilt.payload.targets[0].score);

    const latest = await api("/api/kindling/top-targets");
    expect(latest.payload).toMatchObject({
      source: "top_targets",
      rebuilt: false,
      targetListRunId: rebuilt.payload.targetListRunId,
    });
    expect(latest.payload.targets).toHaveLength(2);

    const today = await api("/api/kindling/todays-targets");
    expect(today.payload).toMatchObject({
      source: "top_targets",
      targetListRunId: rebuilt.payload.targetListRunId,
    });
    expect(db.query("SELECT data_ring FROM companies WHERE id = 'top-high'").get()).toEqual({ data_ring: "scored" });
    expect(db.query("SELECT data_ring FROM companies WHERE id = 'top-low'").get()).toEqual({ data_ring: "scored" });
    expect(db.query("SELECT COUNT(*) AS count FROM target_list_runs").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM target_list_items").get()).toEqual({ count: 2 });
  });

  test("read-through top-target rebuild scores all assessments before limiting the response", async () => {
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-1', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('profile-version-1', 'profile-1', 1, '{}', 'Adapt services', 'Initial test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('service-a', 'profile-version-1', 'advisory', 'Advisory', 'base', '{}', 'active', ?1, ?1),
        ('service-b', 'profile-version-1', 'automation', 'Automation', 'base', '{}', 'active', ?1, ?1),
        ('service-c', 'profile-version-1', 'training', 'Training', 'base', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES
        ('limit-strong', 'Limit Strong Co', 'Perth', 'Accounting advisory', 'https://limit-strong.example', 'scored', 'unique', 'complete', 0.9, '{"contactPaths":["contact form"]}', ?1, ?1),
        ('limit-medium', 'Limit Medium Co', 'Perth', 'Advisory', 'https://limit-medium.example', 'scored', 'unique', 'complete', 0.72, '{"contactPaths":["email"]}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO sources(
        id, company_id, source_type, url, title, summary, extracted_data_json, confidence, last_checked_at, terms_notes, created_at
      )
      VALUES
        ('limit-source-strong', 'limit-strong', 'web', 'https://limit-strong.example/about', 'About', 'Strong fit evidence.', '{}', 0.95, ?1, '', ?1),
        ('limit-source-medium', 'limit-medium', 'web', 'https://limit-medium.example/about', 'About', 'Medium fit evidence.', '{}', 0.7, ?1, '', ?1)
    `).run(now);
    db.query(`
      INSERT INTO kindling_pipeline_runs(
        id, role_key, local_request_id, status, webhook_token, trigger_payload_json, result_payload_json, created_at, updated_at
      )
      VALUES
        ('limit-run-old', 'score_company_service_fit', 'limit-request-old', 'complete', 'limit-token-old', '{}', '{}', ?1, ?1),
        ('limit-run-best', 'score_company_service_fit', 'limit-request-best', 'complete', 'limit-token-best', '{}', '{}', ?1, ?1),
        ('limit-run-medium', 'score_company_service_fit', 'limit-request-medium', 'complete', 'limit-token-medium', '{}', '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_fit_assessments(
        id, company_id, service_offering_id, market_profile_version_id, score, band, confidence,
        drivers_json, fit_explanation, evidence_json, caveats_json, recommended_action,
        source_run_id, assessment_json, created_at, updated_at
      )
      VALUES
        (
          'limit-assessment-old', 'limit-strong', 'service-a', 'profile-version-1', 30, 'low', 0.25,
          '[{"reason":"Stale weak fit"}]',
          'Weak older fit.',
          '[]',
          '["Evidence gap"]',
          'Review evidence before action',
          'limit-run-old',
          '{}',
          ?1,
          ?1 + 3000
        ),
        (
          'limit-assessment-best', 'limit-strong', 'service-b', 'profile-version-1', 94, 'high', 0.92,
          '[{"reason":"Strong automation fit"}]',
          'Strong automation fit.',
          '[{"sourceId":"limit-source-strong","summary":"Strong fit evidence."}]',
          '[]',
          'Review for outreach positioning',
          'limit-run-best',
          '{}',
          ?1,
          ?1 + 2000
        ),
        (
          'limit-assessment-medium', 'limit-medium', 'service-c', 'profile-version-1', 72, 'medium', 0.7,
          '[{"reason":"Training fit"}]',
          'Medium training fit.',
          '[{"sourceId":"limit-source-medium","summary":"Medium fit evidence."}]',
          '[]',
          'Review training angle',
          'limit-run-medium',
          '{}',
          ?1,
          ?1 + 1000
        )
    `).run(now);

    const latest = await api("/api/kindling/top-targets?limit=1");
    expect(latest.res.status).toBe(200);
    expect(latest.payload).toMatchObject({
      source: "top_targets",
      rebuilt: true,
    });
    expect(latest.payload.run).toMatchObject({
      candidateCount: 2,
      rankedCount: 2,
    });
    expect(latest.payload.targets).toHaveLength(1);
    expect(latest.payload.targets[0]).toMatchObject({
      companyId: "limit-strong",
      serviceFitAssessmentId: "limit-assessment-best",
      bestOffering: {
        id: "service-b",
      },
    });
    expect(latest.payload.targets[0].scoreJson.secondBestAssessmentScore).toBe(30);
    expect(db.query("SELECT COUNT(*) AS count FROM target_list_items WHERE target_list_run_id = ?1").get(latest.payload.targetListRunId)).toEqual({ count: 2 });
    expect(db.query("SELECT data_ring FROM companies WHERE id = 'limit-strong'").get()).toEqual({ data_ring: "scored" });
    expect(db.query("SELECT data_ring FROM companies WHERE id = 'limit-medium'").get()).toEqual({ data_ring: "scored" });
  });

  test("uses the selected offering version as service-fit scoring context", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: { autopilotUrl: "https://rick.runwingman.com" },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('profile-1', 'Adapt profile', 'profile-version-2', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES
        ('profile-version-1', 'profile-1', 1, '{"services":[{"key":"legacy","name":"Legacy service"}]}', 'Old Adapt services', 'Old profile', '[]', ?1),
        ('profile-version-2', 'profile-1', 2, '{"services":[{"key":"current","name":"Current service"}]}', 'Current Adapt services', 'Current profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('service_offering:profile-version-1:legacy:base', 'profile-version-1', 'legacy', 'Legacy service', '', '{}', 'active', ?1, ?1),
        ('service_offering:profile-version-2:current:base', 'profile-version-2', 'current', 'Current service', '', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES ('company-old-offering', 'Company Old Offering', 'Perth', 'Advisory', 'https://old-offering.example', 'enhanced', 'unknown', 'complete', 0.8, '{}', ?1, ?1)
    `).run(now);

    const trigger = await api("/api/kindling/service-assessments", {
      method: "POST",
      body: {
        companyId: "company-old-offering",
        serviceOfferingId: "service_offering:profile-version-1:legacy:base",
        deferAutopilotAuth: true,
      },
    });
    expect(trigger.res.status).toBe(202);
    const input = (trigger.payload.triggerRequest as {
      body: { input: { marketProfileVersionId: string; localContext: Record<string, unknown> } };
    }).body.input;
    expect(input.marketProfileVersionId).toBe("profile-version-1");
    expect(input.localContext.marketProfileVersion).toMatchObject({
      id: "profile-version-1",
      summary: "Old Adapt services",
    });
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
    expect(payload.scanContext.coverageSlices[0]).toMatchObject({
      geographyText: "Perth",
      sourceFamily: "web",
      strategyType: "google",
      currentCounts: {
        found: 1,
        executedAttempts: 1,
      },
    });
    const linkedAttempt = db.query("SELECT coverage_slice_id, geography_id FROM scan_strategy_attempts WHERE id = 'strategy-context'")
      .get() as Record<string, unknown>;
    expect(String(linkedAttempt.coverage_slice_id ?? "")).not.toBe("");
    expect(String(linkedAttempt.geography_id ?? "")).toBe("geo-perth");
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
    const coverage = db.query("SELECT current_counts_json, yield_metrics_json FROM coverage_slices WHERE strategy_type = 'directory'").get() as Record<string, string>;
    expect(JSON.parse(coverage.current_counts_json)).toMatchObject({ found: 1, executedAttempts: 1 });
    expect(JSON.parse(coverage.yield_metrics_json)).toMatchObject({ executedAttempts: 1, resultCount: 1 });
    const plannedCoverageCount = db.query("SELECT COUNT(*) AS count FROM coverage_slices WHERE strategy_type IN ('association', 'registry')").get() as { count: number };
    expect(plannedCoverageCount.count).toBe(0);
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

  test("keeps coverage rollups scoped to each executed strategy in one scan job", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('coverage-multi-strategy', 'Accounting', 'Leederville', 'queued', 1, 1)").run();
    const path = "/api/nip98/kindling/scan-results";
    const body = {
      requestId: "coverage-multi-strategy",
      result: {
        outputKind: "target_scan_result",
        industry: "Accounting",
        location: "Leederville",
        companies: [
          { name: "Google Slice Co", website: "https://google-slice.example", confidence: 0.8 },
          { name: "Directory Slice Co", website: "https://directory-slice.example", confidence: 0.7 },
        ],
        searchSlices: [
          { industry: "Accounting", location: "Leederville", sourceFamily: "web_search", strategyType: "google", query: "accountants Leederville", status: "searched", resultCount: 1 },
          { industry: "Accounting", location: "Leederville", sourceFamily: "directory", strategyType: "directory", query: "Xero advisors Leederville", status: "searched", resultCount: 1 },
          { industry: "Accounting", location: "Leederville", sourceFamily: "association", strategyType: "association", query: "CPA Leederville next", status: "planned", resultCount: 0 },
        ],
        plannedNextStrategies: [
          { industry: "Accounting", location: "Leederville", sourceFamily: "registry", strategyType: "registry", query: "TPB Leederville suburb pass", status: "planned", resultCount: 0 },
        ],
      },
    };
    const result = await api(path, { method: "POST", body, headers: nip98Headers(path, "POST", body) });
    expect(result.res.status).toBe(200);

    const attempts = db.query("SELECT strategy_type, result_count FROM scan_strategy_attempts ORDER BY strategy_type ASC").all() as Record<string, unknown>[];
    expect(attempts).toEqual([
      { strategy_type: "directory", result_count: 1 },
      { strategy_type: "google", result_count: 1 },
    ]);

    const slices = db.query(`
      SELECT source_family, strategy_type, current_counts_json, yield_metrics_json
      FROM coverage_slices
      WHERE geography_text = 'Leederville'
      ORDER BY strategy_type ASC
    `).all() as Record<string, string>[];
    expect(slices).toHaveLength(2);
    const byStrategy = Object.fromEntries(slices.map((slice) => [slice.strategy_type, slice]));
    for (const strategyType of ["directory", "google"]) {
      expect(JSON.parse(byStrategy[strategyType].current_counts_json)).toMatchObject({
        found: 1,
        unique: 1,
        executedAttempts: 1,
      });
      expect(JSON.parse(byStrategy[strategyType].yield_metrics_json)).toMatchObject({
        executedAttempts: 1,
        resultCount: 1,
        netNewCompanies: 1,
      });
    }
    expect(byStrategy.google.source_family).toBe("web_search");
    expect(byStrategy.directory.source_family).toBe("directory");
    const plannedCoverageCount = db.query("SELECT COUNT(*) AS count FROM coverage_slices WHERE strategy_type IN ('association', 'registry')").get() as { count: number };
    expect(plannedCoverageCount.count).toBe(0);
  });

  test("keeps coverage slices durable across multiple scan jobs", async () => {
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('coverage-job-1', 'Accounting', 'Subiaco', 'queued', 1, 1)").run();
    db.query("INSERT INTO discovery_jobs(id, industry, location, status, created_at, updated_at) VALUES ('coverage-job-2', 'Accounting', 'Subiaco', 'queued', 2, 2)").run();
    const path = "/api/nip98/kindling/scan-results";
    const bodyOne = {
      requestId: "coverage-job-1",
      result: {
        outputKind: "target_scan_result",
        industry: "Accounting",
        location: "Subiaco",
        companies: [{ name: "Coverage One", website: "https://coverage-one.example", confidence: 0.8 }],
        searchSlices: [{ industry: "Accounting", location: "Subiaco", strategyType: "directory", query: "accountants Subiaco directory page 1", status: "searched", resultCount: 1 }],
      },
    };
    const bodyTwo = {
      requestId: "coverage-job-2",
      result: {
        outputKind: "target_scan_result",
        industry: "Accounting",
        location: "Subiaco",
        companies: [{ name: "Coverage Two", website: "https://coverage-two.example", confidence: 0.7 }],
        searchSlices: [{ industry: "Accounting", location: "Subiaco", strategyType: "directory", query: "accountants Subiaco directory page 2", status: "searched", resultCount: 1 }],
      },
    };
    const first = await api(path, { method: "POST", body: bodyOne, headers: nip98Headers(path, "POST", bodyOne) });
    const second = await api(path, { method: "POST", body: bodyTwo, headers: nip98Headers(path, "POST", bodyTwo) });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);

    const slices = db.query(`
      SELECT id, current_counts_json, yield_metrics_json
      FROM coverage_slices
      WHERE geography_text = 'Subiaco'
        AND source_family = 'directory'
        AND strategy_type = 'directory'
    `).all() as Record<string, string>[];
    expect(slices).toHaveLength(1);
    expect(JSON.parse(slices[0].current_counts_json)).toMatchObject({
      found: 2,
      unique: 2,
      executedAttempts: 2,
    });
    expect(JSON.parse(slices[0].yield_metrics_json)).toMatchObject({
      executedAttempts: 2,
      resultCount: 2,
      netNewCompanies: 2,
    });
    const linkedJobs = db.query("SELECT COUNT(DISTINCT discovery_job_id) AS count FROM scan_strategy_attempts WHERE coverage_slice_id = ?1")
      .get(slices[0].id) as { count: number };
    expect(linkedJobs.count).toBe(2);
  });

  test("returns coverage slices with SQLite-backed counts and separate recommendations", async () => {
    const now = Date.now();
    const segmentId = "adapt-tier-1-accounting-tax-bookkeeping-business-advisory";
    db.query(`
      INSERT INTO target_geographies(id, parent_id, label, kind, canonical_key, status, created_at, updated_at)
      VALUES ('geo-perth', NULL, 'Perth', 'search_text', 'perth', 'active', ?1, ?1)
      ON CONFLICT(canonical_key) DO NOTHING
    `).run(now);
    db.query(`
      INSERT INTO coverage_slices(
        id, segment_id, geography_id, geography_text, source_family, strategy_type, status,
        target_counts_json, current_counts_json, yield_metrics_json, created_at, updated_at
      )
      VALUES ('coverage-api-slice', ?1, 'geo-perth', 'Perth', 'directory', 'directory', 'active', '{"found":10}', '{}', '{}', ?2, ?2)
    `).run(segmentId, now);
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('coverage-unique', 'Coverage Unique', 'Perth', 'Accounting', 'https://unique.example', 'found', 'unique', 'not_started', 0.7, '{}', ?1, ?1),
        ('coverage-duplicate', 'Coverage Duplicate', 'Perth', 'Accounting', 'https://duplicate.example', 'found', 'duplicate', 'not_started', 0.7, '{}', ?1, ?1),
        ('coverage-weak', 'Coverage Weak', 'Perth', 'Accounting', '', 'found', 'unknown', 'not_started', 0.2, '{}', ?1, ?1),
        ('coverage-enhanced', 'Coverage Enhanced', 'Perth', 'Accounting', 'https://enhanced.example', 'enhanced', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('coverage-scored', 'Coverage Scored', 'Perth', 'Accounting', 'https://scored.example', 'scored', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('coverage-outreach', 'Coverage Outreach', 'Perth', 'Accounting', 'https://outreach.example', 'outreach_ready', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('coverage-parked', 'Coverage Parked', 'Perth', 'Accounting', 'https://parked.example', 'parked', 'unknown', 'not_started', 0.4, '{}', ?1, ?1),
        ('coverage-stale', 'Coverage Stale', 'Perth', 'Accounting', 'https://stale.example', 'stale', 'unknown', 'not_started', 0.4, '{}', ?1, ?1)
    `).run(now);
    const membership = db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES (?1, ?2, 0.9, 'test', ?3)
    `);
    for (const companyId of [
      "coverage-unique",
      "coverage-duplicate",
      "coverage-weak",
      "coverage-enhanced",
      "coverage-scored",
      "coverage-outreach",
      "coverage-parked",
      "coverage-stale",
    ]) {
      membership.run(companyId, segmentId, now);
    }
    const source = db.query(`
      INSERT INTO sources(id, company_id, source_type, url, summary, confidence, created_at)
      VALUES (?1, ?2, 'test', ?3, 'Test source', 0.9, ?4)
    `);
    for (const companyId of [
      "coverage-unique",
      "coverage-duplicate",
      "coverage-enhanced",
      "coverage-scored",
      "coverage-outreach",
      "coverage-parked",
      "coverage-stale",
    ]) {
      source.run(`source-${companyId}`, companyId, `https://${companyId}.example`, now);
    }
    db.query(`
      INSERT INTO discovery_jobs(id, industry, location, segment_id, geography_id, geography_text, coverage_slice_id, status, created_at, updated_at)
      VALUES ('coverage-api-job', 'Accounting', 'Perth', ?1, 'geo-perth', 'Perth', 'coverage-api-slice', 'complete', ?2, ?2)
    `).run(segmentId, now);
    db.query(`
      INSERT INTO scan_strategy_attempts(
        id, discovery_job_id, segment_id, geography_id, geography_text, coverage_slice_id, source_family,
        industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at
      )
      VALUES ('coverage-api-attempt', 'coverage-api-job', ?1, 'geo-perth', 'Perth', 'coverage-api-slice', 'directory',
        'Accounting', 'Perth', 'directory', 'accountants Perth directory', 'searched', 8, '', '{}', ?2)
    `).run(segmentId, now);
    seedKindlingRun("scan_target_list", "coverage-api-job", "coverage-api-token");
    db.query(`
      UPDATE kindling_pipeline_runs
      SET status = 'complete',
          result_payload_json = ?1,
          updated_at = ?2
      WHERE id = 'run-coverage-api-job'
    `).run(JSON.stringify({
      requestId: "coverage-api-job",
      role: "scan_target_list",
      result: {
        outputKind: "target_scan_result",
        industry: "Accounting",
        location: "Perth",
        plannedNextStrategies: [
          { segmentId, geographyText: "Perth", sourceFamily: "directory", strategyType: "directory", query: "accountants Perth page 2", status: "planned" },
        ],
      },
    }), now);

    const coverage = await api("/api/kindling/coverage-slices");
    expect(coverage.res.status).toBe(200);
    const slice = coverage.payload.slices.find((entry: { id: string }) => entry.id === "coverage-api-slice");
    expect(slice.currentCounts).toEqual({
      found: 8,
      unique: 1,
      duplicate: 1,
      weakSource: 1,
      enriched: 3,
      scored: 2,
      outreachReady: 1,
      parked: 1,
      stale: 1,
    });
    expect(slice.attempts).toMatchObject({
      executed: 1,
      resultCount: 8,
      planned: 0,
      recommended: 1,
    });
    expect(coverage.payload.recommendations[0]).toMatchObject({
      executed: false,
      recommended: true,
      query: "accountants Perth page 2",
    });
    const bySegment = coverage.payload.bySegment.find((entry: { segmentId: string }) => entry.segmentId === segmentId);
    expect(bySegment.currentCounts.found).toBe(8);
    const byGeography = coverage.payload.byGeography.find((entry: { geographyText: string }) => entry.geographyText === "Perth");
    expect(byGeography.currentCounts.found).toBe(8);

    const summary = await api("/api/kindling/summary");
    expect(summary.payload.coverage.totals).toMatchObject({
      found: 8,
      weakSource: 1,
      outreachReady: 1,
    });
    expect(summary.payload.counts.coverageExecutedAttempts).toBe(1);
    expect(summary.payload.counts.coverageRecommendedStrategies).toBe(1);
  });

  test("patches coverage slice scheduler-visible fields", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO coverage_slices(
        id, geography_text, source_family, strategy_type, status,
        target_counts_json, current_counts_json, yield_metrics_json, created_at, updated_at
      )
      VALUES ('coverage-patch-slice', 'Perth', 'web', 'search', 'active', '{}', '{}', '{}', ?1, ?1)
    `).run(now);

    const patched = await api("/api/kindling/coverage-slices/coverage-patch-slice", {
      method: "PATCH",
      body: {
        status: "paused",
        targetCounts: { found: 25, enriched: 8, scored: 3, outreachReady: 1 },
        nextRunAfterAt: now + 60_000,
        stalledReason: "waiting for scheduler",
      },
    });
    expect(patched.res.status).toBe(200);
    expect(patched.payload.slice).toMatchObject({
      id: "coverage-patch-slice",
      status: "paused",
      targetCounts: { found: 25, enriched: 8, scored: 3, outreachReady: 1 },
      nextRunAfterAt: now + 60_000,
      stalledReason: "waiting for scheduler",
    });
    const row = db.query("SELECT status, target_counts_json, next_run_after_at, stalled_reason FROM coverage_slices WHERE id = 'coverage-patch-slice'")
      .get() as Record<string, unknown>;
    expect(row.status).toBe("paused");
    expect(JSON.parse(String(row.target_counts_json))).toEqual({ found: 25, enriched: 8, scored: 3, outreachReady: 1 });
    expect(row.next_run_after_at).toBe(now + 60_000);
  });

  test("persists scheduler settings through SQLite-backed API", async () => {
    const initial = await api("/api/kindling/scheduler-settings");
    expect(initial.res.status).toBe(200);
    expect(initial.payload.settings).toMatchObject({
      enabled: false,
      targetPoolSize: 10000,
      enrichedFloor: 50,
      topTargetCount: 100,
    });
    expect(initial.payload.settings.perRoleConcurrency.score_company_service_fit).toBe(20);

    const patched = await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        acquisitionEnabled: true,
        enrichmentEnabled: false,
        scoringEnabled: true,
        outreachEnabled: false,
        targetPoolSize: 12000,
        enrichedFloor: 75,
        topTargetCount: 80,
        perRoleConcurrency: {
          scan_target_list: 2,
          enrich_company: 3,
          draft_outreach: 1,
        },
        cooldowns: {
          acquisitionMs: 3_600_000,
          enrichmentMs: 1_800_000,
          outreachMs: 900_000,
        },
      },
    });
    expect(patched.res.status).toBe(200);
    expect(patched.payload.settings).toMatchObject({
      enabled: true,
      enrichmentEnabled: false,
      outreachEnabled: false,
      targetPoolSize: 12000,
      enrichedFloor: 75,
      topTargetCount: 80,
      perRoleConcurrency: {
        scan_target_list: 2,
        enrich_company: 3,
      },
      cooldowns: {
        acquisitionMs: 3_600_000,
        enrichmentMs: 1_800_000,
      },
    });

    const persisted = getSchedulerSettings();
    expect(persisted).toMatchObject({
      enabled: true,
      targetPoolSize: 12000,
      enrichedFloor: 75,
      topTargetCount: 80,
    });
    const row = db.query("SELECT target_pool_size, enriched_floor, top_target_count FROM scheduler_settings WHERE id = 'default'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      target_pool_size: 12000,
      enriched_floor: 75,
      top_target_count: 80,
    });
  });

  test("summary reports enriched companies and scored companies separately", async () => {
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('summary-profile', 'Adapt profile', 'summary-profile-version', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('summary-profile-version', 'summary-profile', 1, '{}', 'Adapt services', 'Scoring test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at)
      VALUES ('summary-offering', 'summary-profile-version', 'advisory', 'Advisory', 'base', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('summary-enriched', 'Summary Enriched', 'Perth', 'Accounting', 'https://enriched.example', 'enhanced', 'unique', 'complete', 0.8, '{}', ?1, ?1),
        ('summary-scored', 'Summary Scored', 'Perth', 'Advisory', 'https://scored.example', 'scored', 'unique', 'complete', 0.9, '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO kindling_pipeline_runs(id, role_key, local_request_id, status, webhook_token, trigger_payload_json, result_payload_json, created_at, updated_at)
      VALUES ('summary-score-run', 'score_company_service_fit', 'summary-score-request', 'complete', 'token', '{}', '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_fit_assessments(
        id, company_id, service_offering_id, market_profile_version_id, score, band, confidence,
        drivers_json, fit_explanation, evidence_json, caveats_json, recommended_action, source_run_id,
        assessment_json, created_at, updated_at
      )
      VALUES ('summary-assessment', 'summary-scored', 'summary-offering', 'summary-profile-version', 82, 'high', 0.8, '[]', 'Good fit', '[]', '[]', 'Review', 'summary-score-run', '{}', ?1, ?1)
    `).run(now);

    const summary = await api("/api/kindling/summary?compact=1");
    expect(summary.payload.counts).toMatchObject({
      companies: 2,
      enriched: 2,
      scored: 1,
      serviceFitAssessments: 1,
      outreachReady: 0,
    });
  });

  test("records scheduler run decisions and prevents concurrent active leases", async () => {
    const skipped = createSchedulerRun({
      id: "scheduler-skip",
      status: "skipped",
      skipReason: "scheduler disabled",
      context: { enabled: false },
      now: 10_000,
    });
    expect(skipped).toMatchObject({
      id: "scheduler-skip",
      status: "skipped",
      selectedAction: "",
      skipReason: "scheduler disabled",
    });

    const selected = createSchedulerRun({
      id: "scheduler-action",
      status: "running",
      selectedAction: "scan_target_list",
      roleKey: "scan_target_list",
      localRequestId: "scan-request",
      context: { segmentId: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory" },
      now: 20_000,
    });
    expect(selected).toMatchObject({
      selectedAction: "scan_target_list",
      roleKey: "scan_target_list",
      localRequestId: "scan-request",
    });

    const firstLock = acquireSchedulerLock({
      lockKey: "prospecting",
      runId: "scheduler-action",
      ownerId: "worker-a",
      leaseMs: 60_000,
      now: 20_000,
    });
    expect(firstLock).toMatchObject({
      lockKey: "prospecting",
      runId: "scheduler-action",
      ownerId: "worker-a",
      leaseExpiresAt: 80_000,
    });

    createSchedulerRun({
      id: "scheduler-action-2",
      status: "running",
      selectedAction: "scan_target_list",
      now: 30_000,
    });
    const duplicateLock = acquireSchedulerLock({
      lockKey: "prospecting",
      runId: "scheduler-action-2",
      ownerId: "worker-b",
      leaseMs: 60_000,
      now: 30_000,
    });
    expect(duplicateLock).toBeNull();

    const renewedAfterExpiry = acquireSchedulerLock({
      lockKey: "prospecting",
      runId: "scheduler-action-2",
      ownerId: "worker-b",
      leaseMs: 60_000,
      now: 90_000,
    });
    expect(renewedAfterExpiry).toMatchObject({
      lockKey: "prospecting",
      runId: "scheduler-action-2",
      ownerId: "worker-b",
    });

    const apiState = await api("/api/kindling/scheduler-settings");
    expect(apiState.res.status).toBe(200);
    expect(apiState.payload.activeLock).toMatchObject({
      runId: "scheduler-action-2",
      ownerId: "worker-b",
    });
    expect(apiState.payload.recentRuns.map((run: { id: string }) => run.id)).toEqual([
      "scheduler-action-2",
      "scheduler-action",
      "scheduler-skip",
    ]);
  });

  test("dry-runs scheduler disabled without mutating target work", async () => {
    const dryRun = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(dryRun.res.status).toBe(200);
    expect(dryRun.payload.decision).toMatchObject({
      dryRun: true,
      workAvailable: false,
      action: "no_work",
      reason: "scheduler is disabled",
    });
    expect(dryRun.payload.run).toMatchObject({
      runType: "dry_run",
      status: "skipped",
      skipReason: "scheduler is disabled",
      result: {
        dryRun: true,
      },
    });
    const counts = db.query(`
      SELECT
        (SELECT COUNT(*) FROM kindling_pipeline_runs) AS pipeline_runs,
        (SELECT COUNT(*) FROM discovery_jobs) AS discovery_jobs,
        (SELECT COUNT(*) FROM enrichment_requests) AS enrichment_requests,
        (SELECT COUNT(*) FROM outreach_drafts) AS outreach_drafts
    `).get() as Record<string, number>;
    expect(counts).toEqual({
      pipeline_runs: 0,
      discovery_jobs: 0,
      enrichment_requests: 0,
      outreach_drafts: 0,
    });
  });

  test("dry-runs deterministic acquisition selection without creating pipeline work", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true },
    });
    const first = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    const second = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(first.res.status).toBe(200);
    expect(second.res.status).toBe(200);
    const compactDecision = (payload: Record<string, unknown>) => {
      const decision = payload.decision as Record<string, unknown>;
      const item = decision.item as Record<string, unknown>;
      return {
        action: decision.action,
        roleKey: decision.roleKey,
        itemKind: item.kind,
        segmentId: item.segmentId,
        geographyText: item.geographyText,
      };
    };
    expect(compactDecision(first.payload)).toEqual(compactDecision(second.payload));
    expect(first.payload.decision).toMatchObject({
      workAvailable: true,
      action: "acquisition",
      roleKey: "scan_target_list",
      item: {
        kind: "acquisition_slice",
        segmentId: "adapt-tier-1-sme-advisory-referral-rich",
        geographyText: "Perth, WA",
      },
    });
    expect(first.payload.run).toMatchObject({
      runType: "dry_run",
      status: "complete",
      selectedAction: "acquisition",
      roleKey: "scan_target_list",
    });
    const counts = db.query(`
      SELECT
        (SELECT COUNT(*) FROM kindling_pipeline_runs) AS pipeline_runs,
        (SELECT COUNT(*) FROM discovery_jobs) AS discovery_jobs
    `).get() as Record<string, number>;
    expect(counts).toEqual({ pipeline_runs: 0, discovery_jobs: 0 });
  });

  test("scheduler preview returns next decision without writing an audit run", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    seedSchedulerAcquisitionSlice("scheduler-preview-slice");

    const preview = await api("/api/kindling/scheduler/preview");
    expect(preview.res.status).toBe(200);
    expect(preview.payload.decision).toMatchObject({
      workAvailable: true,
      action: "acquisition",
      roleKey: "scan_target_list",
      item: {
        coverageSliceId: "scheduler-preview-slice",
      },
    });
    expect(db.query("SELECT COUNT(*) AS count FROM scheduler_runs").get()).toEqual({ count: 0 });
  });

  test("scheduler preview only advertises executable prospecting actions", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        acquisitionEnabled: false,
        enrichmentEnabled: true,
        scoringEnabled: false,
        outreachEnabled: true,
      },
    });
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('preview-enrich-company', 'Preview Enrich Co', 'Perth', 'Accounting', 'https://preview-enrich.example', 'found', 'unique', 'not_started', 0.7, '{}', 10, 10)
    `).run();

    const preview = await api("/api/kindling/scheduler/preview");
    expect(preview.payload.decision).toMatchObject({
      workAvailable: false,
      action: "no_work",
      roleKey: null,
      reason: "no executable automated prospecting work is available",
    });
    expect(preview.payload.decision.evaluatedRoles.map((role: { action: string }) => role.action)).toEqual([
      "acquisition",
      "scoring",
    ]);
  });

  test("dry-run acquisition selector uses source-backed deficits and skips parked or cooling slices", async () => {
    const now = Date.now();
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0, stalledSliceMs: 60_000 },
      },
    });
    db.query(`
      UPDATE target_segments
      SET coverage_targets_json = '{"found":0}', default_target_count = 0
      WHERE id = 'adapt-tier-1-sme-advisory-referral-rich'
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 1, status = 'parked'
      WHERE id = 'adapt-tier-2-owner-led-professional-services'
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 2
      WHERE id = 'adapt-tier-1-sme-legal-commercial-succession'
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 11
      WHERE id = 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory'
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 40
      WHERE tier = 1
        AND id NOT IN (
          'adapt-tier-1-sme-advisory-referral-rich',
          'adapt-tier-1-accounting-tax-bookkeeping-business-advisory',
          'adapt-tier-1-sme-legal-commercial-succession'
        )
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 11, coverage_targets_json = '{"found":0}', default_target_count = 0
      WHERE id = 'adapt-tier-3-operational-smes-scale-pain'
    `).run();

    const insertSlice = db.query(`
      INSERT INTO coverage_slices(
        id, segment_id, geography_id, geography_text, source_family, strategy_type, status,
        target_counts_json, current_counts_json, yield_metrics_json, last_run_at, created_at, updated_at
      )
      VALUES (?1, ?2, NULL, ?3, 'directory', 'directory', ?4, ?5, '{}', ?6, ?7, ?8, ?8)
    `);
    insertSlice.run(
      "coverage-parked-high-priority",
      "adapt-tier-2-owner-led-professional-services",
      "Perth",
      "active",
      '{"found":100}',
      "{}",
      null,
      now,
    );
    insertSlice.run(
      "coverage-low-yield-cooling",
      "adapt-tier-1-sme-legal-commercial-succession",
      "Perth",
      "stalled",
      '{"found":100}',
      '{"executedAttempts":1,"resultCount":0,"averageResultCount":0,"netNewCompanies":0,"blockedAttempts":1}',
      now - 1_000,
      now,
    );
    insertSlice.run(
      "coverage-non-perth-tie",
      "adapt-tier-3-operational-smes-scale-pain",
      "Sydney",
      "active",
      '{"found":10}',
      "{}",
      null,
      now,
    );
    insertSlice.run(
      "coverage-accounting-perth",
      "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
      "Perth",
      "active",
      '{"found":10}',
      "{}",
      null,
      now,
    );

    const company = db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, 'Perth', 'Accounting', '', 'found', 'unique', 'not_started', 0.7, '{}', ?3, ?3)
    `);
    const membership = db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES (?1, 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 0.9, 'test', ?2)
    `);
    for (let index = 0; index < 10; index += 1) {
      const companyId = `weak-accounting-${index}`;
      company.run(companyId, `Weak Accounting ${index}`, now);
      membership.run(companyId, now);
    }

    const dryRun = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(dryRun.res.status).toBe(200);
    expect(dryRun.payload.decision).toMatchObject({
      workAvailable: true,
      action: "acquisition",
      roleKey: "scan_target_list",
      item: {
        kind: "acquisition_slice",
        coverageSliceId: "coverage-accounting-perth",
        segmentId: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
        geographyText: "Perth",
        currentCounts: {
          found: 10,
          sourceBackedUnique: 0,
        },
        deficit: {
          targetFound: 10,
          sourceBackedUnique: 10,
        },
        selection: {
          source: "coverage_slice",
          preferredTier1Perth: true,
        },
      },
    });
    expect(String(dryRun.payload.decision.reason)).toContain("source-backed unique prospects");

    const audit = db.query("SELECT result_json FROM scheduler_runs ORDER BY created_at DESC LIMIT 1").get() as Record<string, string>;
    const result = JSON.parse(audit.result_json);
    expect(result.decision.item).toMatchObject({
      coverageSliceId: "coverage-accounting-perth",
      deficit: { sourceBackedUnique: 10 },
    });
    const counts = db.query(`
      SELECT
        (SELECT COUNT(*) FROM kindling_pipeline_runs) AS pipeline_runs,
        (SELECT COUNT(*) FROM discovery_jobs) AS discovery_jobs
    `).get() as Record<string, number>;
    expect(counts).toEqual({ pipeline_runs: 0, discovery_jobs: 0 });
  });

  test("run-once starts exactly one scheduled acquisition target-scan job", async () => {
    const now = Date.now();
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    db.query(`
      UPDATE target_segments
      SET coverage_targets_json = '{"found":0}', default_target_count = 0
      WHERE id = 'adapt-tier-1-sme-advisory-referral-rich'
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 1
      WHERE id = 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory'
    `).run();
    db.query(`
      INSERT INTO coverage_slices(
        id, segment_id, geography_id, geography_text, source_family, strategy_type, status,
        target_counts_json, current_counts_json, yield_metrics_json, created_at, updated_at
      )
      VALUES (
        'scheduler-acquisition-slice',
        'adapt-tier-1-accounting-tax-bookkeeping-business-advisory',
        NULL,
        'Perth',
        'directory',
        'directory',
        'active',
        '{"found":15}',
        '{}',
        '{}',
        ?1,
        ?1
      )
    `).run(now);
    db.query(`
      INSERT INTO discovery_jobs(id, industry, location, segment_id, geography_text, coverage_slice_id, target_count, scan_mode, status, created_at, updated_at)
      VALUES ('prior-scheduler-scan', 'Accounting, tax, bookkeeping, and business advisory', 'Perth', 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 'Perth', 'scheduler-acquisition-slice', 15, 'interactive', 'complete', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO scan_strategy_attempts(
        id, discovery_job_id, segment_id, geography_text, coverage_slice_id, source_family,
        industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at
      )
      VALUES (
        'prior-scheduler-strategy',
        'prior-scheduler-scan',
        'adapt-tier-1-accounting-tax-bookkeeping-business-advisory',
        'Perth',
        'scheduler-acquisition-slice',
        'directory',
        'Accounting, tax, bookkeeping, and business advisory',
        'Perth',
        'directory',
        'prior accounting directory',
        'searched',
        2,
        'prior executed strategy',
        '{}',
        ?1
      )
    `).run(now);

    const started = await api("/api/kindling/scheduler/run-once?dryRun=false", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    expect(started.res.status).toBe(202);
    expect(started.payload.requiresAutopilotAuth).toBe(true);
    expect(started.payload.decision).toMatchObject({
      dryRun: false,
      workAvailable: true,
      action: "acquisition",
      roleKey: "scan_target_list",
      item: {
        coverageSliceId: "scheduler-acquisition-slice",
      },
    });
    expect(started.payload.acquisition).toMatchObject({
      coverageSliceId: "scheduler-acquisition-slice",
      targetCount: 1000,
      correlation: {
        schedulerRunId: started.payload.run.id,
        acquisitionJobId: started.payload.jobId,
        coverageSliceId: "scheduler-acquisition-slice",
        roleKey: "scan_target_list",
      },
    });
    expect(started.payload.triggerRequest.body.input).toMatchObject({
      pipelineRole: "scan_target_list",
      roleKey: "scan_target_list",
      requestId: started.payload.jobId,
      industry: "Accounting, tax, bookkeeping, and business advisory",
      location: "Perth",
      targetCount: 1000,
      localContext: {
        scheduler: {
          action: "acquisition",
          correlation: {
            schedulerRunId: started.payload.run.id,
            acquisitionJobId: started.payload.jobId,
          },
        },
        acquisition: {
          coverageSlice: {
            id: "scheduler-acquisition-slice",
            sourceFamily: "directory",
            strategyType: "directory",
          },
        },
        priorExecutedStrategies: [
          {
            query: "prior accounting directory",
            status: "searched",
          },
        ],
        writeApi: {
          url: "http://kindling.test/api/kindling/pipeline-write/target-scan",
          authHeader: "x-kindling-pipeline-token",
        },
      },
      webhook: {
        url: "http://kindling.test/api/kindling/pipeline-webhook",
        authHeader: "x-kindling-pipeline-token",
      },
    });
    const coverage = db.query("SELECT target_counts_json FROM coverage_slices WHERE id = 'scheduler-acquisition-slice'")
      .get() as Record<string, string>;
    expect(JSON.parse(coverage.target_counts_json).found).toBe(1000);

    const counts = db.query(`
      SELECT
        (SELECT COUNT(*) FROM scheduler_runs WHERE status = 'running' AND selected_action = 'acquisition') AS scheduler_runs,
        (SELECT COUNT(*) FROM scheduler_locks) AS scheduler_locks,
        (SELECT COUNT(*) FROM kindling_pipeline_runs WHERE role_key = 'scan_target_list') AS pipeline_runs,
        (SELECT COUNT(*) FROM discovery_jobs WHERE summary LIKE 'Queued by scheduler run%') AS discovery_jobs
    `).get() as Record<string, number>;
    expect(counts).toEqual({
      scheduler_runs: 1,
      scheduler_locks: 1,
      pipeline_runs: 1,
      discovery_jobs: 1,
    });
  });

  test("scheduled segment-default acquisition requests one thousand prospects and clears stale active scan blockers", async () => {
    const now = Date.now();
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    db.query(`
      UPDATE target_segments
      SET coverage_targets_json = '{"found":0}', default_target_count = 0
    `).run();
    db.query(`
      UPDATE target_segments
      SET priority = 1,
          coverage_targets_json = '{"found":140}',
          default_target_count = 140
      WHERE id = 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory'
    `).run();
    db.query(`
      INSERT INTO kindling_pipeline_runs(
        id, role_key, local_request_id, autopilot_run_id, status, webhook_token, trigger_payload_json, error, created_at, updated_at
      )
      VALUES (
        'stale-scan-run',
        'scan_target_list',
        'stale-scan-job',
        'remote-stale-scan',
        'running',
        'stale-token',
        '{}',
        '',
        ?1,
        ?1
      )
    `).run(now - 7 * 60 * 60 * 1000);

    const started = await api("/api/kindling/scheduler/run-once?dryRun=false", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    expect(started.res.status).toBe(202);
    expect(started.payload.decision).toMatchObject({
      workAvailable: true,
      action: "acquisition",
      roleKey: "scan_target_list",
      item: {
        segmentId: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
        selection: { source: "segment_default" },
      },
    });
    expect(started.payload.acquisition.targetCount).toBe(1000);
    expect(started.payload.triggerRequest.body.input.targetCount).toBe(1000);
    const coverage = db.query("SELECT target_counts_json FROM coverage_slices WHERE id = ?1")
      .get(String(started.payload.acquisition.coverageSliceId)) as Record<string, string>;
    expect(JSON.parse(coverage.target_counts_json).found).toBe(1000);
    const staleRun = db.query("SELECT status, error FROM kindling_pipeline_runs WHERE id = 'stale-scan-run'")
      .get() as Record<string, string>;
    expect(staleRun.status).toBe("failed");
    expect(staleRun.error).toContain("Timed out after 6 hours");
  });

  test("run-once directly triggers one scheduled acquisition Autopilot run", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
      },
    });
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    seedSchedulerAcquisitionSlice("scheduler-direct-acquisition-slice");

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      fetchCalls.push({ url: String(url), init, body });
      return Response.json({ run: { id: "remote-scheduler-direct-run", status: "running" } });
    }) as typeof fetch;
    try {
      const started = await api("/api/kindling/scheduler/run-once?dryRun=false", {
        method: "POST",
      });
      expect(started.res.status).toBe(201);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:9/api/pipelines/triggers/http/kindling-scan-target-list");
      expect(fetchCalls[0]?.init?.method).toBe("POST");
      const triggerInput = fetchCalls[0]?.body.input as Record<string, unknown>;
      expect(triggerInput).toMatchObject({
        source: "kindling-wapp",
        pipelineRole: "scan_target_list",
        roleKey: "scan_target_list",
        requestId: started.payload.jobId,
        industry: "Accounting, tax, bookkeeping, and business advisory",
        location: "Perth",
        targetCount: 1000,
        localContext: {
          scheduler: {
            action: "acquisition",
            correlation: {
              schedulerRunId: started.payload.run.id,
              acquisitionJobId: started.payload.jobId,
              coverageSliceId: "scheduler-direct-acquisition-slice",
              roleKey: "scan_target_list",
            },
          },
          acquisition: {
            coverageSlice: {
              id: "scheduler-direct-acquisition-slice",
              sourceFamily: "directory",
              strategyType: "directory",
            },
          },
          priorExecutedStrategies: [
            {
              query: "prior accounting directory",
              status: "searched",
            },
          ],
          writeApi: {
            url: "http://kindling.test/api/kindling/pipeline-write/target-scan",
            authHeader: "x-kindling-pipeline-token",
          },
        },
        webhook: {
          url: "http://kindling.test/api/kindling/pipeline-webhook",
          authHeader: "x-kindling-pipeline-token",
        },
      });
      const localContext = triggerInput.localContext as Record<string, unknown>;
      const writeApi = localContext.writeApi as Record<string, unknown>;
      expect(String(writeApi.token ?? "")).not.toBe("");

      expect(started.payload.start).toEqual({
        mode: "autopilot-http",
        runId: "remote-scheduler-direct-run",
        status: "running",
      });
      expect(started.payload.run.autopilotRunId).toBe("remote-scheduler-direct-run");
      expect(started.payload.acquisition).toMatchObject({
        coverageSliceId: "scheduler-direct-acquisition-slice",
        targetCount: 1000,
        correlation: {
          schedulerRunId: started.payload.run.id,
          acquisitionJobId: started.payload.jobId,
        },
      });

      const run = db.query(`
        SELECT status, role_key, local_request_id, autopilot_run_id
        FROM kindling_pipeline_runs
        WHERE id = ?1
      `).get(started.payload.runId) as Record<string, unknown>;
      expect(run).toEqual({
        status: "running",
        role_key: "scan_target_list",
        local_request_id: started.payload.jobId,
        autopilot_run_id: "remote-scheduler-direct-run",
      });

      const schedulerRun = db.query(`
        SELECT status, role_key, local_request_id, autopilot_run_id, finished_at, result_json
        FROM scheduler_runs
        WHERE id = ?1
      `).get(started.payload.run.id) as Record<string, unknown>;
      expect(schedulerRun).toMatchObject({
        status: "running",
        role_key: "scan_target_list",
        local_request_id: started.payload.jobId,
        autopilot_run_id: "remote-scheduler-direct-run",
        finished_at: null,
      });
      expect(JSON.parse(String(schedulerRun.result_json))).toMatchObject({
        dryRun: false,
        jobId: started.payload.jobId,
        kindlingRunId: started.payload.runId,
        autopilotRunId: "remote-scheduler-direct-run",
        triggerPayload: {
          roleKey: "scan_target_list",
          requestId: started.payload.jobId,
          correlation: {
            schedulerRunId: started.payload.run.id,
            acquisitionJobId: started.payload.jobId,
          },
        },
      });

      const lock = db.query("SELECT run_id, lock_key FROM scheduler_locks").get() as Record<string, unknown>;
      expect(lock).toEqual({ run_id: started.payload.run.id, lock_key: "prospecting" });
      const locked = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
      expect(locked.payload.decision).toMatchObject({
        workAvailable: false,
        activeLock: {
          runId: started.payload.run.id,
        },
      });
      expect(fetchCalls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("automated prospecting loop walks due acquisition slices every interval", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
      },
    });
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    seedSchedulerAcquisitionSlice("scheduler-auto-acquisition-slice");

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      fetchCalls.push({ url: String(url), init, body });
      return Response.json({ run: { id: "remote-scheduler-auto-acquisition-run", status: "running" } });
    }) as typeof fetch;
    try {
      const started = await runAutomatedProspectingLoop();
      expect(started).toMatchObject({
        action: "acquisition",
        acquisition: {
          coverageSliceId: "scheduler-auto-acquisition-slice",
          targetCount: 1000,
        },
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:9/api/pipelines/triggers/http/kindling-scan-target-list");
      const triggerInput = fetchCalls[0]?.body.input as Record<string, unknown>;
      expect(triggerInput).toMatchObject({
        source: "kindling-wapp",
        pipelineRole: "scan_target_list",
        roleKey: "scan_target_list",
        industry: "Accounting, tax, bookkeeping, and business advisory",
        location: "Perth",
        targetCount: 1000,
        userNpub: "scheduler",
        localContext: {
          scheduler: {
            action: "acquisition",
            correlation: {
              coverageSliceId: "scheduler-auto-acquisition-slice",
              roleKey: "scan_target_list",
            },
          },
          acquisition: {
            coverageSlice: {
              id: "scheduler-auto-acquisition-slice",
              sourceFamily: "directory",
              strategyType: "directory",
            },
          },
          writeApi: {
            url: expect.stringContaining("/api/kindling/pipeline-write/target-scan"),
            authHeader: "x-kindling-pipeline-token",
          },
        },
        webhook: {
          url: expect.stringContaining("/api/kindling/pipeline-webhook"),
          authHeader: "x-kindling-pipeline-token",
        },
      });
      const schedulerRun = db.query(`
        SELECT status, selected_action, role_key, autopilot_run_id, context_json
        FROM scheduler_runs
        WHERE id = ?1
      `).get(started?.schedulerRunId) as Record<string, unknown>;
      expect(schedulerRun).toMatchObject({
        status: "running",
        selected_action: "acquisition",
        role_key: "scan_target_list",
        autopilot_run_id: "remote-scheduler-auto-acquisition-run",
      });
      expect(JSON.parse(String(schedulerRun.context_json))).toMatchObject({
        automated: true,
      });
      expect(await runAutomatedProspectingLoop()).toBeNull();
      expect(fetchCalls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("run-once directly triggers one scheduled all-offerings scoring run", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
      },
    });
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        acquisitionEnabled: false,
        enrichmentEnabled: false,
        scoringEnabled: true,
        outreachEnabled: false,
        cooldowns: { scoringMs: 0 },
      },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('score-profile', 'Adapt profile', 'score-profile-version', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('score-profile-version', 'score-profile', 1, '{}', 'Adapt services', 'Scoring test profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES
        ('score-offering-a', 'score-profile-version', 'advisory', 'Advisory', 'base', '{}', 'active', ?1, ?1),
        ('score-offering-b', 'score-profile-version', 'automation', 'Automation', 'base', '{}', 'active', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at
      )
      VALUES ('scheduler-score-direct', 'Scheduler Score Direct', 'Perth', 'Accounting', 'https://score-direct.example', 'enhanced', 'unique', 'complete', 0.91, '{}', ?1, ?1)
    `).run(now);

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      fetchCalls.push({ url: String(url), init, body });
      return Response.json({ run: { id: "remote-scheduler-score-run", status: "running" } });
    }) as typeof fetch;
    try {
      const started = await api("/api/kindling/scheduler/run-once?dryRun=false", {
        method: "POST",
      });
      expect(started.res.status).toBe(201);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:9/api/pipelines/triggers/http/kindling-score-company-service-fit");
      const triggerInput = fetchCalls[0]?.body.input as Record<string, unknown>;
      expect(triggerInput).toMatchObject({
        source: "kindling-wapp",
        pipelineRole: "score_company_service_fit",
        roleKey: "score_company_service_fit",
        requestId: started.payload.requestId,
        companyId: "scheduler-score-direct",
        serviceOfferingId: "",
        marketProfileVersionId: "score-profile-version",
        localContext: {
          companyId: "scheduler-score-direct",
          serviceOfferingId: "",
          marketProfileVersionId: "score-profile-version",
          writeApi: {
            url: "http://kindling.test/api/kindling/pipeline-write/service-assessment",
            authHeader: "x-kindling-pipeline-token",
          },
        },
      });
      expect((triggerInput.localContext as { serviceOfferings: Array<Record<string, unknown>> }).serviceOfferings.map((offering) => offering.id)).toEqual([
        "score-offering-a",
        "score-offering-b",
      ]);
      expect(started.payload).toMatchObject({
        offeringCount: 2,
        start: {
          mode: "autopilot-http",
          runId: "remote-scheduler-score-run",
          status: "running",
        },
      });
      expect(db.query("SELECT status, target_id, locked_by_run_id FROM work_queue WHERE id = ?1").get(started.payload.queueId))
        .toMatchObject({
          status: "running",
          target_id: "scheduler-score-direct:all:score-profile-version",
          locked_by_run_id: started.payload.runId,
        });
      const schedulerRun = db.query(`
        SELECT status, role_key, local_request_id, autopilot_run_id, finished_at
        FROM scheduler_runs
        WHERE id = ?1
      `).get(started.payload.run.id) as Record<string, unknown>;
      expect(schedulerRun).toMatchObject({
        status: "running",
        role_key: "score_company_service_fit",
        local_request_id: started.payload.requestId,
        autopilot_run_id: "remote-scheduler-score-run",
        finished_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("automated loop dispatches scoring up to score role concurrency while acquisition is disabled", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
      },
    });
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        acquisitionEnabled: false,
        enrichmentEnabled: false,
        scoringEnabled: true,
        outreachEnabled: false,
        perRoleConcurrency: {
          score_company_service_fit: 3,
        },
      },
    });
    const now = Date.now();
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('batch-score-profile', 'Adapt profile', 'batch-score-profile-version', ?1, ?1)")
      .run(now);
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('batch-score-profile-version', 'batch-score-profile', 1, '{}', 'Adapt services', 'Batch scoring profile', '[]', ?1)
    `).run(now);
    db.query(`
      INSERT INTO service_offerings(id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at)
      VALUES
        ('batch-score-offering-a', 'batch-score-profile-version', 'advisory', 'Advisory', 'base', '{}', 'active', ?1, ?1),
        ('batch-score-offering-b', 'batch-score-profile-version', 'automation', 'Automation', 'base', '{}', 'active', ?1, ?1)
    `).run(now);
    const insertCompany = db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, 'Perth', 'Accounting', ?3, 'enhanced', 'unique', 'complete', ?4, '{}', ?5, ?5)
    `);
    for (let index = 1; index <= 4; index += 1) {
      insertCompany.run(`batch-score-company-${index}`, `Batch Score ${index}`, `https://batch-score-${index}.example`, 0.9 - index * 0.01, now + index);
    }

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      fetchCalls.push({ url: String(url), init, body });
      return Response.json({ run: { id: `remote-batch-score-run-${fetchCalls.length}`, status: "running" } });
    }) as typeof fetch;
    try {
      const started = await runAutomatedProspectingLoop();
      expect(started).toMatchObject({
        action: "scoring",
        count: 3,
      });
      expect(fetchCalls).toHaveLength(3);
      expect(fetchCalls.map((call) => (call.body.input as Record<string, unknown>).companyId)).toEqual([
        "batch-score-company-1",
        "batch-score-company-2",
        "batch-score-company-3",
      ]);
      expect(db.query("SELECT COUNT(*) AS count FROM kindling_pipeline_runs WHERE role_key = 'score_company_service_fit' AND status = 'running'").get())
        .toEqual({ count: 3 });
      expect(db.query("SELECT COUNT(*) AS count FROM work_queue WHERE kind = 'service_fit_assessment' AND status = 'running'").get())
        .toEqual({ count: 3 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("run-once direct Autopilot start failure marks acquisition retryable and releases lock", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: {
        autopilotUrl: "http://127.0.0.1:9",
      },
    });
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        cooldowns: { acquisitionMs: 0 },
      },
    });
    seedSchedulerAcquisitionSlice("scheduler-direct-failure-slice");

    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return Response.json({ error: "Autopilot start unavailable" }, { status: 503 });
    }) as typeof fetch;
    try {
      const failed = await api("/api/kindling/scheduler/run-once?dryRun=false", {
        method: "POST",
      });
      expect(failed.res.status).toBe(502);
      expect(failed.payload.error).toBe("Autopilot start unavailable");
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:9/api/pipelines/triggers/http/kindling-scan-target-list");

      const run = db.query(`
        SELECT status, error, autopilot_run_id
        FROM kindling_pipeline_runs
        WHERE id = ?1
      `).get(failed.payload.runId) as Record<string, unknown>;
      expect(run).toEqual({
        status: "failed",
        error: "Autopilot start unavailable",
        autopilot_run_id: null,
      });

      const schedulerRun = db.query(`
        SELECT status, error, autopilot_run_id, finished_at, result_json
        FROM scheduler_runs
        WHERE id = ?1
      `).get(failed.payload.run.id) as Record<string, unknown>;
      expect(schedulerRun).toMatchObject({
        status: "failed",
        error: "Autopilot start unavailable",
        autopilot_run_id: null,
      });
      expect(Number(schedulerRun.finished_at)).toBeGreaterThan(0);
      expect(JSON.parse(String(schedulerRun.result_json))).toMatchObject({
        retryable: true,
        terminalStatus: "failed",
        source: "autopilot_start",
      });

      const job = db.query("SELECT status, summary FROM discovery_jobs WHERE id = ?1")
        .get(failed.payload.jobId) as Record<string, unknown>;
      expect(job).toMatchObject({
        status: "failed",
        summary: "Autopilot start unavailable",
      });
      expect(db.query("SELECT COUNT(*) AS count FROM scheduler_locks").get()).toEqual({ count: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("scheduled acquisition final webhook closes run and failure remains retryable", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true, cooldowns: { acquisitionMs: 0 } },
    });
    const started = await api("/api/kindling/scheduler/run-once?dryRun=false", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    expect(started.res.status).toBe(202);
    const input = started.payload.triggerRequest.body.input;
    const tokenHeader = input.webhook.authHeader;
    const tokenValue = input.webhook.token;

    const partial = await api("/api/kindling/pipeline-write/target-scan", {
      method: "POST",
      headers: { [input.localContext.writeApi.authHeader]: input.localContext.writeApi.token },
      body: {
        requestId: started.payload.jobId,
        result: {
          industry: input.industry,
          location: input.location,
          companies: [{
            name: "Scheduler Accounting One",
            website: "https://scheduler-accounting-one.example",
            industry: input.industry,
            location: input.location,
            duplicateStatus: "unique",
            confidence: 0.8,
          }],
          searchSlices: [{
            industry: input.industry,
            location: input.location,
            strategyType: "directory",
            query: "scheduler accounting directory",
            status: "searched",
            resultCount: 1,
          }],
        },
      },
    });
    expect(partial.res.status).toBe(200);

    const final = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { [tokenHeader]: tokenValue },
      body: {
        requestId: started.payload.jobId,
        role: "scan_target_list",
        status: "ok",
        runId: "remote-scheduler-run",
        response: "Scheduled acquisition finished.",
        result: {
          outputKind: "target_scan_result",
          industry: input.industry,
          location: input.location,
          companies: [],
          searchSlices: [],
          plannedNextStrategies: [],
        },
      },
    });
    expect(final.res.status).toBe(200);

    const completed = db.query(`
      SELECT status, autopilot_run_id, finished_at, result_json
      FROM scheduler_runs
      WHERE id = ?1
    `).get(started.payload.run.id) as Record<string, unknown>;
    expect(completed.status).toBe("complete");
    expect(completed.autopilot_run_id).toBe("remote-scheduler-run");
    expect(Number(completed.finished_at)).toBeGreaterThan(0);
    expect(JSON.parse(String(completed.result_json)).retryable).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM scheduler_locks").get()).toEqual({ count: 0 });

    resetData();
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true, cooldowns: { acquisitionMs: 0 } },
    });
    const failedStart = await api("/api/kindling/scheduler/run-once?dryRun=false", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    const failedInput = failedStart.payload.triggerRequest.body.input;
    const failure = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { [failedInput.webhook.authHeader]: failedInput.webhook.token },
      body: {
        requestId: failedStart.payload.jobId,
        role: "scan_target_list",
        status: "error",
        response: "search provider unavailable",
      },
    });
    expect(failure.res.status).toBe(200);
    const failedRun = db.query("SELECT status, error, result_json FROM scheduler_runs WHERE id = ?1")
      .get(failedStart.payload.run.id) as Record<string, unknown>;
    expect(failedRun.status).toBe("failed");
    expect(String(failedRun.error)).toContain("search provider unavailable");
    expect(JSON.parse(String(failedRun.result_json))).toMatchObject({
      retryable: true,
      terminalStatus: "failed",
    });
    const failedJob = db.query("SELECT status, summary FROM discovery_jobs WHERE id = ?1")
      .get(failedStart.payload.jobId) as Record<string, unknown>;
    expect(failedJob).toMatchObject({
      status: "failed",
    });
    expect(String(failedJob.summary)).toContain("failed before writing companies");
    expect(db.query("SELECT COUNT(*) AS count FROM scheduler_locks").get()).toEqual({ count: 0 });
  });

  test("dry-run respects scheduler locks and per-role concurrency", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true },
    });
    createSchedulerRun({
      id: "scheduler-real-active",
      status: "running",
      selectedAction: "scan_target_list",
      roleKey: "scan_target_list",
      now: Date.now(),
    });
    acquireSchedulerLock({
      runId: "scheduler-real-active",
      ownerId: "worker-active",
      leaseMs: 60_000,
    });
    const locked = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(locked.payload.decision).toMatchObject({
      workAvailable: false,
      action: "no_work",
      activeLock: {
        runId: "scheduler-real-active",
        ownerId: "worker-active",
      },
    });
    expect(String(locked.payload.decision.reason)).toContain("scheduler lock prospecting is held");

    resetData();
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: {
        enabled: true,
        perRoleConcurrency: { scan_target_list: 1 },
      },
    });
    seedKindlingRun("scan_target_list", "active-scan", "active-scan-token");
    db.query("UPDATE kindling_pipeline_runs SET updated_at = ?1 WHERE local_request_id = 'active-scan'")
      .run(Date.now());
    const limited = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    const acquisition = limited.payload.decision.evaluatedRoles.find((role: { action: string }) => role.action === "acquisition");
    expect(acquisition).toMatchObject({
      status: "skipped",
      activeCount: 1,
      concurrencyLimit: 1,
    });
    expect(String(acquisition.reason)).toContain("concurrency limit 1/1");
  });

  test("dry-run selects enrichment, scoring, and outreach candidates from existing state", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true, acquisitionEnabled: false },
    });
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('scheduler-enrich-company', 'Scheduler Enrich Co', 'Perth', 'Accounting', 'https://enrich.example', 'found', 'unique', 'not_started', 0.7, '{}', 10, 10)
    `).run();
    const enrichment = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(enrichment.payload.decision).toMatchObject({
      workAvailable: true,
      action: "enrichment",
      roleKey: "enrich_company",
      item: {
        kind: "company",
        company: { id: "scheduler-enrich-company" },
      },
    });

    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enrichmentEnabled: false },
    });
    db.query("INSERT INTO market_profiles(id, name, current_version_id, created_at, updated_at) VALUES ('scheduler-profile', 'Adapt profile', 'scheduler-profile-version', 20, 20)")
      .run();
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES ('scheduler-profile-version', 'scheduler-profile', 1, '{}', 'Adapt services', 'Scheduler profile', '[]', 20)
    `).run();
    db.query(`
      INSERT INTO service_offerings(
        id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
      )
      VALUES ('scheduler-offering', 'scheduler-profile-version', 'advisory', 'Advisory', 'base', '{}', 'active', 20, 20)
    `).run();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('scheduler-score-company', 'Scheduler Score Co', 'Perth', 'Accounting', 'https://score.example', 'enhanced', 'unique', 'complete', 0.9, '{}', 20, 20)
    `).run();
    const scoring = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(scoring.payload.decision).toMatchObject({
      workAvailable: true,
      action: "scoring",
      roleKey: "score_company_service_fit",
      item: {
        kind: "company",
        company: { id: "scheduler-score-company" },
      },
    });

    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { scoringEnabled: false },
    });
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('scheduler-outreach-company', 'Scheduler Outreach Co', 'Perth', 'Accounting', 'https://outreach.example', 'scored', 'unique', 'complete', 0.95, '{}', 30, 30)
    `).run();
    const outreach = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(outreach.payload.decision).toMatchObject({
      workAvailable: true,
      action: "outreach",
      roleKey: "draft_outreach",
      item: {
        kind: "company",
        company: { id: "scheduler-outreach-company" },
      },
    });
    const workRows = db.query(`
      SELECT
        (SELECT COUNT(*) FROM kindling_pipeline_runs) AS pipeline_runs,
        (SELECT COUNT(*) FROM enrichment_requests) AS enrichment_requests,
        (SELECT COUNT(*) FROM target_rankings) AS target_rankings,
        (SELECT COUNT(*) FROM outreach_drafts) AS outreach_drafts
    `).get() as Record<string, number>;
    expect(workRows).toEqual({
      pipeline_runs: 0,
      enrichment_requests: 0,
      target_rankings: 0,
      outreach_drafts: 0,
    });
  });

  test("dry-run prefers due enrichment work queue items", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true, acquisitionEnabled: false, targetPoolSize: 1, enrichedFloor: 50, topTargetCount: 100 },
    });
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('scheduler-queued-enrich', 'Queued Enrich Co', 'Perth', 'Accounting', 'https://queued-enrich.example', 'found', 'unique', 'failed', 0.7, '{}', 10, 10)
    `).run();
    db.query(`
      INSERT INTO work_queue(
        id, kind, target_type, target_id, segment, priority, status, reason, attempts,
        next_run_after_at, error, context_json, created_at, updated_at
      )
      VALUES ('scheduler-queue-item', 'company_enrichment', 'company', 'scheduler-queued-enrich',
        'Accounting', 3, 'failed', 'Timed out during prior enrichment', 1, 1,
        'Timed out during prior enrichment', '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
      VALUES ('scheduler-queue-item', 'scheduler-queued-enrich', 'scheduler-queue-item', 'failed', 'standard', 'Timed out during prior enrichment', 1, 1)
    `).run();

    const dryRun = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(dryRun.payload.decision).toMatchObject({
      workAvailable: true,
      action: "enrichment",
      roleKey: "enrich_company",
      item: {
        kind: "work_queue",
        queueItem: {
          id: "scheduler-queue-item",
          priority: 3,
          status: "failed",
          attempts: 1,
        },
        company: { id: "scheduler-queued-enrich" },
      },
    });
  });

  test("dry-run skips enrichment queue items already locked to a pending run", async () => {
    await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: { enabled: true, acquisitionEnabled: false, scoringEnabled: false, outreachEnabled: false, enrichedFloor: 50 },
    });
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('scheduler-locked-enrich', 'Locked Enrich Co', 'Perth', 'Accounting', 'https://locked-enrich.example', 'found', 'unique', 'queued', 0.7, '{}', 10, 10)
    `).run();
    db.query(`
      INSERT INTO work_queue(
        id, kind, target_type, target_id, segment, priority, status, reason, attempts,
        locked_by_run_id, error, context_json, created_at, updated_at
      )
      VALUES ('scheduler-locked-queue-item', 'company_enrichment', 'company', 'scheduler-locked-enrich',
        'Accounting', 3, 'queued', 'Already attached to pending auth run', 0,
        'pending-kindling-run', '', '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
      VALUES ('scheduler-locked-queue-item', 'scheduler-locked-enrich', 'scheduler-locked-queue-item', 'queued', 'standard', 'Already attached to pending auth run', 1, 1)
    `).run();

    const dryRun = await api("/api/kindling/scheduler/run-once?dryRun=true", { method: "POST" });
    expect(dryRun.payload.decision).toMatchObject({
      workAvailable: false,
      action: "no_work",
      roleKey: null,
    });
    const enrichmentEvaluation = dryRun.payload.decision.evaluatedRoles.find((role: Record<string, unknown>) => role.action === "enrichment");
    expect(String(enrichmentEvaluation.reason)).toContain("no unqueued enrichment candidate");
  });

  test("backfills legacy enrichment requests into durable work queue rows", () => {
    db.query(`
      INSERT INTO companies(id, name, location, industry, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('legacy-enrich-company', 'Legacy Enrich Co', 'Perth', 'Tax', 'found', 'unique', 'failed', 0.3, '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, status, request_kind, summary, created_at, updated_at)
      VALUES ('legacy-enrich-request', 'legacy-enrich-company', 'failed', 'industry_batch', 'Prior timeout', 2, 3)
    `).run();

    backfillEnrichmentRequestWorkQueue();

    expect(db.query("SELECT work_queue_id FROM enrichment_requests WHERE id = 'legacy-enrich-request'").get())
      .toEqual({ work_queue_id: "legacy-enrich-request" });
    const item = db.query(`
      SELECT id, kind, target_type, target_id, priority, status, reason, attempts, next_run_after_at, error, context_json
      FROM work_queue
      WHERE id = 'legacy-enrich-request'
    `).get() as Record<string, unknown>;
    expect(item).toMatchObject({
      id: "legacy-enrich-request",
      kind: "company_enrichment",
      target_type: "company",
      target_id: "legacy-enrich-company",
      priority: 50,
      status: "failed",
      reason: "Prior timeout",
      attempts: 1,
      next_run_after_at: 3,
      error: "Prior timeout",
    });
    expect(JSON.parse(String(item.context_json))).toMatchObject({
      enrichmentRequestId: "legacy-enrich-request",
      requestKind: "industry_batch",
      migratedFrom: "enrichment_requests",
    });
  });

  test("NIP-98 import preserves work queue rows and enrichment request queue links", async () => {
    db.query("INSERT INTO access_rules(pubkey, npub, role, created_at) VALUES (?1, 'npub-test', 'edit', 1)").run(pubkey);
    const body = {
      tables: {
        companies: [{
          id: "import-queue-company",
          name: "Import Queue Co",
          location: "Perth",
          industry: "Accounting",
          website: "https://import-queue.example",
          data_ring: "found",
          duplicate_status: "unique",
          enrichment_status: "failed",
          confidence: 0.4,
          profile_json: "{}",
          created_at: 1,
          updated_at: 1,
        }],
        work_queue: [{
          id: "import-queue-item",
          kind: "company_enrichment",
          target_type: "company",
          target_id: "import-queue-company",
          segment_id: null,
          segment: "Accounting",
          priority: 4,
          status: "failed",
          reason: "Imported retry",
          attempts: 2,
          next_run_after_at: 9,
          locked_by_run_id: null,
          error: "Imported timeout",
          context_json: "{\"source\":\"round_trip\"}",
          created_at: 1,
          updated_at: 9,
        }],
        enrichment_requests: [{
          id: "import-enrich-request",
          company_id: "import-queue-company",
          work_queue_id: "import-queue-item",
          status: "failed",
          request_kind: "industry_batch",
          summary: "Imported timeout",
          created_at: 1,
          updated_at: 9,
        }],
      },
    };

    const imported = await api("/api/nip98/kindling/import", {
      method: "POST",
      headers: nip98Headers("/api/nip98/kindling/import", "POST", body),
      body,
    });
    expect(imported.res.status).toBe(200);
    expect(imported.payload.counts).toMatchObject({ companies: 1, work_queue: 1, enrichment_requests: 1 });
    expect(db.query("SELECT id, work_queue_id FROM enrichment_requests WHERE id = 'import-enrich-request'").get())
      .toEqual({ id: "import-enrich-request", work_queue_id: "import-queue-item" });
    expect(db.query("SELECT id, priority, attempts, error, context_json FROM work_queue WHERE id = 'import-queue-item'").get())
      .toEqual({
        id: "import-queue-item",
        priority: 4,
        attempts: 2,
        error: "Imported timeout",
        context_json: "{\"source\":\"round_trip\"}",
      });
  });

  test("automatic industry enrichment creates and starts linked queue rows", async () => {
    process.env.KINDLING_AUTOPILOT_NSEC = Buffer.from(secretKey).toString("hex");
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('auto-enrich-1', 'Auto Enrich One', 'Perth', 'Bookkeeping', 'https://auto-one.example', 'found', 'unique', 'not_started', 0.3, '{}', 1, 1),
        ('auto-enrich-2', 'Auto Enrich Two', 'Perth', 'Bookkeeping', 'https://auto-two.example', 'found', 'unique', 'failed', 0.2, '{}', 2, 2)
    `).run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/pipelines/triggers/http/kindling-enrich-industry-segment");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.input.pipelineRole).toBe("enrich_industry_segment");
      expect(body.input.localContext.companies).toHaveLength(2);
      return Response.json({ run: { id: "remote-auto-enrich-run" } });
    }) as typeof fetch;
    try {
      const result = await runAutoEnrichNextIndustry({
        autopilotUrl: "http://autopilot.test",
        publicOrigin: "http://kindling.test",
        sendDm: false,
      });
      expect(result).toMatchObject({
        status: "started",
        industry: "Bookkeeping",
        autopilotRunId: "remote-auto-enrich-run",
        batchSize: 2,
        dmSent: false,
      });
      const rows = db.query(`
        SELECT wq.status, wq.priority, wq.attempts, wq.locked_by_run_id, wq.reason, wq.context_json,
          er.status AS request_status, er.work_queue_id
        FROM work_queue wq
        JOIN enrichment_requests er ON er.work_queue_id = wq.id
        WHERE wq.target_id LIKE 'auto-enrich-%'
        ORDER BY wq.target_id
      `).all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: "running",
          priority: 50,
          attempts: 1,
          locked_by_run_id: "remote-auto-enrich-run",
          request_status: "running",
        });
        expect(String(row.reason)).toContain("Queued by automatic industry batch");
        expect(JSON.parse(String(row.context_json))).toMatchObject({ source: "auto_enrichment_job", requestKind: "industry_batch" });
        expect(row.work_queue_id).toBeTruthy();
      }
      const companies = db.query("SELECT id, enrichment_status FROM companies WHERE id LIKE 'auto-enrich-%' ORDER BY id").all();
      expect(companies).toEqual([
        { id: "auto-enrich-1", enrichment_status: "running" },
        { id: "auto-enrich-2", enrichment_status: "running" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.KINDLING_AUTOPILOT_NSEC;
    }
  });

  test("automatic industry enrichment trigger failures leave retryable queue state", async () => {
    process.env.KINDLING_AUTOPILOT_NSEC = Buffer.from(secretKey).toString("hex");
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('auto-fail-1', 'Auto Fail One', 'Perth', 'Tax', 'https://auto-fail.example', 'found', 'unique', 'not_started', 0.3, '{}', 1, 1)
    `).run();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: "Autopilot offline" }, { status: 503 })) as typeof fetch;
    try {
      await expect(runAutoEnrichNextIndustry({
        autopilotUrl: "http://autopilot.test",
        publicOrigin: "http://kindling.test",
        sendDm: false,
      })).rejects.toThrow("Autopilot trigger failed (503): Autopilot offline");
      const item = db.query(`
        SELECT status, priority, attempts, locked_by_run_id, error, next_run_after_at
        FROM work_queue
        WHERE target_id = 'auto-fail-1'
      `).get() as Record<string, unknown>;
      expect(item.status).toBe("failed");
      expect(item.priority).toBe(50);
      expect(item.attempts).toBe(1);
      expect(item.locked_by_run_id).toBeNull();
      expect(String(item.error)).toContain("Autopilot offline");
      expect(Number(item.next_run_after_at)).toBeGreaterThan(0);
      expect(db.query("SELECT status, work_queue_id FROM enrichment_requests WHERE company_id = 'auto-fail-1'").get())
        .toMatchObject({ status: "failed" });
      expect(db.query("SELECT enrichment_status FROM companies WHERE id = 'auto-fail-1'").get())
        .toEqual({ enrichment_status: "not_started" });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.KINDLING_AUTOPILOT_NSEC;
    }
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

  test("reconciles errored industry enrichment runs and releases queued companies", async () => {
    db.query(`
      INSERT INTO companies(id, name, location, industry, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('tax-complete', 'Complete Tax', 'Perth', 'Tax accountants', 'enriched', 'unknown', 'complete', 0.9, '{}', 1, 1),
        ('tax-stale-1', 'Stale Tax 1', 'Perth', 'Tax accountants', 'seed', 'unknown', 'queued', 0.4, '{}', 1, 1),
        ('tax-stale-2', 'Stale Tax 2', 'Perth', 'Tax accountants', 'seed', 'unknown', 'queued', 0.4, '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, status, request_kind, summary, created_at, updated_at)
      VALUES
        ('tax-request-complete', 'tax-complete', 'complete', 'industry_batch', 'Enriched', 1, 1),
        ('tax-request-stale-1', 'tax-stale-1', 'queued', 'industry_batch', 'Queued by automatic industry batch tax-batch-error', 1, 1),
        ('tax-request-stale-2', 'tax-stale-2', 'queued', 'industry_batch', 'Queued by automatic industry batch tax-batch-error', 1, 1)
    `).run();
    seedKindlingRun("enrich_industry_segment", "tax-batch-error", "tax-token", {
      body: {
        input: {
          localContext: {
            companies: [{ id: "tax-complete" }, { id: "tax-stale-1" }, { id: "tax-stale-2" }],
          },
        },
      },
    });
    db.query("UPDATE kindling_pipeline_runs SET autopilot_run_id = 'remote-industry-error-run' WHERE id = 'run-tax-batch-error'").run();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/api/pipelines/runs/remote-industry-error-run");
      return Response.json({ run: { id: "remote-industry-error-run", status: "error", error: "Timed out waiting for pipeline agent callback" } });
    }) as typeof fetch;
    try {
      const { res, payload } = await api("/api/kindling/summary");
      expect(res.status).toBe(200);
      const run = payload.recentRuns.find((entry: Record<string, unknown>) => entry.localRequestId === "tax-batch-error");
      expect(run.status).toBe("partial_failed");
      expect(run.error).toBe("Timed out waiting for pipeline agent callback");
      const companies = db.query("SELECT id, enrichment_status FROM companies WHERE id LIKE 'tax-%' ORDER BY id").all() as Array<Record<string, string>>;
      expect(companies).toEqual([
        { id: "tax-complete", enrichment_status: "complete" },
        { id: "tax-stale-1", enrichment_status: "failed" },
        { id: "tax-stale-2", enrichment_status: "failed" },
      ]);
      const requests = db.query("SELECT id, status, summary FROM enrichment_requests WHERE id LIKE 'tax-request-stale-%' ORDER BY id").all() as Array<Record<string, string>>;
      expect(requests.map((request) => request.status)).toEqual(["failed", "failed"]);
      expect(requests[0]?.summary).toContain("Timed out waiting for pipeline agent callback");
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
          profilePatch: {
            summary: "Commercial HVAC contractor with visible AI adoption interest.",
            servicesOffered: ["Commercial HVAC", "Maintenance"],
            gaps: ["No owner found"],
          },
          sources: [{
            id: "source-north-site",
            sourceType: "company_website",
            url: "https://north.example",
            title: "North HVAC Website",
            summary: "Website",
            extractedData: { services: ["Commercial HVAC"], location: "Perth" },
            confidence: 0.9,
            lastCheckedAt: 1_780_876_800_000,
          }],
          signals: [
            {
              signalType: "ai_adoption",
              summary: "Mentions AI-assisted quoting on the website.",
              sourceId: "source-north-site",
              sourceUrl: "https://north.example",
              strength: "medium",
              confidence: 0.82,
              adaptRelevance: "Useful prompt for AI workflow conversation.",
            },
            {
              signalType: "owner_led",
              summary: "Likely owner-led based on sparse public profile.",
              strength: "medium",
              confidence: 0.88,
            },
          ],
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
    expect(JSON.parse(String(company.profile_json)).summary).toContain("Commercial HVAC");

    const source = db.query("SELECT * FROM sources WHERE company_id = 'company-1'").get() as Record<string, unknown>;
    expect(source).toMatchObject({
      source_type: "company_website",
      url: "https://north.example",
      title: "North HVAC Website",
      last_checked_at: 1_780_876_800_000,
    });
    expect(JSON.parse(String(source.extracted_data_json))).toMatchObject({ location: "Perth" });

    const signals = db.query("SELECT * FROM signals WHERE company_id = 'company-1' ORDER BY signal_type ASC").all() as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(2);
    expect(signals.find((signal) => signal.signal_type === "ai_adoption")).toMatchObject({
      source_id: "source-north-site",
      source_url: "https://north.example",
      confidence: 0.82,
    });
    const weakSignal = signals.find((signal) => signal.signal_type === "owner_led")!;
    expect(Number(weakSignal.confidence)).toBe(0.4);
    expect(JSON.parse(String(weakSignal.evidence_json)).lowConfidenceReason).toContain("No source evidence");

    const profileVersion = db.query("SELECT * FROM customer_profile_versions WHERE company_id = 'company-1'").get() as Record<string, unknown>;
    expect(profileVersion).toMatchObject({
      version_number: 1,
      status: "active",
      created_by: "pipeline",
    });
    expect(JSON.parse(String(profileVersion.source_ids_json))).toEqual(["source-north-site"]);

    expect(db.query("SELECT COUNT(*) AS count FROM target_rankings").get()).toEqual({ count: 0 });

    const detail = await api("/api/kindling/companies/company-1");
    expect(detail.payload.customerProfileVersions).toHaveLength(1);
    expect(detail.payload.signals).toHaveLength(2);
    expect(detail.payload.signals.find((signal: Record<string, unknown>) => signal.signalType === "ai_adoption").source).toMatchObject({
      id: "source-north-site",
      title: "North HVAC Website",
    });
    expect(detail.payload.signals.find((signal: Record<string, unknown>) => signal.signalType === "owner_led")).toMatchObject({
      lowConfidence: true,
      confidence: 0.4,
    });
  });

  test("rebuilds initial ranking runs without losing history", async () => {
    const now = Date.now();
    const highProfile = {
      summary: "Owner-led Perth accounting advisory firm with succession and AI workflow interest.",
      servicesOffered: ["Tax", "Business advisory", "Virtual CFO"],
      ownership: { ownerLedLikelihood: 0.9, ownershipType: "partner_owned" },
      size: { employeeCountBucket: "20-50", confidence: 0.8 },
      contactPaths: [{ type: "website_contact_form", value: "https://north-advisory.example/contact", confidence: 0.9 }],
    };
    const lowProfile = {
      summary: "Enhanced company with sparse public detail.",
      gaps: [{ field: "contactPaths", severity: "medium" }],
    };
    const insertCompany = db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unique', ?7, ?8, ?9, ?10, ?10)
    `);
    insertCompany.run("rank-high", "North Advisory", "Perth, WA", "Accounting and business advisory", "https://north-advisory.example", "enhanced", "complete", 0.88, JSON.stringify(highProfile), now);
    insertCompany.run("rank-low", "Sparse Services", "", "General services", "", "enhanced", "complete", 0.42, JSON.stringify(lowProfile), now - 120 * 24 * 60 * 60 * 1000);
    insertCompany.run("rank-found", "Found Only", "Perth, WA", "Accounting", "", "found", "not_started", 0.3, "{}", now);
    db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES
        ('rank-high', 'adapt-tier-1-accounting-tax-bookkeeping-business-advisory', 0.92, 'test', ?1),
        ('rank-low', 'adapt-tier-3-operational-smes-scale-pain', 0.45, 'test', ?1)
    `).run(now);
    db.query(`
      INSERT INTO sources(id, company_id, source_type, url, title, summary, confidence, created_at)
      VALUES
        ('source-high-1', 'rank-high', 'company_website', 'https://north-advisory.example', 'North Advisory', 'Official site with advisory and contact path.', 0.95, ?1),
        ('source-high-2', 'rank-high', 'news', 'https://north-advisory.example/news', 'AI workflow update', 'Public update about workflow automation.', 0.82, ?1),
        ('source-low-1', 'rank-low', 'directory', '', 'Directory listing', 'Sparse directory record.', 0.35, ?2)
    `).run(now, now - 200 * 24 * 60 * 60 * 1000);
    db.query(`
      INSERT INTO customer_profile_versions(id, company_id, version_number, status, profile_json, change_summary, source_ids_json, activity_ids_json, created_by, created_at)
      VALUES
        ('profile-high', 'rank-high', 1, 'active', ?1, 'Profile update', '["source-high-1"]', '[]', 'pipeline', ?3),
        ('profile-low', 'rank-low', 1, 'active', ?2, 'Sparse profile update', '["source-low-1"]', '[]', 'pipeline', ?4)
    `).run(JSON.stringify(highProfile), JSON.stringify(lowProfile), now, now - 200 * 24 * 60 * 60 * 1000);
    db.query(`
      INSERT INTO signals(id, company_id, signal_type, summary, source_id, source_url, observed_date, strength, confidence, adapt_relevance, evidence_json, created_at)
      VALUES
        ('signal-high-1', 'rank-high', 'succession', 'Partners discussing succession planning.', 'source-high-1', 'https://north-advisory.example', NULL, 'high', 0.88, 'Owner-led advisory trigger', '{}', ?1),
        ('signal-high-2', 'rank-high', 'ai_adoption', 'Published AI workflow article.', 'source-high-2', 'https://north-advisory.example/news', NULL, 'medium', 0.8, 'Adapt service relevance', '{}', ?1)
    `).run(now);

    const first = await api("/api/kindling/initial-ranking/run", {
      method: "POST",
      body: { reason: "Focused test rebuild" },
    });
    expect(first.res.status).toBe(201);
    expect(first.payload.run).toMatchObject({
      rankingType: "initial",
      status: "complete",
      candidateCount: 2,
      rankedCount: 2,
      scoreVersion: "initial-v1",
    });
    expect(first.payload.items.map((item: { companyId: string }) => item.companyId)).toEqual(["rank-high", "rank-low"]);
    expect(first.payload.items[0].score).toBeGreaterThan(first.payload.items[1].score);
    expect(first.payload.items[0].scoreJson.dimensions).toMatchObject({
      sourceQuality: expect.any(Number),
      segmentPriority: expect.any(Number),
      geography: expect.any(Number),
      ownerLed: expect.any(Number),
      triggers: expect.any(Number),
      reachability: expect.any(Number),
      freshness: expect.any(Number),
      missingFieldCompleteness: expect.any(Number),
    });

    const rings = db.query("SELECT id, data_ring FROM companies WHERE id LIKE 'rank-%' ORDER BY id").all() as Array<Record<string, string>>;
    expect(rings).toEqual([
      { id: "rank-found", data_ring: "found" },
      { id: "rank-high", data_ring: "ranked" },
      { id: "rank-low", data_ring: "ranked" },
    ]);

    const second = await api("/api/kindling/initial-ranking/run", {
      method: "POST",
      body: { reason: "Second rebuild" },
    });
    expect(second.res.status).toBe(201);
    expect(second.payload.run.id).not.toBe(first.payload.run.id);
    expect(db.query("SELECT COUNT(*) AS count FROM ranking_runs").get()).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM ranking_items").get()).toEqual({ count: 4 });

    const today = await api("/api/kindling/todays-targets");
    expect(today.payload).toMatchObject({
      source: "initial_ranking",
      rankingRunId: second.payload.run.id,
    });
    expect(today.payload.targets.map((target: { companyId: string }) => target.companyId)).toEqual(["rank-high", "rank-low"]);
  });

  test("manual enrichment creates a prioritized work queue item", async () => {
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('queue-manual', 'Queue Manual Co', 'Perth', 'Accounting', 'https://queue-manual.example', 'found', 'unique', 'not_started', 0.6, '{}', 1, 1)
    `).run();
    const queued = await api("/api/kindling/companies/queue-manual/enrich", {
      method: "POST",
      body: {
        deferAutopilotAuth: true,
        priority: 7,
        reason: "High fit and stale public profile",
      },
    });
    expect(queued.res.status).toBe(202);
    const requestId = String(queued.payload.requestId);
    const request = db.query("SELECT id, company_id, work_queue_id, status FROM enrichment_requests WHERE id = ?1")
      .get(requestId) as Record<string, string>;
    expect(request).toMatchObject({
      id: requestId,
      company_id: "queue-manual",
      work_queue_id: requestId,
      status: "queued",
    });
    const item = db.query("SELECT * FROM work_queue WHERE id = ?1").get(requestId) as Record<string, unknown>;
    expect(item).toMatchObject({
      kind: "company_enrichment",
      target_type: "company",
      target_id: "queue-manual",
      priority: 7,
      status: "queued",
      attempts: 0,
      locked_by_run_id: queued.payload.runId,
      reason: "High fit and stale public profile",
    });
  });

  test("failed enrichment queue items can be retried", async () => {
    db.query(`
      INSERT INTO companies(id, name, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES ('retry-company', 'Retry Co', 'found', 'unique', 'running', 0.4, '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO work_queue(
        id, kind, target_type, target_id, segment, priority, status, reason, attempts,
        locked_by_run_id, error, context_json, created_at, updated_at
      )
      VALUES ('retry-request', 'company_enrichment', 'company', 'retry-company', 'Accounting', 15, 'running',
        'Manual enrichment requested', 1, 'run-retry-request', '', '{}', 1, 1)
    `).run();
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
      VALUES ('retry-request', 'retry-company', 'retry-request', 'running', 'standard', 'Manual enrichment requested', 1, 1)
    `).run();
    seedKindlingRun("enrich_company", "retry-request", "retry-token");

    const failed = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": "retry-token" },
      body: {
        requestId: "retry-request",
        role: "enrich_company",
        status: "error",
        error: "Timed out waiting for enrichment",
      },
    });
    expect(failed.res.status).toBe(200);
    const failedItem = db.query("SELECT status, attempts, error, next_run_after_at FROM work_queue WHERE id = 'retry-request'")
      .get() as Record<string, unknown>;
    expect(failedItem.status).toBe("failed");
    expect(failedItem.attempts).toBe(1);
    expect(String(failedItem.error)).toContain("Timed out");
    expect(Number(failedItem.next_run_after_at)).toBeGreaterThan(0);

    const retried = await api("/api/kindling/work-queue/retry-request/retry", { method: "POST" });
    expect(retried.res.status).toBe(200);
    expect(retried.payload.item).toMatchObject({
      id: "retry-request",
      status: "queued",
      attempts: 1,
      error: "",
      lockedByRunId: null,
    });
    expect(db.query("SELECT status FROM enrichment_requests WHERE id = 'retry-request'").get()).toEqual({ status: "queued" });
    expect(db.query("SELECT enrichment_status FROM companies WHERE id = 'retry-company'").get()).toEqual({ enrichment_status: "queued" });
  });

  test("failed work queue items can be cleared from backlog without deleting history", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('clear-company-a', 'Clear A', 'found', 'unique', 'failed', 0.4, '{}', ?1, ?1),
        ('clear-company-b', 'Clear B', 'found', 'unique', 'failed', 0.4, '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO work_queue(
        id, kind, target_type, target_id, segment, priority, status, reason, attempts,
        locked_by_run_id, error, context_json, created_at, updated_at
      )
      VALUES
        ('clear-failed-a', 'company_enrichment', 'company', 'clear-company-a', 'Accounting', 15, 'failed', 'Prior timeout', 1, '', 'Timed out', '{}', ?1, ?1),
        ('clear-failed-b', 'company_enrichment', 'company', 'clear-company-b', 'Accounting', 15, 'failed', 'Prior timeout', 1, '', 'Timed out', '{}', ?1, ?1),
        ('clear-queued', 'company_enrichment', 'company', 'clear-company-b', 'Accounting', 15, 'queued', 'Still due', 0, '', '', '{}', ?1, ?1)
    `).run(now);
    db.query(`
      INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
      VALUES
        ('clear-failed-a', 'clear-company-a', 'clear-failed-a', 'failed', 'standard', 'Timed out', ?1, ?1),
        ('clear-failed-b', 'clear-company-b', 'clear-failed-b', 'failed', 'standard', 'Timed out', ?1, ?1)
    `).run(now);

    const cleared = await api("/api/kindling/work-queue/clear-failed", { method: "POST" });
    expect(cleared.res.status).toBe(200);
    expect(cleared.payload).toMatchObject({
      cleared: 2,
      byKind: { company_enrichment: 2 },
      counts: {
        queued: 1,
        failed: 0,
        cancelled: 2,
        active: 1,
      },
    });
    expect(db.query("SELECT status, COUNT(*) AS count FROM work_queue GROUP BY status ORDER BY status").all()).toEqual([
      { status: "cancelled", count: 2 },
      { status: "queued", count: 1 },
    ]);
    expect(db.query("SELECT status, COUNT(*) AS count FROM enrichment_requests GROUP BY status").all()).toEqual([
      { status: "cancelled", count: 2 },
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM work_queue").get()).toEqual({ count: 3 });
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
      dataRing: "found",
      duplicateStatus: "unknown",
      enrichmentStatus: "not_started",
    });
  });

  test("normalizes legacy company data rings and keeps old filters compatible", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('legacy-seed', 'Legacy Seed', 'Perth', 'Accounting', '', 'seed', 'unknown', 'not_started', 0.2, '{}', ?1, ?1),
        ('legacy-manual', 'Legacy Manual', 'Perth', 'Accounting', '', 'manual', 'unknown', 'not_started', 0.2, '{}', ?1, ?1),
        ('legacy-discovered', 'Legacy Discovered', 'Perth', 'Accounting', '', 'discovered', 'unknown', 'not_started', 0.2, '{}', ?1, ?1),
        ('legacy-enriched', 'Legacy Enriched', 'Perth', 'Accounting', '', 'enriched', 'unknown', 'complete', 0.8, '{}', ?1, ?1),
        ('legacy-outreach', 'Legacy Outreach', 'Perth', 'Accounting', '', 'outreach', 'unknown', 'complete', 0.8, '{}', ?1, ?1)
    `).run(now);

    const found = await api("/api/kindling/companies?industry=Accounting&dataRing=found");
    expect(found.payload.companies.map((company: { id: string }) => company.id).sort()).toEqual([
      "legacy-discovered",
      "legacy-manual",
      "legacy-seed",
    ]);
    expect(found.payload.companies.map((company: { dataRing: string }) => company.dataRing)).toEqual(["found", "found", "found"]);

    const oldManualFilter = await api("/api/kindling/companies?industry=Accounting&dataRing=manual");
    expect(oldManualFilter.payload.total).toBe(3);

    const enhanced = await api("/api/kindling/companies?industry=Accounting&dataRing=enriched");
    expect(enhanced.payload.companies[0]).toMatchObject({ id: "legacy-enriched", dataRing: "enhanced" });

    const outreachReady = await api("/api/kindling/companies?industry=Accounting&dataRing=outreach");
    expect(outreachReady.payload.companies[0]).toMatchObject({ id: "legacy-outreach", dataRing: "outreach_ready" });
  });

  test("returns no companies for an unknown data ring filter", async () => {
    const now = Date.now();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES
        ('known-found', 'Known Found', 'Perth', 'Accounting', '', 'found', 'unknown', 'not_started', 0.2, '{}', ?1, ?1),
        ('legacy-manual', 'Legacy Manual', 'Perth', 'Accounting', '', 'manual', 'unknown', 'not_started', 0.2, '{}', ?1, ?1)
    `).run(now);

    const invalid = await api("/api/kindling/companies?industry=Accounting&dataRing=bogus");
    expect(invalid.res.status).toBe(200);
    expect(invalid.payload.total).toBe(0);
    expect(invalid.payload.companies).toEqual([]);
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

  test("pages company lists while preserving full summary cap", async () => {
    const now = Date.now();
    const insert = db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, 'Perth', 'Accounting', '', 'seed', 'unknown', ?3, 0.4, '{}', ?4, ?4)
    `);
    for (let index = 0; index < 505; index += 1) {
      insert.run(`company-${index}`, `Company ${index}`, index < 2 ? "complete" : "not_started", now + index);
    }

    const list = await api("/api/kindling/companies");
    expect(list.payload.companies).toHaveLength(20);
    expect(list.payload.companies[0]).not.toHaveProperty("profile");
    expect(list.payload.returned).toBe(20);
    expect(list.payload.total).toBe(505);
    expect(list.payload.limit).toBe(20);
    expect(list.payload.offset).toBe(0);

    const secondPage = await api("/api/kindling/companies?limit=20&offset=20");
    expect(secondPage.payload.companies).toHaveLength(20);
    expect(secondPage.payload.offset).toBe(20);

    const summary = await api("/api/kindling/summary");
    expect(summary.payload.companies).toHaveLength(500);
    expect(summary.payload.counts.companies).toBe(505);
    expect(summary.payload.counts.enriched).toBe(2);
    expect(summary.payload.counts.outreachReady).toBe(0);
    expect(summary.payload.companyList).toMatchObject({
      returned: 500,
      total: 505,
      limit: 500,
    });

    const compactSummary = await api("/api/kindling/summary?compact=1");
    expect(compactSummary.payload.compact).toBe(true);
    expect(compactSummary.payload.companies).toHaveLength(0);
    expect(compactSummary.payload.coverage.light).toBe(true);
    expect(compactSummary.payload.counts.companies).toBe(505);
    expect(compactSummary.payload.companyList).toMatchObject({
      returned: 0,
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
      data_ring: "enhanced",
      enrichment_status: "complete",
    });
  });

  test("marks unwritten companies failed when an industry enrichment batch completes", async () => {
    const now = Date.now();
    for (const id of ["tax-written", "tax-missing"]) {
      db.query(`
        INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
        VALUES (?1, ?2, 'Perth', 'Tax accountants', '', 'seed', 'unknown', 'not_started', 0.4, '{}', ?3, ?3)
      `).run(id, id, now);
    }
    const queued = await api("/api/kindling/enrichment-industries/Tax%20accountants/enrich", {
      method: "POST",
      body: { deferAutopilotAuth: true },
    });
    const run = db.query("SELECT webhook_token FROM kindling_pipeline_runs WHERE id = ?1").get(queued.payload.runId) as Record<string, string>;
    const write = await api("/api/kindling/pipeline-write/enrichment-company", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": run.webhook_token },
      body: {
        batchRequestId: queued.payload.batchId,
        companyId: "tax-written",
        response: "Enriched Tax Written",
        company: {
          id: "tax-written",
          website: "https://tax-written.example",
          confidence: 0.82,
          profile: { summary: "Tax advisory practice" },
        },
      },
    });
    expect(write.res.status).toBe(200);

    const finished = await api("/api/kindling/pipeline-webhook", {
      method: "POST",
      headers: { "x-kindling-pipeline-token": run.webhook_token },
      body: {
        requestId: queued.payload.batchId,
        role: "enrich_industry_segment",
        status: "complete",
        response: "Industry batch complete",
        result: { industry: "Tax accountants" },
      },
    });
    expect(finished.res.status).toBe(200);
    const runRow = db.query("SELECT status, error FROM kindling_pipeline_runs WHERE id = ?1").get(queued.payload.runId) as Record<string, string>;
    expect(runRow.status).toBe("partial_failed");
    expect(runRow.error).toContain("Pipeline completed without writing enrichment");
    const statuses = db.query("SELECT id, enrichment_status FROM companies WHERE id IN ('tax-written', 'tax-missing') ORDER BY id").all() as Array<Record<string, string>>;
    expect(statuses).toEqual([
      { id: "tax-missing", enrichment_status: "failed" },
      { id: "tax-written", enrichment_status: "complete" },
    ]);
  });
});
