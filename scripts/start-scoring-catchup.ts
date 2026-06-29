#!/usr/bin/env bun

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Database } from "bun:sqlite";
import { finalizeEvent, nip19 } from "nostr-tools";

type Row = Record<string, unknown>;

const dbPath = argValue("--db", "data/chat-wapp.sqlite");
const limit = Math.max(1, Math.min(20, Number(argValue("--limit", "3")) || 3));
const concurrency = Math.max(1, Math.min(20, Number(argValue("--concurrency", String(limit))) || limit));
const autopilotUrl = trimTrailingSlash(argValue("--autopilot-url", process.env.KINDLING_AUTOPILOT_URL || "http://localhost:3600"));
const kindlingOrigin = trimTrailingSlash(argValue("--origin", process.env.KINDLING_PUBLIC_ORIGIN || "http://localhost:43001"));
const workingDirectory = argValue("--working-directory", process.env.KINDLING_PIPELINE_WORKING_DIRECTORY || "/workspace/athena-kindling");
const dryRun = Bun.argv.includes("--dry-run");
const model = argValue("--model", process.env.KINDLING_SCHEDULED_PIPELINE_MODEL || "");
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
    lastCheckedByRunId: text(row.last_checked_by_run_id),
    termsNotes: text(row.terms_notes),
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

function mapServiceOffering(row: Row) {
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
  if (!profile) throw new Error("No market profile found.");
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

function activeOffering(db: Database) {
  const row = db.query(`
    SELECT *
    FROM service_offerings
    WHERE status = 'active'
    ORDER BY key ASC, variant_key ASC
    LIMIT 1
  `).get() as Row | null;
  if (!row) throw new Error("No active service offering found.");
  return row;
}

function buildContext(db: Database, company: Row, offeringRow: Row, webhookToken: string) {
  const companyId = text(company.id);
  const offering = mapServiceOffering(offeringRow);
  const sources = (db.query("SELECT * FROM sources WHERE company_id = ?1 ORDER BY confidence DESC, created_at DESC").all(companyId) as Row[]).map(mapSource);
  const customerProfileVersions = (db.query(`
    SELECT *
    FROM customer_profile_versions
    WHERE company_id = ?1
    ORDER BY version_number DESC, created_at DESC
    LIMIT 5
  `).all(companyId) as Row[]).map(mapCustomerProfileVersion);
  const marketProfile = currentProfile(db);
  const marketProfileVersion = db.query("SELECT * FROM market_profile_versions WHERE id = ?1").get(offering.marketProfileVersionId) as Row | null;
  return {
    companyId,
    companyName: text(company.name),
    company: mapCompany(company),
    customerProfileVersions,
    activeCustomerProfileVersion: customerProfileVersions.find((version) => version.status === "active") ?? customerProfileVersions[0] ?? null,
    sources,
    knownSources: sources.slice(0, 12),
    signals: [],
    evidence: { sources, signals: [] },
    segments: [],
    serviceOfferingId: offering.id,
    serviceOffering: offering,
    serviceOfferings: [offering],
    marketProfileVersionId: offering.marketProfileVersionId,
    marketProfile,
    marketProfileVersion: mapMarketProfileVersion(marketProfileVersion),
    scoringRubric: {
      scoringUnit: "company_to_adapt_lumia",
      dimensions: [
        "owner_dependency",
        "leadership_complexity",
        "handover_or_succession_pressure",
        "scale_or_operating_rhythm_pressure",
        "sme_size_and_complexity",
        "evidence_quality",
      ],
      scoreRange: { min: 0, max: 100 },
      bands: { high: "75-100", medium: "50-74", low: "0-49" },
      entryPoints: ["design", "build", "unclear", "disqualified"],
    },
    writeApi: {
      url: `${kindlingOrigin}/api/kindling/pipeline-write/service-assessment`,
      token: webhookToken,
      authHeader: "x-kindling-pipeline-token",
    },
  };
}

function selectCandidates(db: Database, marketProfileVersionId: string, offeringId: string, count: number) {
  return db.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM sources s WHERE s.company_id = c.id) AS source_count,
      (SELECT MAX(confidence) FROM sources s WHERE s.company_id = c.id) AS max_source_confidence,
      (SELECT COUNT(*) FROM customer_profile_versions cpv WHERE cpv.company_id = c.id) AS profile_count
    FROM companies c
    WHERE c.enrichment_status = 'complete'
      AND c.data_ring NOT IN ('parked', 'contacted')
      AND NOT EXISTS (
        SELECT 1
        FROM service_fit_assessments sfa
        WHERE sfa.company_id = c.id
          AND sfa.market_profile_version_id = ?1
          AND sfa.service_offering_id = ?2
      )
      AND NOT EXISTS (
        SELECT 1
        FROM work_queue wq
        WHERE wq.kind = 'service_fit_assessment'
          AND wq.status IN ('queued', 'running')
          AND wq.target_id = c.id || ':' || ?2 || ':' || ?1
      )
    ORDER BY (c.id IN (SELECT company_id FROM company_segments WHERE segment_id = 'adapt-icp-known-good-fit')) DESC,
      profile_count DESC,
      source_count DESC,
      max_source_confidence DESC,
      c.confidence DESC,
      c.updated_at ASC,
      lower(c.name) ASC
    LIMIT ?3
  `).all(marketProfileVersionId, offeringId, Math.max(1, count)) as Row[];
}

async function startRun(db: Database, company: Row, offeringRow: Row) {
  const now = Date.now();
  const requestId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const schedulerRunId = crypto.randomUUID();
  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const offering = mapServiceOffering(offeringRow);
  const context = buildContext(db, company, offeringRow, webhookToken);
  const reason = `Catch-up scoring: ${text(company.name, text(company.id))} against Adapt Lumia`;
  const triggerUrl = `${autopilotUrl}/api/pipelines/triggers/http/kindling-score-company-service-fit`;
  const triggerRequest = {
    url: triggerUrl,
    method: "POST",
    body: {
      input: {
        source: "kindling-wapp",
        wappId: "kindling",
        pipelineRole: "score_company_service_fit",
        requestId,
        roleKey: "score_company_service_fit",
        userPubkey: "scheduler",
        userNpub: "scheduler",
        message: reason,
        agent,
        model,
        workingDirectory,
        localContext: context,
        companyId: text(company.id),
        companyName: text(company.name),
        serviceOfferingId: offering.id,
        marketProfileVersionId: offering.marketProfileVersionId,
        webhook: {
          url: `${kindlingOrigin}/api/kindling/pipeline-webhook`,
          token: webhookToken,
          authHeader: "x-kindling-pipeline-token",
        },
      },
    },
  };

  const targetId = `${text(company.id)}:${offering.id}:${offering.marketProfileVersionId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.query(`
      INSERT INTO work_queue(
        id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
        next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
      )
      VALUES (?1, 'service_fit_assessment', 'company_service_offering', ?2, NULL, '', 40, 'queued', ?3, 0, ?4, NULL, '', ?5, ?4, ?4)
    `).run(requestId, targetId, reason, now, JSON.stringify(context));
    db.query(`
      INSERT INTO kindling_pipeline_runs(
        id, role_key, local_request_id, status, webhook_token, trigger_payload_json, created_at, updated_at
      )
      VALUES (?1, 'score_company_service_fit', ?2, 'queued', ?3, ?4, ?5, ?5)
    `).run(runId, requestId, webhookToken, JSON.stringify(triggerRequest), now);
    db.query(`
      INSERT INTO scheduler_runs(
        id, run_type, status, selected_action, skip_reason, role_key, local_request_id, autopilot_run_id,
        lock_key, context_json, result_json, error, started_at, finished_at, created_at, updated_at
      )
      VALUES (?1, 'scheduled', 'running', 'scoring', '', 'score_company_service_fit', ?2, NULL,
        'scoring', ?3, ?4, NULL, ?5, NULL, ?5, ?5)
    `).run(
      schedulerRunId,
      requestId,
      JSON.stringify({ catchup: true, companyId: text(company.id), serviceOfferingId: offering.id }),
      JSON.stringify({ catchup: true, company: mapCompany(company), offering }),
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
    db.query("UPDATE work_queue SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3").run(error, failedAt, requestId);
    db.query("UPDATE scheduler_runs SET status = 'failed', error = ?1, finished_at = ?2, updated_at = ?2 WHERE id = ?3").run(error, failedAt, schedulerRunId);
    throw new Error(error);
  }
  const remoteRun = payload.run && typeof payload.run === "object" ? payload.run as Row : {};
  const autopilotRunId = text(remoteRun.id, text(payload.runId));
  const startedAt = Date.now();
  db.query("UPDATE kindling_pipeline_runs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3").run(autopilotRunId, startedAt, runId);
  db.query("UPDATE work_queue SET status = 'running', attempts = attempts + 1, locked_by_run_id = ?1, updated_at = ?2 WHERE id = ?3").run(runId, startedAt, requestId);
  db.query("UPDATE scheduler_runs SET autopilot_run_id = ?1, result_json = ?2, updated_at = ?3 WHERE id = ?4").run(
    autopilotRunId,
    JSON.stringify({ catchup: true, autopilotRunId, requestId, runId, companyId: text(company.id), offeringId: offering.id }),
    startedAt,
    schedulerRunId,
  );

  return {
    companyId: text(company.id),
    companyName: text(company.name),
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
  WHERE role_key = 'score_company_service_fit'
    AND status IN ('queued', 'running', 'mock')
`).get() as Row | null)?.count ?? 0);
const slots = Math.max(0, Math.min(limit, concurrency - activeCount));
const offering = activeOffering(db);
const mappedOffering = mapServiceOffering(offering);
const candidates = slots > 0 ? selectCandidates(db, mappedOffering.marketProfileVersionId, mappedOffering.id, slots) : [];

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    activeCount,
    slots,
    offering: mappedOffering,
    candidates: candidates.map((company) => ({
      id: text(company.id),
      name: text(company.name),
      confidence: Number(company.confidence ?? 0),
      profileCount: Number(company.profile_count ?? 0),
      sourceCount: Number(company.source_count ?? 0),
      maxSourceConfidence: Number(company.max_source_confidence ?? 0),
    })),
  }, null, 2));
  process.exit(0);
}

const started = [];
for (const company of candidates) started.push(await startRun(db, company, offering));
console.log(JSON.stringify({
  activeCountBefore: activeCount,
  requestedLimit: limit,
  concurrency,
  startedCount: started.length,
  offering: { id: mappedOffering.id, name: mappedOffering.name },
  started,
}, null, 2));
