#!/usr/bin/env bun

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Database } from "bun:sqlite";
import { finalizeEvent, nip19 } from "nostr-tools";

type Row = Record<string, unknown>;

const dbPath = argValue("--db", "data/chat-wapp.sqlite");
const limit = Math.max(1, Math.min(10, Number(argValue("--limit", "2")) || 2));
const concurrency = Math.max(1, Math.min(10, Number(argValue("--concurrency", String(limit))) || limit));
const minScore = Math.max(0, Math.min(100, Number(argValue("--min-score", "50")) || 50));
const autopilotUrl = trimTrailingSlash(argValue("--autopilot-url", process.env.KINDLING_AUTOPILOT_URL || "http://localhost:3600"));
const kindlingOrigin = trimTrailingSlash(argValue("--origin", process.env.KINDLING_PUBLIC_ORIGIN || "http://localhost:43000"));
const workingDirectory = argValue("--working-directory", process.env.KINDLING_PIPELINE_WORKING_DIRECTORY || "/workspace/athena-kindling");
const dryRun = Bun.argv.includes("--dry-run");
const model = argValue("--model", process.env.KINDLING_OUTREACH_PIPELINE_MODEL || "");
const agent = argValue("--agent", process.env.KINDLING_SCHEDULED_PIPELINE_AGENT || "claude");

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function trimTrailingSlash(value: string) {
  return String(value || "").replace(/\/$/, "");
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalArrayJson(value: unknown) {
  return parseJson<unknown[]>(value, []);
}

function optionalObjectJson(value: unknown) {
  return parseJson<Row>(value, {});
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

function nip98Authorization(url: string, method: string, bodyText: string) {
  const secretKey = secretKeyFromEnv();
  if (!secretKey) return "";
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

function mapCompany(row: Row) {
  return {
    id: text(row.id),
    name: text(row.name),
    location: text(row.location),
    industry: text(row.industry),
    website: text(row.website),
    dataRing: text(row.data_ring),
    duplicateStatus: text(row.duplicate_status),
    enrichmentStatus: text(row.enrichment_status),
    confidence: Number(row.confidence ?? 0),
    profile: optionalObjectJson(row.profile_json),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function mapSource(row: Row) {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    sourceType: text(row.source_type),
    url: text(row.url),
    title: text(row.title),
    summary: text(row.summary),
    extractedData: optionalObjectJson(row.extracted_data_json),
    confidence: Number(row.confidence ?? 0),
    lastCheckedAt: row.last_checked_at ? Number(row.last_checked_at) : null,
    createdAt: Number(row.created_at ?? 0),
  };
}

function mapCustomerProfileVersion(row: Row) {
  return {
    id: text(row.id),
    companyId: text(row.company_id),
    versionNumber: Number(row.version_number ?? 0),
    status: text(row.status),
    profile: optionalObjectJson(row.profile_json),
    changeSummary: text(row.change_summary),
    sourceIds: optionalArrayJson(row.source_ids_json),
    activityIds: optionalArrayJson(row.activity_ids_json),
    createdBy: text(row.created_by),
    createdAt: Number(row.created_at ?? 0),
  };
}

function mapServiceFitAssessment(row: Row) {
  return {
    id: text(row.assessment_id, text(row.id)),
    companyId: text(row.company_id),
    serviceOfferingId: text(row.service_offering_id),
    marketProfileVersionId: text(row.market_profile_version_id),
    score: Number(row.assessment_score ?? row.score ?? 0),
    band: text(row.assessment_band, text(row.band)),
    confidence: Number(row.assessment_confidence ?? row.confidence ?? 0),
    drivers: optionalArrayJson(row.drivers_json),
    fitExplanation: text(row.fit_explanation),
    evidence: optionalArrayJson(row.evidence_json),
    caveats: optionalArrayJson(row.caveats_json),
    recommendedAction: text(row.recommended_action),
    assessment: optionalObjectJson(row.assessment_json),
    createdAt: Number(row.assessment_created_at ?? row.created_at ?? 0),
    updatedAt: Number(row.assessment_updated_at ?? row.updated_at ?? 0),
  };
}

function mapServiceOffering(row: Row | null) {
  if (!row) return null;
  return {
    id: text(row.id),
    marketProfileVersionId: text(row.market_profile_version_id),
    key: text(row.key),
    name: text(row.name),
    variantKey: text(row.variant_key),
    structured: optionalObjectJson(row.structured_json),
    status: text(row.status),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function mapMarketProfileVersion(row: Row | null) {
  if (!row) return null;
  return {
    id: text(row.id),
    versionNumber: Number(row.version_number ?? 0),
    structured: optionalObjectJson(row.structured_json),
    summary: text(row.summary),
    rationale: text(row.rationale),
    sourceReferences: optionalArrayJson(row.source_references_json),
    createdAt: Number(row.created_at ?? 0),
  };
}

function currentProfile(db: Database) {
  const profile = db.query("SELECT * FROM market_profiles ORDER BY created_at ASC LIMIT 1").get() as Row | null;
  if (!profile) return null;
  const version = db.query("SELECT * FROM market_profile_versions WHERE id = ?1").get(text(profile.current_version_id)) as Row | null;
  return {
    id: text(profile.id),
    name: text(profile.name),
    currentVersionId: text(profile.current_version_id),
    version: mapMarketProfileVersion(version),
    createdAt: Number(profile.created_at ?? 0),
    updatedAt: Number(profile.updated_at ?? 0),
  };
}

function buildContext(db: Database, company: Row) {
  const companyId = text(company.id);
  const assessment = mapServiceFitAssessment(company);
  const sources = (db.query("SELECT * FROM sources WHERE company_id = ?1 ORDER BY confidence DESC, created_at DESC").all(companyId) as Row[]).map(mapSource);
  const customerProfileVersions = (db.query(`
    SELECT *
    FROM customer_profile_versions
    WHERE company_id = ?1
    ORDER BY version_number DESC, created_at DESC
    LIMIT 5
  `).all(companyId) as Row[]).map(mapCustomerProfileVersion);
  const serviceOffering = mapServiceOffering(db.query("SELECT * FROM service_offerings WHERE id = ?1").get(assessment.serviceOfferingId) as Row | null);
  const marketProfile = currentProfile(db);
  const marketProfileVersion = db.query("SELECT * FROM market_profile_versions WHERE id = ?1").get(assessment.marketProfileVersionId) as Row | null;
  return {
    companyId,
    companyName: text(company.name),
    company: mapCompany(company),
    customerProfileVersions,
    activeCustomerProfileVersion: customerProfileVersions.find((version) => version.status === "active") ?? customerProfileVersions[0] ?? null,
    sources,
    knownSources: sources.slice(0, 12),
    serviceFitAssessment: assessment,
    serviceFitAssessments: [assessment],
    serviceOffering,
    serviceOfferings: serviceOffering ? [serviceOffering] : [],
    marketProfile,
    marketProfileVersion: mapMarketProfileVersion(marketProfileVersion),
    activeProfileVersion: marketProfile?.version ?? null,
    profile: marketProfile,
    outreachPolicy: {
      draftOnly: true,
      doNotSend: true,
      useAssessmentAsPrimaryFitRationale: true,
      avoidClaimsWithoutEvidence: true,
    },
  };
}

function selectCandidates(db: Database, count: number) {
  return db.query(`
    SELECT c.*,
      sfa.id AS assessment_id,
      sfa.service_offering_id,
      sfa.market_profile_version_id,
      sfa.score AS assessment_score,
      sfa.band AS assessment_band,
      sfa.confidence AS assessment_confidence,
      sfa.drivers_json,
      sfa.fit_explanation,
      sfa.evidence_json,
      sfa.caveats_json,
      sfa.recommended_action,
      sfa.assessment_json,
      sfa.created_at AS assessment_created_at,
      sfa.updated_at AS assessment_updated_at,
      (SELECT COUNT(*) FROM sources src WHERE src.company_id = c.id) AS source_count,
      (SELECT MAX(confidence) FROM sources src WHERE src.company_id = c.id) AS max_source_confidence,
      (SELECT COUNT(*) FROM customer_profile_versions cpv WHERE cpv.company_id = c.id) AS profile_count
    FROM companies c
    JOIN service_fit_assessments sfa ON sfa.id = (
      SELECT sfa2.id
      FROM service_fit_assessments sfa2
      WHERE sfa2.company_id = c.id
      ORDER BY sfa2.score DESC, sfa2.updated_at DESC
      LIMIT 1
    )
    WHERE c.data_ring NOT IN ('parked', 'contacted')
      AND sfa.score >= ?1
      AND NOT EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = c.id)
      AND NOT EXISTS (
        SELECT 1
        FROM kindling_pipeline_runs kpr
        WHERE kpr.role_key = 'draft_outreach'
          AND kpr.status IN ('queued', 'running', 'mock')
          AND kpr.trigger_payload_json LIKE '%"companyId":"' || c.id || '"%'
      )
    ORDER BY sfa.score DESC,
      sfa.confidence DESC,
      profile_count DESC,
      source_count DESC,
      max_source_confidence DESC,
      c.updated_at ASC,
      lower(c.name) ASC
    LIMIT ?2
  `).all(minScore, Math.max(1, count)) as Row[];
}

async function startRun(db: Database, company: Row) {
  const now = Date.now();
  const requestId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const schedulerRunId = crypto.randomUUID();
  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const context = buildContext(db, company);
  const reason = `Catch-up outreach draft: ${text(company.name, text(company.id))}`;
  const triggerUrl = `${autopilotUrl}/api/pipelines/triggers/http/kindling-draft-outreach`;
  const triggerRequest = {
    url: triggerUrl,
    method: "POST",
    body: {
      input: {
        source: "kindling-wapp",
        wappId: "kindling",
        pipelineRole: "draft_outreach",
        requestId,
        roleKey: "draft_outreach",
        userPubkey: "scheduler",
        userNpub: "scheduler",
        message: reason,
        agent,
        model,
        workingDirectory,
        localContext: context,
        companyId: text(company.id),
        companyName: text(company.name),
        webhook: {
          url: `${kindlingOrigin}/api/kindling/pipeline-webhook`,
          token: webhookToken,
          authHeader: "x-kindling-pipeline-token",
        },
      },
    },
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    db.query(`
      INSERT INTO kindling_pipeline_runs(
        id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
      )
      VALUES (?1, 'draft_outreach', ?2, 'queued', ?3, ?4, ?5, ?5)
    `).run(runId, requestId, webhookToken, JSON.stringify(triggerRequest), now);
    db.query(`
      INSERT INTO scheduler_runs(
        id, run_type, status, selected_action, skip_reason, role_key, local_request_id, autopilot_run_id,
        lock_key, context_json, result_json, error, started_at, finished_at, created_at, updated_at
      )
      VALUES (?1, 'scheduled', 'running', 'outreach', '', 'draft_outreach', ?2, NULL,
        'outreach', ?3, ?4, NULL, ?5, NULL, ?5, ?5)
    `).run(
      schedulerRunId,
      requestId,
      JSON.stringify({ catchup: true, companyId: text(company.id), minScore, assessment: context.serviceFitAssessment }),
      JSON.stringify({ catchup: true, company: mapCompany(company), assessment: context.serviceFitAssessment }),
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const bodyText = JSON.stringify(triggerRequest.body);
  const authorization = nip98Authorization(triggerRequest.url, triggerRequest.method, bodyText);
  const response = await fetch(triggerRequest.url, {
    method: triggerRequest.method,
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: bodyText,
  });
  const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => "") })) as Row;
  if (!response.ok) {
    const error = text(payload.error, `${response.status} ${response.statusText}`);
    const failedAt = Date.now();
    db.query("UPDATE kindling_pipeline_runs SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3").run(error, failedAt, runId);
    db.query("UPDATE scheduler_runs SET status = 'failed', error = ?1, finished_at = ?2, updated_at = ?2 WHERE id = ?3").run(error, failedAt, schedulerRunId);
    throw new Error(error);
  }
  const remoteRun = payload.run && typeof payload.run === "object" ? payload.run as Row : {};
  const autopilotRunId = text(remoteRun.id, text(payload.runId));
  const startedAt = Date.now();
  db.query("UPDATE kindling_pipeline_runs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3").run(autopilotRunId, startedAt, runId);
  db.query("UPDATE scheduler_runs SET autopilot_run_id = ?1, result_json = ?2, updated_at = ?3 WHERE id = ?4").run(
    autopilotRunId,
    JSON.stringify({ catchup: true, autopilotRunId, requestId, runId, companyId: text(company.id), model }),
    startedAt,
    schedulerRunId,
  );

  return {
    companyId: text(company.id),
    companyName: text(company.name),
    score: Number(company.assessment_score ?? 0),
    band: text(company.assessment_band),
    requestId,
    runId,
    schedulerRunId,
    autopilotRunId,
  };
}

const db = new Database(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 10000");

const activeCount = Number((db.query(`
  SELECT COUNT(*) AS count
  FROM kindling_pipeline_runs
  WHERE role_key = 'draft_outreach'
    AND status IN ('queued', 'running', 'mock')
`).get() as Row | null)?.count ?? 0);
const slots = Math.max(0, Math.min(limit, concurrency - activeCount));
const candidates = slots > 0 ? selectCandidates(db, slots) : [];

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    activeCount,
    slots,
    minScore,
    model,
    candidates: candidates.map((company) => ({
      id: text(company.id),
      name: text(company.name),
      score: Number(company.assessment_score ?? 0),
      band: text(company.assessment_band),
      assessmentConfidence: Number(company.assessment_confidence ?? 0),
      profileCount: Number(company.profile_count ?? 0),
      sourceCount: Number(company.source_count ?? 0),
      maxSourceConfidence: Number(company.max_source_confidence ?? 0),
    })),
  }, null, 2));
  process.exit(0);
}

const started = [];
for (const company of candidates) started.push(await startRun(db, company));
console.log(JSON.stringify({
  activeCountBefore: activeCount,
  requestedLimit: limit,
  concurrency,
  minScore,
  model,
  startedCount: started.length,
  started,
}, null, 2));
