import { join } from "node:path";
import type { Event as NostrEvent } from "nostr-tools";
import {
  addAccessRule,
  canLogin,
  cleanupExpiredAuthRows,
  createChallenge,
  getAccessRules,
  getSession,
  hasAccess,
  normalizePubkey,
  pubkeyToNpub,
  removeAccessRule,
  verifyLoginEvent,
  verifyNip98Request,
} from "./auth.ts";
import { ALLOW_MOCK, HTTP_TRIGGER_TOKEN, PIPELINE_NAME, PORT, PUBLIC_ORIGIN, WINGMAN_URL } from "./config.ts";
import { db, getSetting, mapChat, mapMessage, setSetting, type AccessRole, type AppSettings, type Message } from "./db.ts";
import { buildPipelineTriggerRequest, startPreparedChatPipeline, type PipelineTriggerRequest } from "./pipeline.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (data: string, status = 200) =>
  new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function serveStatic(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(PUBLIC_DIR, relativePath));
  if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
  const fallback = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await fallback.exists()) return new Response(fallback, { headers: { "cache-control": "no-store" } });
  return text("public/index.html missing", 500);
}

function requireSession(req: Request) {
  const session = getSession(req);
  if (!session) return null;
  return session;
}

function toServerAutopilotUrl(value: string) {
  const trimmed = value.replace(/\/$/, "");
  try {
    const parsed = new URL(trimmed);
    const oldLocalDefault = ["localhost", "127.0.0.1"].includes(parsed.hostname) && parsed.port === "3021";
    const rickPublicAutopilot = parsed.hostname === "rick.runwingman.com";
    if (oldLocalDefault || rickPublicAutopilot) return WINGMAN_URL;
  } catch {
    return trimmed;
  }
  return trimmed;
}

function getAppSettings(): AppSettings {
  return {
    autopilotUrl: (getSetting("autopilotUrl") || WINGMAN_URL).replace(/\/$/, ""),
    defaultPipeline: getSetting("defaultPipeline") || PIPELINE_NAME,
  };
}

function normalizeAutopilotUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizePipelineName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowJson(row: Record<string, unknown> | null) {
  return row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value])) : null;
}

function mapPipelineRole(row: Record<string, unknown>) {
  return {
    roleKey: String(row.role_key),
    displayName: String(row.display_name),
    activePipelineSlug: String(row.active_pipeline_slug),
    pipelineLabel: String(row.pipeline_label),
    requiredInputFields: jsonParse<string[]>(row.required_input_fields_json, []),
    expectedOutputShape: String(row.expected_output_shape),
    enabled: Boolean(Number(row.enabled)),
    lastVerifiedAt: row.last_verified_at ? Number(row.last_verified_at) : null,
    updatedAt: Number(row.updated_at),
  };
}

function mapCompany(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    location: String(row.location ?? ""),
    industry: String(row.industry ?? ""),
    website: String(row.website ?? ""),
    dataRing: String(row.data_ring),
    duplicateStatus: String(row.duplicate_status),
    enrichmentStatus: String(row.enrichment_status),
    confidence: Number(row.confidence ?? 0),
    profile: jsonParse<Record<string, unknown>>(row.profile_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    roleKey: String(row.role_key),
    localRequestId: String(row.local_request_id),
    autopilotRunId: row.autopilot_run_id ? String(row.autopilot_run_id) : null,
    status: String(row.status),
    error: row.error ? String(row.error) : "",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function listPipelineRoles() {
  const rows = db.query("SELECT * FROM pipeline_roles ORDER BY display_name ASC").all() as Record<string, unknown>[];
  return rows.map(mapPipelineRole);
}

function getPipelineRole(roleKey: string) {
  const row = db.query("SELECT * FROM pipeline_roles WHERE role_key = ?1").get(roleKey) as Record<string, unknown> | null;
  return row ? mapPipelineRole(row) : null;
}

function getCurrentMarketProfile() {
  const profile = db.query("SELECT * FROM market_profiles ORDER BY created_at ASC LIMIT 1").get() as Record<string, unknown> | null;
  if (!profile) return null;
  const version = profile.current_version_id
    ? db.query("SELECT * FROM market_profile_versions WHERE id = ?1").get(String(profile.current_version_id)) as Record<string, unknown> | null
    : null;
  return {
    id: String(profile.id),
    name: String(profile.name),
    currentVersionId: profile.current_version_id ? String(profile.current_version_id) : null,
    version: version ? {
      id: String(version.id),
      versionNumber: Number(version.version_number),
      structured: jsonParse<Record<string, unknown>>(version.structured_json, {}),
      summary: String(version.summary),
      rationale: String(version.rationale),
      sourceReferences: jsonParse<string[]>(version.source_references_json, []),
      createdAt: Number(version.created_at),
    } : null,
    createdAt: Number(profile.created_at),
    updatedAt: Number(profile.updated_at),
  };
}

function recordActivity(targetType: string, targetId: string, actor: string, actionType: string, summary: string, payload: Record<string, unknown> = {}) {
  db.query(`
    INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).run(crypto.randomUUID(), targetType, targetId, actor, actionType, summary, JSON.stringify(payload), Date.now());
}

function clampTargetCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return 25;
  return Math.min(parsed, 2000);
}

function scanModeForTargetCount(targetCount: number) {
  if (targetCount >= 500) return "bulk";
  if (targetCount >= 100) return "batch";
  return "interactive";
}

function listScanStrategyHistory(industry: string, location: string, limit = 30) {
  const rows = db.query(`
    SELECT sat.*
    FROM scan_strategy_attempts sat
    WHERE lower(sat.industry) = lower(?1)
       OR lower(sat.location) = lower(?2)
       OR lower(sat.industry || ' ' || sat.location) LIKE lower(?3)
    ORDER BY sat.created_at DESC
    LIMIT ?4
  `).all(industry, location, `%${industry} ${location}%`, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    strategyType: String(row.strategy_type),
    query: String(row.query),
    status: String(row.status),
    resultCount: Number(row.result_count),
    notes: String(row.notes ?? ""),
    industry: String(row.industry),
    location: String(row.location),
    createdAt: Number(row.created_at),
  }));
}

function buildScanContext(industry: string, location: string, targetCount: number) {
  const counts = db.query(`
    SELECT
      COUNT(*) AS matching_companies,
      SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS with_website,
      SUM(CASE WHEN duplicate_status = 'possible_duplicate' THEN 1 ELSE 0 END) AS possible_duplicates
    FROM companies
    WHERE lower(industry) = lower(?1)
      AND lower(location) = lower(?2)
  `).get(industry, location) as Record<string, unknown> | null;
  const total = db.query("SELECT COUNT(*) AS count FROM companies").get() as { count: number } | null;
  const coverage = db.query(`
    SELECT industry, location, COUNT(*) AS company_count
    FROM companies
    WHERE lower(industry) = lower(?1)
       OR lower(location) = lower(?2)
    GROUP BY industry, location
    ORDER BY company_count DESC, industry ASC, location ASC
    LIMIT 50
  `).all(industry, location) as Record<string, unknown>[];
  const recentCompanies = db.query(`
    SELECT *
    FROM companies
    WHERE lower(industry) = lower(?1)
      AND lower(location) = lower(?2)
    ORDER BY updated_at DESC
    LIMIT 25
  `).all(industry, location) as Record<string, unknown>[];

  return {
    industry,
    location,
    targetCount,
    scanMode: scanModeForTargetCount(targetCount),
    currentCounts: {
      matchingCompanies: Number(counts?.matching_companies ?? 0),
      totalCompanies: Number(total?.count ?? 0),
      withWebsite: Number(counts?.with_website ?? 0),
      possibleDuplicates: Number(counts?.possible_duplicates ?? 0),
    },
    coverage: coverage.map((row) => ({
      industry: String(row.industry ?? ""),
      location: String(row.location ?? ""),
      companyCount: Number(row.company_count ?? 0),
    })),
    priorScanStrategies: listScanStrategyHistory(industry, location, 50),
    recentCompanies: recentCompanies.map(mapCompany),
  };
}

function buildKindlingRoleFields(roleKey: string, context: Record<string, unknown>) {
  if (roleKey === "scan_target_list") {
    return {
      industry: String(context.industry ?? ""),
      location: String(context.location ?? ""),
      targetCount: Number(context.targetCount ?? 25),
      scanMode: String(context.scanMode ?? scanModeForTargetCount(Number(context.targetCount ?? 25))),
    };
  }
  if (roleKey === "enrich_company" || roleKey === "draft_outreach") {
    return {
      companyId: String(context.companyId ?? ""),
      companyName: String(context.companyName ?? ""),
    };
  }
  if (roleKey === "develop_service_offering") {
    return {
      history: Array.isArray(context.history) ? context.history : [],
    };
  }
  return {};
}

function buildKindlingTriggerRequest(input: {
  roleKey: string;
  localRequestId: string;
  message: string;
  context: Record<string, unknown>;
  webhookUrl: string;
  webhookToken: string;
  userPubkey: string;
  userNpub: string;
}) {
  const settings = getAppSettings();
  const role = getPipelineRole(input.roleKey);
  const pipelineName = role?.activePipelineSlug || input.roleKey;
  const url = new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineName)}`, toServerAutopilotUrl(settings.autopilotUrl));
  return {
    url: url.toString(),
    method: "POST" as const,
    body: {
      input: {
        source: "kindling-wapp",
        wappId: "kindling",
        pipelineRole: input.roleKey,
        requestId: input.localRequestId,
        roleKey: input.roleKey,
        userPubkey: input.userPubkey,
        userNpub: input.userNpub,
        message: input.message,
        localContext: input.context,
        ...buildKindlingRoleFields(input.roleKey, input.context),
        webhook: {
          url: input.webhookUrl,
          token: input.webhookToken,
          authHeader: "x-kindling-pipeline-token",
        },
      },
    },
  };
}

function kindlingRunNeedsAutopilotAuth(roleSlug: string, authorization?: string) {
  return !authorization && !HTTP_TRIGGER_TOKEN && !/^kindling-.+-stub$/.test(roleSlug);
}

function createKindlingRun(input: {
  roleKey: string;
  localRequestId: string;
  triggerRequest: ReturnType<typeof buildKindlingTriggerRequest>;
  status?: string;
}) {
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = input.triggerRequest.body.input.webhook.token;
  db.query(`
    INSERT INTO kindling_pipeline_runs(
      id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
  `).run(id, input.roleKey, input.localRequestId, input.status || "queued", token, JSON.stringify(input.triggerRequest), now);
  return id;
}

function listCompanies(filters: URLSearchParams | null = null) {
  const clauses: string[] = [];
  const values: string[] = [];
  const add = (column: string, value: string | null) => {
    if (!value) return;
    values.push(value);
    clauses.push(`${column} = ?${values.length}`);
  };
  add("industry", filters?.get("industry") || null);
  add("location", filters?.get("location") || null);
  add("data_ring", filters?.get("dataRing") || null);
  add("duplicate_status", filters?.get("duplicateStatus") || null);
  add("enrichment_status", filters?.get("enrichmentStatus") || null);
  if (filters?.get("hasWebsite") === "yes") clauses.push("website IS NOT NULL AND website != ''");
  if (filters?.get("hasWebsite") === "no") clauses.push("(website IS NULL OR website = '')");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM companies ${where} ORDER BY updated_at DESC, name ASC LIMIT 500`).all(...values) as Record<string, unknown>[];
  return rows.map(mapCompany);
}

function upsertTargetRanking(companyId: string, reason: string, score: Record<string, unknown>) {
  const count = Number((db.query("SELECT COUNT(*) AS count FROM target_rankings").get() as { count: number } | null)?.count ?? 0);
  db.query(`
    INSERT INTO target_rankings(id, company_id, rank, reason, score_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).run(crypto.randomUUID(), companyId, count + 1, reason, JSON.stringify(score), Date.now());
}

async function startKindlingRun(runId: string, authorization?: string) {
  const run = db.query("SELECT * FROM kindling_pipeline_runs WHERE id = ?1").get(runId) as Record<string, unknown> | null;
  if (!run) throw new Error("pipeline run not found");
  const triggerRequest = jsonParse<ReturnType<typeof buildKindlingTriggerRequest>>(run.trigger_payload_json, null as never);
  const token = String(run.webhook_token);
  const role = getPipelineRole(String(run.role_key));
  if (!role?.enabled) throw new Error("pipeline role is disabled");

  const useLocalStub = !authorization && /^kindling-.+-stub$/.test(role.activePipelineSlug);
  if (useLocalStub) {
    scheduleKindlingStubCallback(triggerRequest, token, "local stub");
    db.query("UPDATE kindling_pipeline_runs SET status = 'mock', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3")
      .run(`mock-${crypto.randomUUID()}`, Date.now(), runId);
    return { mode: "mock", runId, status: "mocked" };
  }

  try {
    const res = await fetch(triggerRequest.url, {
      method: triggerRequest.method,
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : HTTP_TRIGGER_TOKEN ? { authorization: `Bearer ${HTTP_TRIGGER_TOKEN}` } : {}),
      },
      body: JSON.stringify(triggerRequest.body),
    });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(payload.error ?? res.statusText));
    const remoteRun = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : {};
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3")
      .run(String(remoteRun.id ?? payload.runId ?? ""), Date.now(), runId);
    return { mode: "autopilot-http", runId: String(remoteRun.id ?? payload.runId ?? runId), status: "running" };
  } catch (error) {
    if (!ALLOW_MOCK) throw error;
    scheduleKindlingStubCallback(triggerRequest, token, error instanceof Error ? error.message : String(error));
    db.query("UPDATE kindling_pipeline_runs SET status = 'mock', autopilot_run_id = ?1, error = ?2, updated_at = ?3 WHERE id = ?4")
      .run(`mock-${crypto.randomUUID()}`, error instanceof Error ? error.message : String(error), Date.now(), runId);
    return { mode: "mock", runId, status: "mocked" };
  }
}

function shouldDeferKindlingAutopilotAuth(body: Record<string, unknown>, roleKey: string) {
  if (body.deferAutopilotAuth !== true) return false;
  const role = getPipelineRole(roleKey);
  return kindlingRunNeedsAutopilotAuth(role?.activePipelineSlug || roleKey);
}

function stubCompanyName(industry: string, location: string, index: number) {
  const industryBase = industry.replace(/[^a-z0-9 ]/gi, "").trim().split(/\s+/).slice(0, 2).join(" ") || "Growth";
  const names = ["Northstar", "Harbor", "Keystone"];
  return `${names[index] || "Signal"} ${industryBase} ${location ? "Co" : "Group"}`.replace(/\s+/g, " ");
}

function scheduleKindlingStubCallback(triggerRequest: ReturnType<typeof buildKindlingTriggerRequest>, token: string, reason: string) {
  const input = triggerRequest.body.input;
  const roleKey = String(input.pipelineRole ?? input.roleKey);
  const context = input.localContext as Record<string, unknown>;
  setTimeout(async () => {
    const records: Record<string, unknown> = {};
    let response = "Kindling stub completed.";
    if (roleKey === "develop_service_offering") {
      const prompt = String(context.prompt ?? input.message ?? "Initial service offering");
      records.marketProfileVersion = {
        summary: prompt.slice(0, 220),
        rationale: "Stubbed from the service-offering workspace prompt.",
        structured: {
          offer: prompt,
          idealCustomer: "Small teams with a clear outbound motion",
          painPoints: ["unclear targeting", "manual prospect research", "slow outreach drafting"],
          outcome: "Sharper target selection and a copyable first pitch",
        },
      };
      response = "Service offering profile updated from stub pipeline.";
    } else if (roleKey === "scan_target_list") {
      const industry = String(context.industry ?? "software services");
      const location = String(context.location ?? "local market");
      const companies = [0, 1, 2].map((index) => ({
        name: stubCompanyName(industry, location, index),
        industry,
        location,
        website: index === 0 ? `https://example-${industry.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.com` : "",
        sourceSummary: `Stub source for ${industry} in ${location}`,
        confidence: 0.42 + index * 0.08,
      }));
      records.companies = companies;
      response = `Created ${companies.length} stub targets for ${industry} in ${location}.`;
    } else if (roleKey === "enrich_company") {
      records.company = {
        id: String(context.companyId ?? ""),
        website: String(context.website ?? "") || "https://example.com",
        dataRing: "enriched",
        enrichmentStatus: "complete",
        confidence: 0.76,
        profile: {
          fitNotes: "Stub enrichment found likely service fit, visible operating complexity, and a simple outreach angle.",
          signals: ["active hiring", "multi-location operations", "manual workflow indicators"],
        },
        sourceSummary: "Stub enrichment source pack",
      };
      response = "Company enrichment completed from stub pipeline.";
    } else if (roleKey === "draft_outreach") {
      const company = String(context.companyName ?? "your team");
      const profile = getCurrentMarketProfile();
      const offer = String(profile?.version?.structured?.offer ?? "help sharpen target research and outbound messaging")
        .replace(/^we\s+/i, "")
        .replace(/[.?!]+$/, "");
      records.outreachDraft = {
        companyId: String(context.companyId ?? ""),
        pitchText: `Hi ${company},\n\nI noticed a few signs that your team may be doing a lot of manual prospect and account research. We ${offer.toLowerCase()}.\n\nWould it be worth comparing notes on where the current process slows down and whether a lightweight research loop could help?`,
      };
      response = "Copyable outreach pitch drafted from stub pipeline.";
    }
    await fetch(input.webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kindling-pipeline-token": token,
      },
      body: JSON.stringify({
        requestId: input.requestId,
        role: roleKey,
        roleKey,
        runId: `mock-${crypto.randomUUID()}`,
        status: "ok",
        response,
        records,
        metadata: { mode: "mock", fallbackReason: reason },
      }),
    }).catch(() => undefined);
  }, 650);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeKindlingCallbackRecords(roleKey: string, body: Record<string, unknown>) {
  const records = objectRecord(body.records);
  if (Object.keys(records).length) return records;
  const result = objectRecord(body.result);
  if (!Object.keys(result).length) return {};

  if (roleKey === "develop_service_offering") {
    const patch = objectRecord(result.profileVersionPatch);
    return {
      marketProfileVersion: {
        summary: String(patch.summary ?? body.response ?? "Service offering updated"),
        rationale: String(patch.rationale ?? ""),
        structured: patch,
        sourceReferences: Array.isArray(patch.sourceReferences) ? patch.sourceReferences : [],
      },
      nextQuestions: Array.isArray(result.nextQuestions) ? result.nextQuestions : [],
    };
  }

  if (roleKey === "scan_target_list") {
    return {
      companies: Array.isArray(result.companies) ? result.companies : [],
      industry: result.industry,
      location: result.location,
      coverage: objectRecord(result.coverage),
      possibleDuplicates: Array.isArray(result.possibleDuplicates) ? result.possibleDuplicates : [],
      searchSlices: Array.isArray(result.searchSlices) ? result.searchSlices : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  }

  if (roleKey === "enrich_company") {
    return {
      company: {
        id: String(result.companyId ?? ""),
        name: String(result.companyName ?? ""),
        dataRing: "enriched",
        enrichmentStatus: "complete",
        confidence: Number(result.confidence ?? 0.75),
        profile: {
          fieldsUpdated: Array.isArray(result.fieldsUpdated) ? result.fieldsUpdated : [],
          gaps: Array.isArray(result.gaps) ? result.gaps : [],
        },
        sources: Array.isArray(result.sources) ? result.sources : [],
        sourceSummary: Array.isArray(result.gaps) && result.gaps.length ? String(result.gaps[0]) : String(body.response ?? "Pipeline enrichment source"),
      },
    };
  }

  if (roleKey === "draft_outreach") {
    const subject = String(result.subject ?? "").trim();
    const bodyText = String(result.body ?? body.response ?? "").trim();
    const variants = Array.isArray(result.variants) ? result.variants as Record<string, unknown>[] : [];
    const variantText = variants
      .map((variant, index) => {
        const label = String(variant.label ?? `Draft ${index + 1}`).trim();
        const variantSubject = String(variant.subject ?? "").trim();
        const variantBody = String(variant.body ?? "").trim();
        return [`## ${label}`, variantSubject, variantBody].filter(Boolean).join("\n\n");
      })
      .filter(Boolean)
      .join("\n\n---\n\n");
    return {
      outreachDraft: {
        companyId: String(result.companyId ?? ""),
        pitchText: variantText || [subject, bodyText].filter(Boolean).join("\n\n"),
        rationale: String(result.rationale ?? ""),
        confidence: Number(result.confidence ?? 0),
      },
    };
  }

  return {};
}

function findExistingScanCompany(company: Record<string, unknown>, records: Record<string, unknown>) {
  const website = String(company.website ?? "").trim();
  if (website) {
    return db.query("SELECT * FROM companies WHERE lower(website) = lower(?1) LIMIT 1").get(website) as Record<string, unknown> | null;
  }
  const name = String(company.name ?? "").trim();
  if (!name) return null;
  const location = String(company.location ?? records.location ?? "").trim();
  const industry = String(company.industry ?? records.industry ?? "").trim();
  return db.query(`
    SELECT *
    FROM companies
    WHERE lower(name) = lower(?1)
      AND lower(COALESCE(location, '')) = lower(?2)
      AND lower(COALESCE(industry, '')) = lower(?3)
    LIMIT 1
  `).get(name, location, industry) as Record<string, unknown> | null;
}

function sourceAlreadyExists(companyId: string, url: string, summary: string) {
  const row = db.query(`
    SELECT 1
    FROM sources
    WHERE company_id = ?1
      AND COALESCE(url, '') = ?2
      AND summary = ?3
    LIMIT 1
  `).get(companyId, url, summary);
  return Boolean(row);
}

function matchingCompanyCountForJob(requestId: string) {
  const job = db.query("SELECT industry, location FROM discovery_jobs WHERE id = ?1").get(requestId) as Record<string, unknown> | null;
  if (!job) return 0;
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM companies
    WHERE lower(COALESCE(industry, '')) = lower(?1)
      AND lower(COALESCE(location, '')) = lower(?2)
  `).get(String(job.industry ?? ""), String(job.location ?? "")) as { count: number } | null;
  return Number(row?.count ?? 0);
}

function persistScanRecords(requestId: string, records: Record<string, unknown>, response: string, jobStatus: "running" | "complete") {
  const now = Date.now();
  const companies = Array.isArray(records.companies) ? records.companies as Record<string, unknown>[] : [];
  let createdCompanies = 0;
  let updatedCompanies = 0;
  for (const company of companies) {
    const existing = findExistingScanCompany(company, records);
    const name = String(company.name ?? "").trim() || "Untitled company";
    const location = String(company.location ?? records.location ?? "");
    const industry = String(company.industry ?? records.industry ?? "");
    const website = String(company.website ?? "");
    const confidence = Number(company.confidence ?? 0.4);
    const companyId = existing ? String(existing.id) : crypto.randomUUID();

    if (existing) {
      db.query(`
        UPDATE companies
        SET location = COALESCE(NULLIF(?1, ''), location),
            industry = COALESCE(NULLIF(?2, ''), industry),
            website = COALESCE(NULLIF(?3, ''), website),
            confidence = MAX(confidence, ?4),
            updated_at = ?5
        WHERE id = ?6
      `).run(location, industry, website, confidence, now, companyId);
      updatedCompanies += 1;
    } else {
      db.query(`
        INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'seed', 'unknown', 'not_started', ?6, '{}', ?7, ?7)
      `).run(companyId, name, location, industry, website, confidence, now);
      recordActivity("company", companyId, "pipeline", "company_created", `Created by scan ${requestId}`, { requestId });
      upsertTargetRanking(companyId, "New scan target with sparse but usable data.", { fit: confidence });
      createdCompanies += 1;
    }

    const sourceUrl = String(company.website ?? "");
    const sourceSummary = String(company.sourceSummary ?? company.evidence ?? "Scan source");
    if (!sourceAlreadyExists(companyId, sourceUrl, sourceSummary)) {
      db.query(`
        INSERT INTO sources(id, company_id, source_type, url, summary, confidence, created_at)
        VALUES (?1, ?2, 'scan', ?3, ?4, ?5, ?6)
      `).run(crypto.randomUUID(), companyId, sourceUrl, sourceSummary, confidence, now);
    }
  }

  let strategyAttempts = 0;
  const slices = Array.isArray(records.searchSlices) ? records.searchSlices as Record<string, unknown>[] : [];
  for (const slice of slices) {
    const strategyType = String(slice.strategyType ?? slice.strategy ?? "search");
    const query = String(slice.query ?? "");
    const location = String(slice.location ?? records.location ?? "");
    const status = String(slice.status ?? "searched");
    const existing = db.query(`
      SELECT 1
      FROM scan_strategy_attempts
      WHERE discovery_job_id = ?1
        AND lower(strategy_type) = lower(?2)
        AND lower(query) = lower(?3)
        AND lower(location) = lower(?4)
        AND status = ?5
      LIMIT 1
    `).get(requestId, strategyType, query, location, status);
    if (existing) continue;
    db.query(`
      INSERT INTO scan_strategy_attempts(
        id, discovery_job_id, industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    `).run(
      crypto.randomUUID(),
      requestId,
      String(slice.industry ?? records.industry ?? ""),
      location,
      strategyType,
      query,
      status,
      Number(slice.resultCount ?? slice.companiesFound ?? 0),
      String(slice.notes ?? ""),
      JSON.stringify(slice),
      now,
    );
    strategyAttempts += 1;
  }

  const companyCount = matchingCompanyCountForJob(requestId);
  db.query("UPDATE discovery_jobs SET status = ?1, company_count = ?2, source_count = ?2, summary = ?3, updated_at = ?4 WHERE id = ?5")
    .run(jobStatus, companyCount, response || (jobStatus === "complete" ? "Scan complete" : "Scan batch written"), now, requestId);
  return { createdCompanies, updatedCompanies, strategyAttempts, matchingCompanies: companyCount };
}

function findKindlingRun(requestId: string, roleKey: string, token: string) {
  return db.query(`
    SELECT * FROM kindling_pipeline_runs
    WHERE local_request_id = ?1 AND role_key = ?2 AND webhook_token = ?3
    ORDER BY created_at DESC
    LIMIT 1
  `).get(requestId, roleKey, token) as Record<string, unknown> | null;
}

function applyKindlingCallback(body: Record<string, unknown>, token: string) {
  const requestId = String(body.requestId ?? "");
  const roleKey = String(body.role ?? body.roleKey ?? "");
  if (!requestId || !roleKey || !token) return { ok: false as const, error: "requestId, role, and token are required" };
  const run = findKindlingRun(requestId, roleKey, token);
  if (!run) return { ok: false as const, error: "webhook target not found" };
  const records = normalizeKindlingCallbackRecords(roleKey, body);
  const now = Date.now();
  const alreadyApplied = Boolean(run.result_payload_json);

  if (!alreadyApplied && roleKey === "develop_service_offering") {
    const versionRecord = records.marketProfileVersion as Record<string, unknown> | undefined;
    const profile = getCurrentMarketProfile();
    const profileId = profile?.id || crypto.randomUUID();
    if (!profile) {
      db.query("INSERT INTO market_profiles(id, name, created_at, updated_at) VALUES (?1, 'Kindling service offering', ?2, ?2)")
        .run(profileId, now);
    }
    const versionCount = Number((db.query("SELECT COUNT(*) AS count FROM market_profile_versions WHERE profile_id = ?1").get(profileId) as { count: number } | null)?.count ?? 0);
    const versionId = crypto.randomUUID();
    db.query(`
      INSERT INTO market_profile_versions(
        id, profile_id, version_number, structured_json, summary, rationale, source_references_json, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `).run(
      versionId,
      profileId,
      versionCount + 1,
      JSON.stringify(versionRecord?.structured ?? {}),
      String(versionRecord?.summary ?? body.response ?? "Service offering updated"),
      String(versionRecord?.rationale ?? ""),
      JSON.stringify(versionRecord?.sourceReferences ?? []),
      now,
    );
    db.query("UPDATE market_profiles SET current_version_id = ?1, updated_at = ?2 WHERE id = ?3").run(versionId, now, profileId);
    recordActivity("market_profile", profileId, "pipeline", "profile_version_created", String(body.response ?? "Service offering updated"), { runId: run.id });
  }

  if (!alreadyApplied && roleKey === "scan_target_list") {
    persistScanRecords(requestId, records, String(body.response ?? "Scan complete"), "complete");
  }

  if (!alreadyApplied && roleKey === "enrich_company") {
    const company = records.company as Record<string, unknown> | undefined;
    const sources = Array.isArray(company?.sources) ? company.sources as Record<string, unknown>[] : [];
    const companyId = String(company?.id ?? requestId);
    const existing = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    const profile = { ...jsonParse<Record<string, unknown>>(existing?.profile_json, {}), ...(company?.profile as Record<string, unknown> | undefined ?? {}) };
    db.query(`
      UPDATE companies
      SET website = COALESCE(NULLIF(?1, ''), website),
          data_ring = ?2,
          enrichment_status = ?3,
          confidence = ?4,
          profile_json = ?5,
          updated_at = ?6
      WHERE id = ?7
    `).run(String(company?.website ?? ""), String(company?.dataRing ?? "enriched"), String(company?.enrichmentStatus ?? "complete"), Number(company?.confidence ?? 0.75), JSON.stringify(profile), now, companyId);
    db.query("UPDATE enrichment_requests SET status = 'complete', summary = ?1, updated_at = ?2 WHERE id = ?3")
      .run(String(body.response ?? "Enrichment complete"), now, requestId);
    if (sources.length) {
      for (const source of sources) {
        db.query(`
          INSERT INTO sources(id, company_id, source_type, url, summary, confidence, created_at)
          VALUES (?1, ?2, 'pipeline_enrichment', ?3, ?4, ?5, ?6)
        `).run(
          crypto.randomUUID(),
          companyId,
          String(source.url ?? ""),
          String(source.summary ?? source.title ?? "Pipeline enrichment source"),
          Number(source.confidence ?? company?.confidence ?? 0.75),
          now,
        );
      }
    } else {
      db.query(`
        INSERT INTO sources(id, company_id, source_type, url, summary, confidence, created_at)
        VALUES (?1, ?2, 'stub_enrichment', ?3, ?4, ?5, ?6)
      `).run(crypto.randomUUID(), companyId, String(company?.website ?? ""), String(company?.sourceSummary ?? "Stub enrichment source"), Number(company?.confidence ?? 0.75), now);
    }
    recordActivity("company", companyId, "pipeline", "company_enriched", String(body.response ?? "Enrichment complete"), { requestId });
    upsertTargetRanking(companyId, "Enriched company with stronger service fit signals.", { fit: Number(company?.confidence ?? 0.75) });
  }

  if (!alreadyApplied && roleKey === "draft_outreach") {
    const draft = records.outreachDraft as Record<string, unknown> | undefined;
    const companyId = String(draft?.companyId ?? requestId);
    db.query(`
      INSERT INTO outreach_drafts(id, company_id, pitch_text, status, source_run_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?5)
    `).run(crypto.randomUUID(), companyId, String(draft?.pitchText ?? body.response ?? ""), String(run.id), now);
    recordActivity("company", companyId, "pipeline", "outreach_drafted", String(body.response ?? "Outreach drafted"), { requestId });
  }

  db.query(`
    UPDATE kindling_pipeline_runs
    SET status = ?1, autopilot_run_id = COALESCE(?2, autopilot_run_id), result_payload_json = ?3, updated_at = ?4
    WHERE id = ?5
  `).run(String(body.status ?? "complete"), String(body.runId ?? "") || null, JSON.stringify(body), now, String(run.id));
  return { ok: true as const };
}

function buildAutopilotPipelinesRequest(autopilotUrl = getAppSettings().autopilotUrl) {
  return {
    url: new URL("/api/pipelines/definitions", autopilotUrl).toString(),
    method: "GET" as const,
  };
}

function normalizeAccessRole(value: unknown): AccessRole | null {
  return value === "read" || value === "edit" ? value : null;
}

function requireEditSession(req: Request) {
  const session = requireSession(req);
  if (!session) return null;
  return hasAccess(session.pubkey, "edit") ? session : null;
}

function getChatForUser(chatId: string, pubkey: string) {
  const row = db.query("SELECT * FROM chats WHERE id = ?1 AND pubkey = ?2").get(chatId, pubkey) as Record<string, unknown> | null;
  return row ? mapChat(row) : null;
}

function listMessages(chatId: string, pubkey: string): Message[] {
  const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 AND pubkey = ?2 ORDER BY created_at ASC").all(chatId, pubkey) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

function updateChatTitle(chatId: string, title: string) {
  db.query("UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3").run(title.slice(0, 80), Date.now(), chatId);
}

function webhookOrigin(req: Request): string {
  return PUBLIC_ORIGIN || new URL(req.url).origin;
}

export async function handleApi(req: Request, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/api/health" && req.method === "GET") {
    return json({ ok: true, now: new Date().toISOString() });
  }

  if (pathname === "/api/auth/challenge" && req.method === "POST") {
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.pubkey ?? ""));
    if (!pubkey) return json({ error: "pubkey must be a 64-char hex key or npub" }, 400);
    return json({ pubkey, npub: pubkeyToNpub(pubkey), ...createChallenge(pubkey) });
  }

  if (pathname === "/api/auth/verify" && req.method === "POST") {
    const body = await readJson(req);
    const event = body.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return json({ error: "event is required" }, 400);
    const result = verifyLoginEvent(event as NostrEvent);
    return result.ok ? json(result) : json({ error: result.error }, 401);
  }

  if (pathname === "/api/me" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({
      pubkey: session.pubkey,
      npub: pubkeyToNpub(session.pubkey),
      expiresAt: session.expiresAt,
      access: {
        login: canLogin(session.pubkey),
        read: hasAccess(session.pubkey, "read"),
        edit: hasAccess(session.pubkey, "edit"),
      },
    });
  }

  if (pathname === "/api/settings" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ settings: getAppSettings(), accessRules: getAccessRules() });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const autopilotUrl = body.autopilotUrl === undefined ? null : normalizeAutopilotUrl(body.autopilotUrl);
    const defaultPipeline = body.defaultPipeline === undefined ? null : normalizePipelineName(body.defaultPipeline);
    if (body.autopilotUrl !== undefined && !autopilotUrl) return json({ error: "autopilotUrl must be a valid http(s) URL" }, 400);
    if (body.defaultPipeline !== undefined && !defaultPipeline) return json({ error: "defaultPipeline is required" }, 400);
    if (autopilotUrl) setSetting("autopilotUrl", autopilotUrl);
    if (defaultPipeline) setSetting("defaultPipeline", defaultPipeline);
    return json({ settings: getAppSettings() });
  }

  if (pathname === "/api/access-rules" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ accessRules: getAccessRules() });
  }

  if (pathname === "/api/access-rules" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const pubkey = normalizePubkey(String(body.npub ?? body.pubkey ?? ""));
    const role = normalizeAccessRole(body.role);
    if (!pubkey) return json({ error: "npub or pubkey is required" }, 400);
    if (!role) return json({ error: "role must be read or edit" }, 400);
    return json({ accessRule: addAccessRule(pubkey, role), accessRules: getAccessRules() }, 201);
  }

  const accessRuleMatch = pathname.match(/^\/api\/access-rules\/(read|edit)\/([^/]+)$/);
  if (accessRuleMatch && req.method === "DELETE") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const role = normalizeAccessRole(accessRuleMatch[1]);
    const pubkey = normalizePubkey(decodeURIComponent(accessRuleMatch[2]!));
    if (!role || !pubkey) return json({ error: "valid role and npub/pubkey are required" }, 400);
    removeAccessRule(pubkey, role);
    return json({ ok: true, accessRules: getAccessRules() });
  }

  if (pathname === "/api/autopilot/pipelines-request" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ triggerRequest: buildAutopilotPipelinesRequest(), settings: getAppSettings() });
  }

  if (pathname === "/api/autopilot/pipelines" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const body = await readJson(req);
    const autopilotUrl = body.autopilotUrl === undefined || String(body.autopilotUrl).trim() === ""
      ? getAppSettings().autopilotUrl
      : normalizeAutopilotUrl(body.autopilotUrl);
    if (!autopilotUrl) return json({ error: "autopilotUrl must be a valid http(s) URL" }, 400);
    const request = buildAutopilotPipelinesRequest(toServerAutopilotUrl(autopilotUrl));
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) {
      return json({ requiresAutopilotAuth: true, triggerRequest: request, settings: getAppSettings() }, 202);
    }
    try {
      const res = await fetch(request.url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: autopilotAuthorization,
        },
      });
      const text = await res.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? JSON.parse(text) as Record<string, unknown> : {};
      } catch {
        payload = { error: text.slice(0, 500) };
      }
      if (!res.ok) return json({ error: `Autopilot pipeline list failed (${res.status}): ${String(payload.error ?? res.statusText)}`, status: res.status }, 424);
      const definitions = Array.isArray(payload.definitions) ? payload.definitions : Array.isArray(payload.pipelines) ? payload.pipelines : [];
      return json({ pipelines: definitions, raw: payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: `Autopilot pipeline list failed: ${message}`, url: request.url }, 424);
    }
  }

  if (pathname === "/api/kindling/summary" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const companies = listCompanies();
    const recentRuns = (db.query("SELECT * FROM kindling_pipeline_runs ORDER BY updated_at DESC LIMIT 12").all() as Record<string, unknown>[]).map(mapRun);
    const discoveryJobs = (db.query("SELECT * FROM discovery_jobs ORDER BY updated_at DESC LIMIT 8").all() as Record<string, unknown>[]).map(rowJson);
    const outreachDrafts = (db.query(`
      SELECT od.*, c.name AS company_name
      FROM outreach_drafts od
      JOIN companies c ON c.id = od.company_id
      ORDER BY od.updated_at DESC
      LIMIT 20
    `).all() as Record<string, unknown>[]).map(rowJson);
    return json({
      profile: getCurrentMarketProfile(),
      companies,
      discoveryJobs,
      outreachDrafts,
      pipelineRoles: listPipelineRoles(),
      recentRuns,
      counts: {
        companies: companies.length,
        outreachReady: companies.filter((company) => company.enrichmentStatus === "complete").length,
        activeRuns: recentRuns.filter((run) => ["queued", "running", "mock"].includes(run.status)).length,
      },
    });
  }

  if (pathname === "/api/kindling/pipeline-roles" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ pipelineRoles: listPipelineRoles() });
  }

  if (pathname === "/api/kindling/pipeline-roles" && req.method === "PUT") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const roles = Array.isArray(body.roles) ? body.roles as Record<string, unknown>[] : [];
    const now = Date.now();
    for (const role of roles) {
      const roleKey = String(role.roleKey ?? "");
      if (!roleKey) continue;
      db.query(`
        UPDATE pipeline_roles
        SET active_pipeline_slug = ?1,
            pipeline_label = ?2,
            enabled = ?3,
            updated_at = ?4
        WHERE role_key = ?5
      `).run(
        String(role.activePipelineSlug ?? roleKey).trim() || roleKey,
        String(role.pipelineLabel ?? role.activePipelineSlug ?? roleKey).trim() || roleKey,
        role.enabled === false ? 0 : 1,
        now,
        roleKey,
      );
    }
    return json({ pipelineRoles: listPipelineRoles() });
  }

  if (pathname === "/api/kindling/service-offering" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return json({ error: "prompt is required" }, 400);
    const localRequestId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "develop_service_offering",
      localRequestId,
      message: prompt,
      context: { prompt, currentProfile: getCurrentMarketProfile() },
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "develop_service_offering", localRequestId, triggerRequest, status: "queued" });
    if (shouldDeferKindlingAutopilotAuth(body, "develop_service_offering")) {
      return json({ requiresAutopilotAuth: true, runId, localRequestId, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    return json({ runId, localRequestId, triggerRequest });
  }

  if (pathname === "/api/kindling/target-scans" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const industry = String(body.industry ?? "").trim();
    const location = String(body.location ?? "").trim();
    const targetCount = clampTargetCount(body.targetCount);
    const scanMode = scanModeForTargetCount(targetCount);
    if (!industry || !location) return json({ error: "industry and location are required" }, 400);
    const now = Date.now();
    const jobId = crypto.randomUUID();
    db.query(`
      INSERT INTO discovery_jobs(id, industry, location, target_count, scan_mode, status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)
    `).run(jobId, industry, location, targetCount, scanMode, now);
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const scanContext = buildScanContext(industry, location, targetCount);
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "scan_target_list",
      localRequestId: jobId,
      message: `Find up to ${targetCount} target companies for ${industry} in ${location}`,
      context: {
        industry,
        location,
        targetCount,
        scanMode,
        profile: getCurrentMarketProfile(),
        scanContext,
        priorScanStrategies: scanContext.priorScanStrategies,
        scanContextApi: {
          url: `${webhookOrigin(req)}/api/nip98/kindling/scan-context?industry=${encodeURIComponent(industry)}&location=${encodeURIComponent(location)}&targetCount=${targetCount}`,
          auth: "nip98-read",
        },
        writeApi: {
          url: `${webhookOrigin(req)}/api/kindling/pipeline-write/target-scan`,
          token: webhookToken,
          authHeader: "x-kindling-pipeline-token",
        },
      },
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "scan_target_list", localRequestId: jobId, triggerRequest, status: "queued" });
    if (shouldDeferKindlingAutopilotAuth(body, "scan_target_list")) {
      return json({ requiresAutopilotAuth: true, runId, jobId, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    return json({ runId, jobId, triggerRequest }, 201);
  }

  if (pathname === "/api/kindling/companies" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({ companies: listCompanies(url.searchParams) });
  }

  if (pathname === "/api/kindling/companies" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name is required" }, 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'not_started', ?8, ?9, ?10, ?10)
    `).run(
      id,
      name,
      String(body.location ?? "").trim(),
      String(body.industry ?? "").trim(),
      String(body.website ?? "").trim(),
      String(body.dataRing ?? "manual"),
      String(body.duplicateStatus ?? "unknown"),
      Number(body.confidence ?? 0),
      JSON.stringify({ notes: String(body.notes ?? "").trim() }),
      now,
    );
    recordActivity("company", id, "user", "company_created", "Manual company created", { pubkey: session.pubkey });
    const company = db.query("SELECT * FROM companies WHERE id = ?1").get(id) as Record<string, unknown>;
    return json({ company: mapCompany(company) }, 201);
  }

  const companyMatch = pathname.match(/^\/api\/kindling\/companies\/([^/]+)$/);
  if (companyMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const companyId = decodeURIComponent(companyMatch[1]!);
    const row = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!row) return json({ error: "company not found" }, 404);
    const sources = (db.query("SELECT * FROM sources WHERE company_id = ?1 ORDER BY created_at DESC").all(companyId) as Record<string, unknown>[]).map(rowJson);
    const activities = (db.query("SELECT * FROM activities WHERE target_type = 'company' AND target_id = ?1 ORDER BY created_at DESC LIMIT 50").all(companyId) as Record<string, unknown>[]).map(rowJson);
    const drafts = (db.query("SELECT * FROM outreach_drafts WHERE company_id = ?1 ORDER BY updated_at DESC").all(companyId) as Record<string, unknown>[]).map(rowJson);
    return json({ company: mapCompany(row), sources, activities, drafts });
  }

  if (companyMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const companyId = decodeURIComponent(companyMatch[1]!);
    const existing = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!existing) return json({ error: "company not found" }, 404);
    const body = await readJson(req);
    const now = Date.now();
    const profile = { ...jsonParse<Record<string, unknown>>(existing.profile_json, {}), notes: String(body.notes ?? jsonParse<Record<string, unknown>>(existing.profile_json, {}).notes ?? "") };
    db.query(`
      UPDATE companies
      SET name = ?1, location = ?2, industry = ?3, website = ?4, data_ring = ?5,
          duplicate_status = ?6, enrichment_status = ?7, confidence = ?8, profile_json = ?9, updated_at = ?10
      WHERE id = ?11
    `).run(
      String(body.name ?? existing.name).trim() || String(existing.name),
      String(body.location ?? existing.location ?? "").trim(),
      String(body.industry ?? existing.industry ?? "").trim(),
      String(body.website ?? existing.website ?? "").trim(),
      String(body.dataRing ?? existing.data_ring),
      String(body.duplicateStatus ?? existing.duplicate_status),
      String(body.enrichmentStatus ?? existing.enrichment_status),
      Number(body.confidence ?? existing.confidence ?? 0),
      JSON.stringify(profile),
      now,
      companyId,
    );
    recordActivity("company", companyId, "user", "company_updated", "Company profile edited", { pubkey: session.pubkey });
    const row = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown>;
    return json({ company: mapCompany(row) });
  }

  const enrichMatch = pathname.match(/^\/api\/kindling\/companies\/([^/]+)\/enrich$/);
  if (enrichMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const companyId = decodeURIComponent(enrichMatch[1]!);
    const company = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!company) return json({ error: "company not found" }, 404);
    const body = await readJson(req);
    const now = Date.now();
    const requestId = crypto.randomUUID();
    db.query("INSERT INTO enrichment_requests(id, company_id, status, request_kind, created_at, updated_at) VALUES (?1, ?2, 'queued', ?3, ?4, ?4)")
      .run(requestId, companyId, String(body.requestKind ?? "standard"), now);
    db.query("UPDATE companies SET enrichment_status = 'queued', updated_at = ?1 WHERE id = ?2").run(now, companyId);
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "enrich_company",
      localRequestId: requestId,
      message: `Enrich ${String(company.name)}`,
      context: { companyId, companyName: String(company.name), website: String(company.website ?? ""), industry: String(company.industry ?? ""), location: String(company.location ?? "") },
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "enrich_company", localRequestId: requestId, triggerRequest, status: "queued" });
    if (shouldDeferKindlingAutopilotAuth(body, "enrich_company")) {
      return json({ requiresAutopilotAuth: true, runId, requestId, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    return json({ runId, requestId, triggerRequest }, 201);
  }

  const outreachMatch = pathname.match(/^\/api\/kindling\/companies\/([^/]+)\/outreach$/);
  if (outreachMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const companyId = decodeURIComponent(outreachMatch[1]!);
    const company = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!company) return json({ error: "company not found" }, 404);
    const body = await readJson(req);
    const requestId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "draft_outreach",
      localRequestId: requestId,
      message: `Draft outreach for ${String(company.name)}`,
      context: { companyId, companyName: String(company.name), company: mapCompany(company), activeProfileVersion: getCurrentMarketProfile()?.version ?? null, profile: getCurrentMarketProfile() },
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "draft_outreach", localRequestId: requestId, triggerRequest, status: "queued" });
    if (shouldDeferKindlingAutopilotAuth(body, "draft_outreach")) {
      return json({ requiresAutopilotAuth: true, runId, requestId, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    return json({ runId, requestId, triggerRequest }, 201);
  }

  if (pathname === "/api/kindling/todays-targets" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const rows = db.query(`
      SELECT tr.*, c.name, c.location, c.industry, c.website, c.enrichment_status
      FROM target_rankings tr
      JOIN companies c ON c.id = tr.company_id
      ORDER BY tr.rank ASC, tr.created_at DESC
      LIMIT 30
    `).all() as Record<string, unknown>[];
    return json({ targets: rows.map(rowJson) });
  }

  const kindlingStartMatch = pathname.match(/^\/api\/kindling\/pipeline-runs\/([^/]+)\/start$/);
  if (kindlingStartMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const result = await startKindlingRun(decodeURIComponent(kindlingStartMatch[1]!), String(body.autopilotAuthorization ?? "").trim());
    return json({ result });
  }

  if (pathname === "/api/kindling/pipeline-webhook" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-kindling-pipeline-token") || req.headers.get("x-kindling-wapp-token") || String(body.token ?? "");
    const result = applyKindlingCallback(body, token);
    return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
  }

  if (pathname === "/api/kindling/pipeline-write/target-scan" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-kindling-pipeline-token") || String(body.token ?? "");
    const requestId = String(body.requestId ?? "");
    const run = requestId && token ? findKindlingRun(requestId, "scan_target_list", token) : null;
    if (!run) return json({ error: "webhook target not found" }, 400);
    const records = normalizeKindlingCallbackRecords("scan_target_list", {
      ...body,
      role: "scan_target_list",
      status: "running",
    });
    const persisted = persistScanRecords(requestId, records, String(body.response ?? "Scan batch written"), "running");
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', updated_at = ?1 WHERE id = ?2")
      .run(Date.now(), String(run.id));
    return json({ ok: true, persisted });
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const rows = db.query(`
      SELECT c.*, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      WHERE c.pubkey = ?1
      ORDER BY c.updated_at DESC
    `).all(session.pubkey) as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), preview: String(row.preview ?? "") })) });
  }

  if (pathname === "/api/chats" && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO chats(id, pubkey, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
      .run(id, session.pubkey, "New chat", now);
    return json({ chat: getChatForUser(id, session.pubkey) }, 201);
  }

  const chatMessagesMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (chatMessagesMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    return json({ chat, messages: listMessages(chatId, session.pubkey) });
  }

  if (chatMessagesMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const chatId = decodeURIComponent(chatMessagesMatch[1]!);
    const chat = getChatForUser(chatId, session.pubkey);
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    if (content.length > 12000) return json({ error: "content is too long" }, 400);

    const now = Date.now();
    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const localRunId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'user', ?4, 'complete', ?5, ?6)")
      .run(userMessageId, chatId, session.pubkey, content, localRunId, now);
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, 'assistant', '', 'pending', ?4, ?5)")
      .run(assistantMessageId, chatId, session.pubkey, localRunId, now + 1);
    if (chat.title === "New chat") updateChatTitle(chatId, content.replace(/\s+/g, " ").slice(0, 64));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);

    const history = listMessages(chatId, session.pubkey)
      .filter((msg) => msg.status === "complete" && (msg.role === "user" || msg.role === "assistant"))
      .slice(-30)
      .map((msg) => ({ role: msg.role, content: msg.content, createdAt: msg.createdAt }));

    const webhookUrl = `${webhookOrigin(req)}/api/pipeline-webhook`;
    const settings = getAppSettings();
    const triggerRequest = buildPipelineTriggerRequest({
      chatId,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
      message: content,
      history,
      webhookUrl,
      webhookToken,
      autopilotUrl: toServerAutopilotUrl(settings.autopilotUrl),
      pipelineName: settings.defaultPipeline,
    });
    db.query(`
      INSERT INTO pipeline_runs(
        id, chat_id, user_message_id, assistant_message_id, trigger_status, webhook_token, trigger_payload_json, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 'awaiting-user-nip98', ?5, ?6, ?7, ?7)
    `).run(localRunId, chatId, userMessageId, assistantMessageId, webhookToken, JSON.stringify(triggerRequest), now);

    const autopilotAuthorization = typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "";
    if (!autopilotAuthorization) {
      return json({
        requiresAutopilotAuth: true,
        triggerRequest,
        messages: listMessages(chatId, session.pubkey),
        runId: localRunId,
      }, 202);
    }

    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), localRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, assistantMessageId);
      db.query("UPDATE pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), localRunId);
    }

    return json({ messages: listMessages(chatId, session.pubkey), runId: localRunId }, 202);
  }

  const pipelineStartMatch = pathname.match(/^\/api\/pipeline-runs\/([^/]+)\/start$/);
  if (pipelineStartMatch && req.method === "POST") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const runId = decodeURIComponent(pipelineStartMatch[1]!);
    const body = await readJson(req);
    const autopilotAuthorization = String(body.autopilotAuthorization ?? "").trim();
    if (!autopilotAuthorization) return json({ error: "autopilotAuthorization is required" }, 400);
    const run = db.query(`
      SELECT pr.*, c.pubkey
      FROM pipeline_runs pr
      JOIN chats c ON c.id = pr.chat_id
      WHERE pr.id = ?1 AND c.pubkey = ?2
    `).get(runId, session.pubkey) as Record<string, unknown> | null;
    if (!run) return json({ error: "pipeline run not found" }, 404);
    if (String(run.trigger_status) === "complete") {
      return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
    }
    const rawTrigger = String(run.trigger_payload_json ?? "");
    if (!rawTrigger) return json({ error: "pipeline trigger payload missing" }, 409);
    let triggerRequest: PipelineTriggerRequest;
    try {
      triggerRequest = JSON.parse(rawTrigger) as PipelineTriggerRequest;
    } catch {
      return json({ error: "pipeline trigger payload is invalid" }, 409);
    }
    try {
      const result = await startPreparedChatPipeline(triggerRequest, autopilotAuthorization);
      db.query("UPDATE pipeline_runs SET trigger_status = ?1, autopilot_run_id = ?2, updated_at = ?3 WHERE id = ?4")
        .run(result.mode, result.runId, Date.now(), runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.query("UPDATE messages SET status = 'error', content = ?1 WHERE id = ?2").run(message, String(run.assistant_message_id));
      db.query("UPDATE pipeline_runs SET trigger_status = 'error', error = ?1, updated_at = ?2 WHERE id = ?3")
        .run(message, Date.now(), runId);
    }
    return json({ messages: listMessages(String(run.chat_id), session.pubkey), runId });
  }

  if (pathname === "/api/pipeline-webhook" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-chat-wapp-token") || String(body.token ?? "");
    const chatId = String(body.chatId ?? "");
    const response = String(body.response ?? body.message ?? "").trim();
    const runId = String(body.runId ?? "");
    if (!chatId || !token || !response) return json({ error: "chatId, token, and response are required" }, 400);
    const run = db.query("SELECT * FROM pipeline_runs WHERE chat_id = ?1 AND webhook_token = ?2 ORDER BY created_at DESC LIMIT 1")
      .get(chatId, token) as Record<string, unknown> | null;
    if (!run) return json({ error: "webhook target not found" }, 404);
    const now = Date.now();
    db.query("UPDATE messages SET content = ?1, status = 'complete', run_id = ?2 WHERE id = ?3")
      .run(response, runId || String(run.id), String(run.assistant_message_id));
    db.query("UPDATE pipeline_runs SET trigger_status = 'complete', autopilot_run_id = COALESCE(?1, autopilot_run_id), updated_at = ?2 WHERE id = ?3")
      .run(runId || null, now, String(run.id));
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ ok: true });
  }

  if (pathname === "/api/nip98/me" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    return json({
      pubkey: verified.pubkey,
      npub: verified.npub,
      access: {
        login: canLogin(verified.pubkey),
        read: hasAccess(verified.pubkey, "read"),
        edit: hasAccess(verified.pubkey, "edit"),
      },
    });
  }

  if (pathname === "/api/nip98/pipeline-roles" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    return json({ pipelineRoles: listPipelineRoles() });
  }

  if (pathname === "/api/nip98/kindling/scan-context" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const industry = String(url.searchParams.get("industry") ?? "").trim();
    const location = String(url.searchParams.get("location") ?? "").trim();
    if (!industry || !location) return json({ error: "industry and location are required" }, 400);
    return json({ scanContext: buildScanContext(industry, location, clampTargetCount(url.searchParams.get("targetCount"))) });
  }

  if (pathname === "/api/nip98/kindling/scan-results" && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const requestId = String(body.requestId ?? "").trim();
    if (!requestId) return json({ error: "requestId is required" }, 400);
    const job = db.query("SELECT * FROM discovery_jobs WHERE id = ?1").get(requestId) as Record<string, unknown> | null;
    if (!job) return json({ error: "discovery job not found" }, 404);
    const records = normalizeKindlingCallbackRecords("scan_target_list", {
      ...body,
      role: "scan_target_list",
      status: String(body.status ?? "running"),
    });
    const final = body.final === true || String(body.status ?? "") === "complete";
    const persisted = persistScanRecords(requestId, records, String(body.response ?? ""), final ? "complete" : "running");
    const run = db.query(`
      SELECT * FROM kindling_pipeline_runs
      WHERE local_request_id = ?1 AND role_key = 'scan_target_list'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(requestId) as Record<string, unknown> | null;
    if (run) {
      db.query("UPDATE kindling_pipeline_runs SET status = ?1, updated_at = ?2 WHERE id = ?3")
        .run(final ? "complete" : "running", Date.now(), String(run.id));
    }
    return json({ ok: true, persisted });
  }

  const nip98ContextMatch = pathname.match(/^\/api\/nip98\/context\/([^/]+)$/);
  if (nip98ContextMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const requestId = decodeURIComponent(nip98ContextMatch[1]!);
    const run = db.query("SELECT * FROM kindling_pipeline_runs WHERE local_request_id = ?1 ORDER BY created_at DESC LIMIT 1").get(requestId) as Record<string, unknown> | null;
    return json({
      requestId,
      run: run ? mapRun(run) : null,
      profile: getCurrentMarketProfile(),
      companies: listCompanies(),
    });
  }

  if (pathname === "/api/nip98/companies" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    return json({ companies: listCompanies(url.searchParams) });
  }

  if (pathname === "/api/nip98/companies" && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name is required" }, 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query(`
      INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    `).run(
      id,
      name,
      String(body.location ?? "").trim(),
      String(body.industry ?? "").trim(),
      String(body.website ?? "").trim(),
      String(body.dataRing ?? "agent"),
      String(body.duplicateStatus ?? "unknown"),
      String(body.enrichmentStatus ?? "not_started"),
      Number(body.confidence ?? 0),
      JSON.stringify(body.profile && typeof body.profile === "object" ? body.profile : {}),
      now,
    );
    recordActivity("company", id, "agent", "company_created", "Created through NIP-98 API", { pubkey: verified.pubkey });
    const company = db.query("SELECT * FROM companies WHERE id = ?1").get(id) as Record<string, unknown>;
    return json({ company: mapCompany(company) }, 201);
  }

  const nip98CompanyMatch = pathname.match(/^\/api\/nip98\/companies\/([^/]+)$/);
  if (nip98CompanyMatch && req.method === "PATCH") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const companyId = decodeURIComponent(nip98CompanyMatch[1]!);
    const existing = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!existing) return json({ error: "company not found" }, 404);
    const body = await readJson(req);
    const now = Date.now();
    const profile = {
      ...jsonParse<Record<string, unknown>>(existing.profile_json, {}),
      ...(body.profile && typeof body.profile === "object" && !Array.isArray(body.profile) ? body.profile as Record<string, unknown> : {}),
    };
    db.query(`
      UPDATE companies
      SET name = ?1, location = ?2, industry = ?3, website = ?4, data_ring = ?5,
          duplicate_status = ?6, enrichment_status = ?7, confidence = ?8, profile_json = ?9, updated_at = ?10
      WHERE id = ?11
    `).run(
      String(body.name ?? existing.name).trim() || String(existing.name),
      String(body.location ?? existing.location ?? "").trim(),
      String(body.industry ?? existing.industry ?? "").trim(),
      String(body.website ?? existing.website ?? "").trim(),
      String(body.dataRing ?? existing.data_ring),
      String(body.duplicateStatus ?? existing.duplicate_status),
      String(body.enrichmentStatus ?? existing.enrichment_status),
      Number(body.confidence ?? existing.confidence ?? 0),
      JSON.stringify(profile),
      now,
      companyId,
    );
    recordActivity("company", companyId, "agent", "company_updated", "Updated through NIP-98 API", { pubkey: verified.pubkey });
    const row = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown>;
    return json({ company: mapCompany(row) });
  }

  if (pathname === "/api/nip98/chats" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const rows = db.query(`
      SELECT c.*, u.npub, (
        SELECT content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1
      ) AS preview
      FROM chats c
      JOIN users u ON u.pubkey = c.pubkey
      ORDER BY c.updated_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[];
    return json({ chats: rows.map((row) => ({ ...mapChat(row), npub: String(row.npub), preview: String(row.preview ?? "") })) });
  }

  const nip98ChatMessagesMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)\/messages$/);
  if (nip98ChatMessagesMatch && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT c.*, u.npub FROM chats c JOIN users u ON u.pubkey = c.pubkey WHERE c.id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const rows = db.query("SELECT * FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC").all(chatId) as Record<string, unknown>[];
    return json({ chat: { ...mapChat(chat), npub: String(chat.npub) }, messages: rows.map(mapMessage) });
  }

  if (nip98ChatMessagesMatch && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMessagesMatch[1]!);
    const chat = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!chat) return json({ error: "chat not found" }, 404);
    const body = await readJson(req);
    const role = ["assistant", "system", "user"].includes(String(body.role)) ? String(body.role) : "system";
    const content = String(body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    const now = Date.now();
    const id = crypto.randomUUID();
    db.query("INSERT INTO messages(id, chat_id, pubkey, role, content, status, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'complete', ?6, ?7)")
      .run(id, chatId, String(chat.pubkey), role, content, String(body.runId ?? ""), now);
    db.query("UPDATE chats SET updated_at = ?1 WHERE id = ?2").run(now, chatId);
    return json({ message: mapMessage(db.query("SELECT * FROM messages WHERE id = ?1").get(id) as Record<string, unknown>) }, 201);
  }

  const nip98ChatMatch = pathname.match(/^\/api\/nip98\/chats\/([^/]+)$/);
  if (nip98ChatMatch && req.method === "PATCH") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const chatId = decodeURIComponent(nip98ChatMatch[1]!);
    const body = await readJson(req);
    const title = String(body.title ?? "").trim();
    if (!title) return json({ error: "title is required" }, 400);
    updateChatTitle(chatId, title);
    const row = db.query("SELECT * FROM chats WHERE id = ?1").get(chatId) as Record<string, unknown> | null;
    if (!row) return json({ error: "chat not found" }, 404);
    return json({ chat: mapChat(row) });
  }

  return null;
}

if (import.meta.main) {
  setInterval(cleanupExpiredAuthRows, 15 * 60 * 1000);

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await handleApi(req, url);
        if (response) return response;
        return json({ error: "not found" }, 404);
      }
      return serveStatic(url.pathname);
    },
  });

  console.log(`kindling-wapp listening on ${server.url}`);
}
