import { spawnSync } from "node:child_process";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { PIPELINE_NAME, PORT, PUBLIC_ORIGIN, WINGMAN_URL } from "./config.ts";
import { db } from "./db.ts";
import { pubkeyToNpub } from "./auth.ts";

const DEFAULT_BATCH_LIMIT = 21;
const PETE_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";
const DEFAULT_DM_CHANNEL_ID = "97ae5c0d-f88c-41e7-9f7a-d64d27a4fd18";
const DEFAULT_PIPELINE_RUN_BASE_URL = "https://rick.runwingman.com/pipelines/runs";
const WM21_ROOT = process.env.KINDLING_PIPELINE_WORKING_DIRECTORY || "/workspace/athena-kindling";
const SCHEDULED_PIPELINE_AGENT = process.env.KINDLING_SCHEDULED_PIPELINE_AGENT || "claude";
const SCHEDULED_PIPELINE_MODEL = process.env.KINDLING_SCHEDULED_PIPELINE_MODEL || "";
const SCHEDULED_PIPELINE_WORKING_DIRECTORY = process.env.KINDLING_PIPELINE_WORKING_DIRECTORY || "/workspace/athena-kindling";

const INDUSTRY_ENRICHMENT_STRATEGIES = [
  {
    key: "official_website",
    label: "Official website",
    instruction: "Find or verify the company's official website, services, operating areas, and public contact paths.",
  },
  {
    key: "search_results",
    label: "Search result corroboration",
    instruction: "Check independent search results/directories for corroborating summaries and alternative public URLs.",
  },
  {
    key: "blog_news_resources",
    label: "Blog, news, and resources",
    instruction: "Look for blogs, news, publications, case studies, resources, or updates that indicate active practice areas and business signals.",
  },
  {
    key: "people_team",
    label: "People and team",
    instruction: "Identify named decision-makers and senior leaders (directors, MD/CEO, owners, heads of practice or department). Crawl /our-people/, /team/, /about/ and individual staff profile pages. For each, capture name, title, and publicly-listed business contact details (direct email, phone/mobile, LinkedIn URL), and infer the email pattern (e.g. firstnamelastname@domain). Treat company-published business contact details as public; do not scrape gated or private personal data. Return a structured decisionMakers array on profilePatch plus one signal per decision-maker (signal_type 'decision_maker_contact').",
  },
  {
    key: "fit_signals",
    label: "Kindling fit signals",
    instruction: "Summarise service-fit signals, operating complexity, visible gaps, and caveats for downstream scoring/outreach.",
  },
];

type JsonObject = Record<string, unknown>;

export type AutoEnrichmentResult =
  | {
      status: "skipped";
      reason: "no_unprocessed_companies" | "industry_enrichment_already_running";
      checkedAt: string;
    }
  | {
      status: "started";
      industry: string;
      batchId: string;
      localRunId: string;
      autopilotRunId: string;
      pipelineUrl: string;
      batchSize: number;
      dmSent: boolean;
      checkedAt: string;
    };

export interface AutoEnrichmentOptions {
  batchLimit?: number;
  publicOrigin?: string;
  autopilotUrl?: string;
  pipelineRunBaseUrl?: string;
  dmChannelId?: string;
  sendDm?: boolean;
  userNpub?: string;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normaliseUrl(value: string) {
  return value.replace(/\/$/, "");
}

function getPublicOrigin(input?: string) {
  return normaliseUrl(
    text(input) ||
      PUBLIC_ORIGIN ||
      text(process.env.KINDLING_PUBLIC_ORIGIN) ||
      `http://127.0.0.1:${PORT}`,
  );
}

function getPipelineRunBaseUrl(input?: string) {
  return normaliseUrl(text(input) || DEFAULT_PIPELINE_RUN_BASE_URL);
}

function getActivePipelineSlug() {
  const row = db.query("SELECT active_pipeline_slug FROM pipeline_roles WHERE role_key = 'enrich_industry_segment' AND enabled = 1")
    .get() as { active_pipeline_slug?: string } | null;
  return text(row?.active_pipeline_slug, "kindling-enrich-industry-segment");
}

function getCurrentMarketProfileVersion() {
  const row = db.query(`
    SELECT mpv.*
    FROM market_profiles mp
    JOIN market_profile_versions mpv ON mpv.id = mp.current_version_id
    ORDER BY mp.updated_at DESC
    LIMIT 1
  `).get() as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: text(row.id),
    profileId: text(row.profile_id),
    versionNumber: Number(row.version_number ?? 0),
    structured: parseJsonObject(row.structured_json),
    summary: text(row.summary),
    rationale: text(row.rationale),
    sourceReferences: parseJsonArray(row.source_references_json),
    createdAt: Number(row.created_at ?? 0),
  };
}

function parseJsonObject(value: unknown): JsonObject {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function selectNextIndustry() {
  return db.query(`
    WITH industry_counts AS (
      SELECT
        COALESCE(NULLIF(TRIM(industry), ''), '(blank)') AS industry,
        SUM(CASE WHEN enrichment_status = 'not_started' THEN 1 ELSE 0 END) AS unprocessed_count,
        SUM(CASE WHEN enrichment_status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
        SUM(CASE WHEN enrichment_status = 'running' THEN 1 ELSE 0 END) AS running_count
      FROM companies
      GROUP BY COALESCE(NULLIF(TRIM(industry), ''), '(blank)')
    ),
    industry_activity AS (
      SELECT
        target_id AS industry,
        MAX(created_at) AS last_started_at
      FROM activities
      WHERE target_type = 'industry'
        AND action_type = 'industry_enrichment_batch_started'
      GROUP BY target_id
    )
    SELECT
      ic.industry,
      ic.unprocessed_count,
      ic.queued_count,
      ic.running_count,
      ia.last_started_at
    FROM industry_counts ic
    LEFT JOIN industry_activity ia ON ia.industry = ic.industry
    WHERE ic.unprocessed_count > 0
      AND ic.queued_count = 0
      AND ic.running_count = 0
    ORDER BY ia.last_started_at IS NOT NULL ASC, ia.last_started_at ASC, ic.unprocessed_count DESC, ic.industry ASC
    LIMIT 1
  `).get() as { industry: string; unprocessed_count: number; queued_count: number; running_count: number; last_started_at?: number | null } | null;
}

function listCompaniesForIndustry(industry: string, limit: number) {
  return (db.query(`
    SELECT *
    FROM companies
    WHERE COALESCE(NULLIF(TRIM(industry), ''), '(blank)') = ?1
      AND enrichment_status = 'not_started'
    ORDER BY updated_at ASC, name ASC
    LIMIT ?2
  `).all(industry, limit) as Record<string, unknown>[]).map((row) => ({
    id: text(row.id),
    name: text(row.name),
    location: text(row.location),
    industry: text(row.industry),
    website: text(row.website),
    dataRing: text(row.data_ring),
    duplicateStatus: text(row.duplicate_status),
    enrichmentStatus: text(row.enrichment_status),
    confidence: Number(row.confidence ?? 0),
    profile: parseJsonObject(row.profile_json),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    knownSources: knownSourcesForCompany(text(row.id)),
  }));
}

function knownSourcesForCompany(companyId: string) {
  return (db.query(`
    SELECT source_type, url, summary, confidence, created_at
    FROM sources
    WHERE company_id = ?1
    ORDER BY confidence DESC, created_at DESC
    LIMIT 12
  `).all(companyId) as Record<string, unknown>[]).map((source) => ({
    type: text(source.source_type),
    url: text(source.url),
    summary: text(source.summary),
    confidence: Number(source.confidence ?? 0),
    createdAt: Number(source.created_at ?? 0),
  }));
}

function activeIndustryEnrichmentRun() {
  return db.query(`
    SELECT id, autopilot_run_id, status
    FROM kindling_pipeline_runs
    WHERE role_key = 'enrich_industry_segment'
      AND status IN ('queued', 'running', 'mock')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() as { id: string; autopilot_run_id?: string | null; status: string } | null;
}

function primarySegmentForCompany(companyId: string) {
  return db.query(`
    SELECT cs.segment_id, ts.label, ts.priority
    FROM company_segments cs
    JOIN target_segments ts ON ts.id = cs.segment_id
    WHERE cs.company_id = ?1
    ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
    LIMIT 1
  `).get(companyId) as Record<string, unknown> | null;
}

function createAutoIndustryQueueItem(input: {
  requestId: string;
  company: ReturnType<typeof listCompaniesForIndustry>[number];
  batchId: string;
  industry: string;
  localRunId: string;
  now: number;
}) {
  const segment = primarySegmentForCompany(input.company.id);
  const reason = `Queued by automatic industry batch ${input.batchId}`;
  const context = {
    requestKind: "industry_batch",
    source: "auto_enrichment_job",
    batchId: input.batchId,
    industry: input.industry,
    companyName: input.company.name,
    location: input.company.location,
    website: input.company.website,
  };
  db.query(`
    INSERT INTO work_queue(
      id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
      next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
    )
    VALUES (
      ?1, 'company_enrichment', 'company', ?2, ?3, ?4, 50, 'queued', ?5, 0,
      NULL, ?6, '', ?7, ?8, ?8
    )
  `).run(
    input.requestId,
    input.company.id,
    segment?.segment_id ? String(segment.segment_id) : null,
    segment?.label ? String(segment.label) : input.industry,
    reason,
    input.localRunId,
    JSON.stringify(context),
    input.now,
  );
  db.query(`
    INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
    VALUES (?1, ?2, ?1, 'queued', 'industry_batch', ?3, ?4, ?4)
  `).run(input.requestId, input.company.id, reason, input.now);
}

function markAutoIndustryQueueRunning(localRunId: string, autopilotRunId: string, now = Date.now()) {
  db.query(`
    UPDATE work_queue
    SET status = 'running',
        attempts = attempts + 1,
        locked_by_run_id = ?1,
        error = '',
        updated_at = ?2
    WHERE kind = 'company_enrichment'
      AND locked_by_run_id = ?3
      AND status = 'queued'
  `).run(autopilotRunId || localRunId, now, localRunId);
  db.query(`
    UPDATE enrichment_requests
    SET status = 'running', updated_at = ?1
    WHERE COALESCE(NULLIF(work_queue_id, ''), id) IN (
      SELECT id
      FROM work_queue
      WHERE kind = 'company_enrichment'
        AND locked_by_run_id = ?2
        AND status = 'running'
    )
      AND status = 'queued'
  `).run(now, autopilotRunId || localRunId);
  db.query(`
    UPDATE companies
    SET enrichment_status = 'running', updated_at = ?1
    WHERE id IN (
      SELECT target_id
      FROM work_queue
      WHERE kind = 'company_enrichment'
        AND target_type = 'company'
        AND locked_by_run_id = ?2
        AND status = 'running'
    )
      AND enrichment_status = 'queued'
  `).run(now, autopilotRunId || localRunId);
}

function failAutoIndustryQueue(localRunId: string, batchId: string, companies: Array<{ id: string }>, previousStatuses: Map<string, string>, reason: string, now = Date.now()) {
  db.query(`
    UPDATE work_queue
    SET status = 'failed',
        attempts = attempts + CASE WHEN attempts = 0 THEN 1 ELSE 0 END,
        next_run_after_at = ?1,
        locked_by_run_id = NULL,
        error = ?2,
        updated_at = ?1
    WHERE kind = 'company_enrichment'
      AND (
        locked_by_run_id = ?3
        OR id IN (
          SELECT COALESCE(NULLIF(work_queue_id, ''), id)
          FROM enrichment_requests
          WHERE request_kind = 'industry_batch'
            AND summary = ?4
        )
      )
      AND status IN ('queued', 'running')
  `).run(now, reason, localRunId, `Queued by automatic industry batch ${batchId}`);
  db.query(`
    UPDATE enrichment_requests
    SET status = 'failed', summary = ?1, updated_at = ?2
    WHERE request_kind = 'industry_batch'
      AND summary = ?3
      AND status IN ('queued', 'running')
  `).run(reason, now, `Queued by automatic industry batch ${batchId}`);
  for (const company of companies) {
    db.query("UPDATE companies SET enrichment_status = ?1, updated_at = ?2 WHERE id = ?3")
      .run(previousStatuses.get(company.id) ?? "not_started", now, company.id);
  }
}

function secretKeyFromEnv(): Uint8Array | null {
  for (const key of ["KINDLING_AUTOPILOT_NSEC", "WINGMAN_NSEC", "WINGMAN_PRIV", "AGENT_NSEC"]) {
    const value = text(process.env[key]);
    if (!value) continue;
    if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(Buffer.from(value, "hex"));
    if (value.startsWith("nsec1")) {
      const decoded = nip19.decode(value);
      if (decoded.type === "nsec") return decoded.data;
    }
  }
  return null;
}

function buildNip98Authorization(url: string, method: string, bodyText: string): string {
  const secretKey = secretKeyFromEnv();
  if (!secretKey) {
    throw new Error("No signing key found. Set KINDLING_AUTOPILOT_NSEC, WINGMAN_NSEC, WINGMAN_PRIV, or AGENT_NSEC.");
  }
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method],
      ["payload", bytesToHex(sha256(new TextEncoder().encode(bodyText)))],
    ],
    content: "",
  }, secretKey);
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

function resolveUserIdentity(userNpub?: string) {
  const secretKey = secretKeyFromEnv();
  if (secretKey) {
    const pubkey = getPublicKey(secretKey);
    return { userPubkey: pubkey, userNpub: pubkeyToNpub(pubkey) };
  }
  return { userPubkey: "", userNpub: text(userNpub, PETE_NPUB) };
}

async function triggerAutopilotPipeline(url: string, body: JsonObject) {
  const bodyText = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: buildNip98Authorization(url, "POST", bodyText),
  };
  const response = await fetch(url, { method: "POST", headers, body: bodyText });
  const payload = await response.json().catch(() => ({})) as JsonObject;
  if (!response.ok) {
    throw new Error(`Autopilot trigger failed (${response.status}): ${text(payload.error, response.statusText)}`);
  }
  const run = payload.run && typeof payload.run === "object" && !Array.isArray(payload.run) ? payload.run as JsonObject : {};
  return text(run.id, text(payload.runId));
}

function sendFlightDeckDm(channelId: string, body: string) {
  const result = spawnSync("bun", ["mycode/yoke.js", "chat", "send", channelId, "--body", body], {
    cwd: WM21_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) {
    throw new Error(`Flight Deck DM failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

export async function runAutoEnrichNextIndustry(options: AutoEnrichmentOptions = {}): Promise<AutoEnrichmentResult> {
  const checkedAt = new Date().toISOString();
  const activeRun = activeIndustryEnrichmentRun();
  if (activeRun) {
    return {
      status: "skipped",
      reason: "industry_enrichment_already_running",
      checkedAt,
    };
  }

  const next = selectNextIndustry();
  if (!next) return { status: "skipped", reason: "no_unprocessed_companies", checkedAt };

  const industry = text(next.industry);
  const batchLimit = Math.max(1, Math.min(DEFAULT_BATCH_LIMIT, Math.floor(Number(options.batchLimit ?? DEFAULT_BATCH_LIMIT))));
  const companies = listCompaniesForIndustry(industry, batchLimit);
  if (!companies.length) return { status: "skipped", reason: "no_unprocessed_companies", checkedAt };

  const now = Date.now();
  const batchId = crypto.randomUUID();
  const localRunId = crypto.randomUUID();
  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const publicOrigin = getPublicOrigin(options.publicOrigin);
  const autopilotUrl = normaliseUrl(text(options.autopilotUrl) || WINGMAN_URL);
  const pipelineSlug = getActivePipelineSlug();
  const triggerUrl = new URL(`/api/pipelines/triggers/http/${encodeURIComponent(pipelineSlug)}`, autopilotUrl).toString();
  const identity = resolveUserIdentity(options.userNpub);
  const companyIds = companies.map((company) => company.id);
  const previousStatuses = new Map<string, string>(companies.map((company) => [company.id, company.enrichmentStatus]));

  const context = {
    batchId,
    industry,
    batchSize: companies.length,
    batchLimit,
    companies,
    enrichmentStrategies: INDUSTRY_ENRICHMENT_STRATEGIES,
    activeProfileVersion: getCurrentMarketProfileVersion(),
    writeApi: {
      url: `${publicOrigin}/api/kindling/pipeline-write/enrichment-company`,
      token: webhookToken,
      authHeader: "x-kindling-pipeline-token",
      batchRequestId: batchId,
    },
  };
  const triggerBody = {
    input: {
      source: "kindling-wapp",
      wappId: "kindling",
      pipelineRole: "enrich_industry_segment",
      requestId: batchId,
      roleKey: "enrich_industry_segment",
      userPubkey: identity.userPubkey,
      userNpub: identity.userNpub,
      message: `Enrich up to ${companies.length} ${industry} companies`,
      agent: SCHEDULED_PIPELINE_AGENT,
      model: SCHEDULED_PIPELINE_MODEL,
      workingDirectory: SCHEDULED_PIPELINE_WORKING_DIRECTORY,
      localContext: context,
      industry,
      batchId,
      batchSize: companies.length,
      batchLoop: {
        iteration: 1,
        index: 0,
        total: companies.length,
      },
      webhook: {
        url: `${publicOrigin}/api/kindling/pipeline-webhook`,
        token: webhookToken,
        authHeader: "x-kindling-pipeline-token",
      },
    },
  };

  const placeholders = companyIds.map((_, index) => `?${index + 2}`).join(", ");
  for (const company of companies) {
    createAutoIndustryQueueItem({ requestId: crypto.randomUUID(), company, batchId, industry, localRunId, now });
  }
  db.query(`UPDATE companies SET enrichment_status = 'queued', updated_at = ?1 WHERE id IN (${placeholders})`)
    .run(now, ...companyIds);
  db.query(`
    INSERT INTO kindling_pipeline_runs(
      id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
    )
    VALUES (?1, 'enrich_industry_segment', ?2, 'queued', ?3, ?4, ?5, ?5)
  `).run(localRunId, batchId, webhookToken, JSON.stringify({ url: triggerUrl, method: "POST", body: triggerBody }), now);

  try {
    const autopilotRunId = await triggerAutopilotPipeline(triggerUrl, triggerBody);
    if (!autopilotRunId || autopilotRunId.startsWith("mock-")) {
      throw new Error("Autopilot did not return a real pipeline run id");
    }
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3")
      .run(autopilotRunId, Date.now(), localRunId);
    markAutoIndustryQueueRunning(localRunId, autopilotRunId);
    db.query(`
      INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
      VALUES (?1, 'industry', ?2, 'automation', 'industry_enrichment_batch_started', ?3, ?4, ?5)
    `).run(
      crypto.randomUUID(),
      industry,
      `Automatic enrichment batch started for ${industry}`,
      JSON.stringify({ batchId, localRunId, autopilotRunId, batchSize: companies.length }),
      Date.now(),
    );
    const pipelineUrl = `${getPipelineRunBaseUrl(options.pipelineRunBaseUrl)}/${encodeURIComponent(autopilotRunId)}`;
    let dmSent = false;
    if (options.sendDm !== false) {
      const body = `Kindling enrichment kicked off for ${industry} (${companies.length} companies): ${pipelineUrl}`;
      sendFlightDeckDm(text(options.dmChannelId, DEFAULT_DM_CHANNEL_ID), body);
      dmSent = true;
    }
    return { status: "started", industry, batchId, localRunId, autopilotRunId, pipelineUrl, batchSize: companies.length, dmSent, checkedAt };
  } catch (error) {
    failAutoIndustryQueue(localRunId, batchId, companies, previousStatuses, error instanceof Error ? error.message : String(error));
    db.query("UPDATE kindling_pipeline_runs SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3")
      .run(error instanceof Error ? error.message : String(error), Date.now(), localRunId);
    throw error;
  }
}
