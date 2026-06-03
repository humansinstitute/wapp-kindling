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
const WM21_ROOT = "/Users/mini/wingmen/wingman21";

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
    instruction: "Identify publicly listed employees, partners, team pages, leadership, or hiring signals without collecting private data.",
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
      reason: "no_unprocessed_companies";
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
    SELECT
      COALESCE(NULLIF(TRIM(industry), ''), '(blank)') AS industry,
      SUM(CASE WHEN enrichment_status IN ('not_started', 'failed') THEN 1 ELSE 0 END) AS unprocessed_count,
      SUM(CASE WHEN enrichment_status = 'queued' THEN 1 ELSE 0 END) AS queued_count
    FROM companies
    GROUP BY COALESCE(NULLIF(TRIM(industry), ''), '(blank)')
    HAVING unprocessed_count > 0 AND queued_count = 0
    ORDER BY unprocessed_count DESC, industry ASC
    LIMIT 1
  `).get() as { industry: string; unprocessed_count: number } | null;
}

function listCompaniesForIndustry(industry: string, limit: number) {
  return (db.query(`
    SELECT *
    FROM companies
    WHERE COALESCE(NULLIF(TRIM(industry), ''), '(blank)') = ?1
      AND enrichment_status IN ('not_started', 'failed')
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
    batchLimit: DEFAULT_BATCH_LIMIT,
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
      localContext: context,
      industry,
      batchId,
      batchSize: companies.length,
      webhook: {
        url: `${publicOrigin}/api/kindling/pipeline-webhook`,
        token: webhookToken,
        authHeader: "x-kindling-pipeline-token",
      },
    },
  };

  const placeholders = companyIds.map((_, index) => `?${index + 2}`).join(", ");
  for (const company of companies) {
    db.query("INSERT INTO enrichment_requests(id, company_id, status, request_kind, summary, created_at, updated_at) VALUES (?1, ?2, 'queued', 'industry_batch', ?3, ?4, ?4)")
      .run(crypto.randomUUID(), company.id, `Queued by automatic industry batch ${batchId}`, now);
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
    for (const company of companies) {
      db.query("UPDATE companies SET enrichment_status = ?1, updated_at = ?2 WHERE id = ?3")
        .run(previousStatuses.get(company.id) ?? "not_started", Date.now(), company.id);
    }
    db.query("UPDATE enrichment_requests SET status = 'failed', summary = ?1, updated_at = ?2 WHERE request_kind = 'industry_batch' AND summary = ?3")
      .run(error instanceof Error ? error.message : String(error), Date.now(), `Queued by automatic industry batch ${batchId}`);
    db.query("UPDATE kindling_pipeline_runs SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3")
      .run(error instanceof Error ? error.message : String(error), Date.now(), localRunId);
    throw error;
  }
}
