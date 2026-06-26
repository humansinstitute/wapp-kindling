import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, nip19 } from "nostr-tools";
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
import { PIPELINE_NAME, PORT, PUBLIC_ORIGIN, WINGMAN_URL } from "./config.ts";
import {
  acquireSchedulerLock,
  companyDataRingFilterValues,
  createSchedulerRun,
  db,
  getSchedulerLock,
  getSchedulerSettings,
  getSetting,
  listSchedulerRuns,
  mapChat,
  mapMessage,
  normalizeCompanyDataRing,
  normalizeCompanyExecutionStatus,
  releaseSchedulerLock,
  setSetting,
  updateSchedulerSettings,
  type AccessRole,
  type AppSettings,
  type Message,
  type SchedulerSettingsPatch,
} from "./db.ts";
import { buildPipelineTriggerRequest, startPreparedChatPipeline, type PipelineTriggerRequest } from "./pipeline.ts";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const COMPANY_LIST_LIMIT = 500;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (data: string, status = 200) =>
  new Response(data, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function envText(key: string) {
  return String(process.env[key] ?? "").trim();
}

function autopilotSecretKeyFromEnv(): Uint8Array | null {
  for (const key of ["KINDLING_AUTOPILOT_NSEC", "WINGMAN_NSEC", "WINGMAN_PRIV", "AGENT_NSEC"]) {
    const value = envText(key);
    if (!value) continue;
    if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(Buffer.from(value, "hex"));
    if (value.startsWith("nsec1")) {
      const decoded = nip19.decode(value);
      if (decoded.type === "nsec") return decoded.data;
    }
  }
  return null;
}

function buildServerNip98Authorization(url: string, method: string, bodyText: string) {
  const secretKey = autopilotSecretKeyFromEnv();
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
  return value.replace(/\/$/, "");
}

function getAppSettings(): AppSettings {
  return {
    autopilotUrl: (getSetting("autopilotUrl") || WINGMAN_URL || "").replace(/\/$/, ""),
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
    dataRing: normalizeCompanyDataRing(row.data_ring),
    duplicateStatus: String(row.duplicate_status),
    enrichmentStatus: normalizeCompanyExecutionStatus(row.enrichment_status),
    confidence: Number(row.confidence ?? 0),
    profile: jsonParse<Record<string, unknown>>(row.profile_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapCompanyListItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    location: String(row.location ?? ""),
    industry: String(row.industry ?? ""),
    website: String(row.website ?? ""),
    dataRing: normalizeCompanyDataRing(row.data_ring),
    duplicateStatus: String(row.duplicate_status),
    enrichmentStatus: normalizeCompanyExecutionStatus(row.enrichment_status),
    confidence: Number(row.confidence ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function pagingFromParams(params: URLSearchParams, defaults: { limit?: number; max?: number } = {}) {
  const fallbackLimit = defaults.limit ?? DEFAULT_PAGE_SIZE;
  const maxLimit = defaults.max ?? MAX_PAGE_SIZE;
  const limitValue = params.get("limit");
  const offsetValue = params.get("offset");
  const parsedLimit = limitValue === null ? fallbackLimit : Math.floor(Number(limitValue));
  const parsedOffset = offsetValue === null ? 0 : Math.floor(Number(offsetValue));
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(maxLimit, parsedLimit)) : fallbackLimit;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  return { limit, offset };
}

function mapSource(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sourceType: String(row.source_type),
    url: String(row.url ?? ""),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    extractedData: jsonParse<Record<string, unknown>>(row.extracted_data_json, {}),
    confidence: Number(row.confidence ?? 0),
    lastCheckedAt: row.last_checked_at ? Number(row.last_checked_at) : null,
    lastCheckedByRunId: row.last_checked_by_run_id ? String(row.last_checked_by_run_id) : null,
    termsNotes: String(row.terms_notes ?? ""),
    createdAt: Number(row.created_at),
  };
}

function mapServiceFitAssessment(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    serviceOfferingId: String(row.service_offering_id),
    marketProfileVersionId: String(row.market_profile_version_id),
    score: Number(row.score ?? 0),
    band: String(row.band ?? ""),
    confidence: Number(row.confidence ?? 0),
    drivers: jsonParse<unknown[]>(row.drivers_json, []),
    fitExplanation: String(row.fit_explanation ?? ""),
    evidence: jsonParse<unknown[]>(row.evidence_json, []),
    caveats: jsonParse<unknown[]>(row.caveats_json, []),
    recommendedAction: String(row.recommended_action ?? ""),
    sourceRunId: String(row.source_run_id),
    assessment: jsonParse<Record<string, unknown>>(row.assessment_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    serviceOffering: row.offering_key
      ? {
        id: String(row.service_offering_id),
        key: String(row.offering_key),
        name: String(row.offering_name),
        variantKey: String(row.offering_variant_key ?? ""),
      }
      : undefined,
  };
}

function mapCustomerProfileVersion(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    versionNumber: Number(row.version_number),
    status: String(row.status),
    profile: jsonParse<Record<string, unknown>>(row.profile_json, {}),
    changeSummary: String(row.change_summary ?? ""),
    sourceIds: jsonParse<string[]>(row.source_ids_json, []),
    activityIds: jsonParse<string[]>(row.activity_ids_json, []),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
  };
}

function mapSignal(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    signalType: String(row.signal_type),
    summary: String(row.summary ?? ""),
    sourceId: row.source_id ? String(row.source_id) : null,
    sourceUrl: String(row.source_url ?? ""),
    observedDate: row.observed_date ? String(row.observed_date) : null,
    strength: String(row.strength ?? "low"),
    confidence: Number(row.confidence ?? 0),
    adaptRelevance: String(row.adapt_relevance ?? ""),
    evidence: jsonParse<Record<string, unknown>>(row.evidence_json, {}),
    createdAt: Number(row.created_at),
  };
}

const WORK_QUEUE_STATUSES = ["queued", "running", "complete", "failed", "cancelled"] as const;
type WorkQueueStatus = typeof WORK_QUEUE_STATUSES[number];

function normalizeWorkQueueStatus(value: unknown, fallback: WorkQueueStatus = "queued"): WorkQueueStatus {
  const status = String(value ?? "").trim().toLowerCase();
  return (WORK_QUEUE_STATUSES as readonly string[]).includes(status) ? status as WorkQueueStatus : fallback;
}

function mapWorkQueueItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: String(row.kind),
    targetType: String(row.target_type),
    targetId: String(row.target_id),
    segmentId: row.segment_id ? String(row.segment_id) : null,
    segment: String(row.segment ?? ""),
    priority: Number(row.priority ?? 100),
    status: normalizeWorkQueueStatus(row.status),
    reason: String(row.reason ?? ""),
    attempts: Number(row.attempts ?? 0),
    nextRunAfterAt: row.next_run_after_at ? Number(row.next_run_after_at) : null,
    lockedByRunId: row.locked_by_run_id ? String(row.locked_by_run_id) : null,
    error: String(row.error ?? ""),
    context: jsonParse<Record<string, unknown>>(row.context_json, {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
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

function mapTargetSegment(row: Record<string, unknown>) {
  const coverageTargets = jsonParse<Record<string, unknown>>(row.coverage_targets_json, {});
  const scanPrompts = jsonParse<Record<string, unknown>>(row.scan_prompts_json, {});
  return {
    id: String(row.id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    label: String(row.label),
    tier: Number(row.tier),
    priority: Number(row.priority),
    status: String(row.status),
    defaultGeo: String(row.default_geo ?? ""),
    defaultTargetCount: Number(row.default_target_count ?? 0),
    defaultBatchSize: Number(row.default_batch_size ?? 0),
    coverageTargets,
    scanPrompts,
    targets: coverageTargets,
    prompts: scanPrompts,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

type TargetSegment = ReturnType<typeof mapTargetSegment> & { children?: TargetSegment[] };

function listTargetSegments(): TargetSegment[] {
  const rows = db.query(`
    SELECT *
    FROM target_segments
    ORDER BY parent_id IS NOT NULL ASC, tier ASC, priority ASC, label ASC
  `).all() as Record<string, unknown>[];
  return rows.map(mapTargetSegment);
}

function buildTargetSegmentTree(segments: TargetSegment[]): TargetSegment[] {
  const byId = new Map(segments.map((segment) => [segment.id, { ...segment, children: [] as TargetSegment[] }]));
  const roots: TargetSegment[] = [];
  for (const segment of byId.values()) {
    const parent = segment.parentId ? byId.get(segment.parentId) : null;
    if (parent) {
      parent.children?.push(segment);
    } else {
      roots.push(segment);
    }
  }
  const sortChildren = (items: TargetSegment[]) => {
    items.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
    for (const item of items) sortChildren(item.children ?? []);
  };
  sortChildren(roots);
  return roots;
}

function getTargetSegment(segmentId: string) {
  const row = db.query("SELECT * FROM target_segments WHERE id = ?1").get(segmentId) as Record<string, unknown> | null;
  return row ? mapTargetSegment(row) : null;
}

function canonicalGeographyKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function getOrCreateTargetGeography(label: string, now = Date.now()) {
  const cleanLabel = label.trim() || "Unspecified";
  const canonicalKey = canonicalGeographyKey(cleanLabel);
  const existing = db.query("SELECT id FROM target_geographies WHERE canonical_key = ?1").get(canonicalKey) as Record<string, unknown> | null;
  if (existing) return String(existing.id);
  const id = `geo-${canonicalKey}`.slice(0, 96);
  db.query(`
    INSERT INTO target_geographies(id, parent_id, label, kind, canonical_key, status, created_at, updated_at)
    VALUES (?1, NULL, ?2, 'search_text', ?3, 'active', ?4, ?4)
    ON CONFLICT(canonical_key) DO NOTHING
  `).run(id, cleanLabel, canonicalKey, now);
  const row = db.query("SELECT id FROM target_geographies WHERE canonical_key = ?1").get(canonicalKey) as Record<string, unknown> | null;
  return String(row?.id ?? id);
}

function normalizeSourceFamily(value: unknown, strategyType: string) {
  const explicit = String(value ?? "").trim().toLowerCase();
  if (explicit) return explicit.replace(/\s+/g, "_");
  const strategy = strategyType.trim().toLowerCase();
  if (["google", "bing", "search", "web", "web_search"].includes(strategy)) return "web_search";
  if (["directory", "association", "registry", "social", "maps"].includes(strategy)) return strategy;
  return strategy || "web";
}

function findTargetSegmentIdForScan(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const direct = db.query("SELECT id FROM target_segments WHERE id = ?1").get(raw) as Record<string, unknown> | null;
  if (direct) return String(direct.id);
  const label = db.query("SELECT id FROM target_segments WHERE lower(label) = lower(?1) LIMIT 1").get(raw) as Record<string, unknown> | null;
  return label ? String(label.id) : null;
}

function targetCountsForCoverage(segmentId: string | null, fallbackFound: number) {
  if (segmentId) {
    const segment = db.query("SELECT coverage_targets_json FROM target_segments WHERE id = ?1").get(segmentId) as Record<string, unknown> | null;
    const targets = jsonParse<Record<string, unknown>>(segment?.coverage_targets_json, {});
    if (Object.keys(targets).length) return targets;
  }
  return fallbackFound > 0 ? { found: fallbackFound } : {};
}

function targetCountsForScheduledAcquisition(segmentId: string | null, targetCount: number) {
  const targets = targetCountsForCoverage(segmentId, targetCount);
  const found = Math.max(targetCount, numericField(targets, "found", targetCount));
  return { ...targets, found };
}

function getOrCreateCoverageSlice(input: {
  segmentId: string | null;
  geographyId: string | null;
  geographyText: string;
  sourceFamily: string;
  strategyType: string;
  targetCounts?: Record<string, unknown>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const geographyText = input.geographyText.trim();
  const sourceFamily = input.sourceFamily.trim().toLowerCase() || "web";
  const strategyType = input.strategyType.trim().toLowerCase() || "search";
  const existing = db.query(`
    SELECT id
    FROM coverage_slices
    WHERE COALESCE(segment_id, '') = COALESCE(?1, '')
      AND COALESCE(geography_id, '') = COALESCE(?2, '')
      AND lower(geography_text) = lower(?3)
      AND lower(source_family) = lower(?4)
      AND lower(strategy_type) = lower(?5)
    LIMIT 1
  `).get(input.segmentId, input.geographyId, geographyText, sourceFamily, strategyType) as Record<string, unknown> | null;
  if (existing) {
    if (input.targetCounts && Object.keys(input.targetCounts).length) {
      db.query("UPDATE coverage_slices SET target_counts_json = ?1, updated_at = ?2 WHERE id = ?3")
        .run(JSON.stringify(input.targetCounts), now, String(existing.id));
    }
    return String(existing.id);
  }
  const id = crypto.randomUUID();
  db.query(`
    INSERT INTO coverage_slices(
      id, segment_id, geography_id, geography_text, source_family, strategy_type, status,
      target_counts_json, current_counts_json, yield_metrics_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, '{}', '{}', ?8, ?8)
  `).run(
    id,
    input.segmentId,
    input.geographyId,
    geographyText,
    sourceFamily,
    strategyType,
    JSON.stringify(input.targetCounts ?? {}),
    now,
  );
  return id;
}

function rollUpCoverageSlice(coverageSliceId: string, now = Date.now()) {
  const attemptStats = db.query(`
    SELECT
      COUNT(*) AS executed_attempts,
      COALESCE(SUM(result_count), 0) AS result_count,
      MAX(created_at) AS last_run_at,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_attempts
    FROM scan_strategy_attempts
    WHERE coverage_slice_id = ?1
      AND status != 'planned'
  `).get(coverageSliceId) as Record<string, unknown> | null;
  const executedAttempts = Number(attemptStats?.executed_attempts ?? 0);
  const resultCount = Number(attemptStats?.result_count ?? 0);
  const currentCounts = {
    found: resultCount,
    unique: resultCount,
    possibleDuplicates: 0,
    weakSource: 0,
    enriched: 0,
    scored: 0,
    outreachReady: 0,
    parked: 0,
    stale: 0,
    executedAttempts,
  };
  const yieldMetrics = {
    executedAttempts,
    resultCount,
    averageResultCount: executedAttempts ? resultCount / executedAttempts : 0,
    netNewCompanies: resultCount,
    blockedAttempts: Number(attemptStats?.blocked_attempts ?? 0),
  };
  const stalledReason = executedAttempts > 0 && resultCount === 0 ? "no_results" : null;
  db.query(`
    UPDATE coverage_slices
    SET current_counts_json = ?1,
        yield_metrics_json = ?2,
        last_run_at = ?3,
        status = CASE WHEN ?4 IS NULL THEN 'active' ELSE 'stalled' END,
        stalled_reason = ?4,
        updated_at = ?5
    WHERE id = ?6
  `).run(
    JSON.stringify(currentCounts),
    JSON.stringify(yieldMetrics),
    Number(attemptStats?.last_run_at ?? now) || now,
    stalledReason,
    now,
    coverageSliceId,
  );
}

function linkLegacyCoverageForScan(industry: string, location: string, now = Date.now()) {
  const rows = db.query(`
    SELECT sat.*, dj.segment_id, dj.geography_id, dj.target_count
    FROM scan_strategy_attempts sat
    JOIN discovery_jobs dj ON dj.id = sat.discovery_job_id
    WHERE sat.status != 'planned'
      AND (sat.coverage_slice_id IS NULL OR sat.coverage_slice_id = '')
      AND lower(sat.industry) = lower(?1)
      AND lower(sat.location) = lower(?2)
  `).all(industry, location) as Record<string, unknown>[];
  const touched = new Set<string>();
  for (const row of rows) {
    const segmentId = row.segment_id ? String(row.segment_id) : findTargetSegmentIdForScan(row.industry);
    const geographyText = String(row.geography_text || row.location || location);
    const geographyId = row.geography_id ? String(row.geography_id) : getOrCreateTargetGeography(geographyText, now);
    const strategyType = String(row.strategy_type || "search");
    const sourceFamily = normalizeSourceFamily(row.source_family, strategyType);
    const coverageSliceId = getOrCreateCoverageSlice({
      segmentId,
      geographyId,
      geographyText,
      sourceFamily,
      strategyType,
      targetCounts: targetCountsForCoverage(segmentId, Number(row.target_count ?? 0)),
      now,
    });
    db.query(`
      UPDATE scan_strategy_attempts
      SET segment_id = ?1,
          geography_id = ?2,
          geography_text = ?3,
          source_family = ?4,
          coverage_slice_id = ?5
      WHERE id = ?6
    `).run(segmentId, geographyId, geographyText, sourceFamily, coverageSliceId, String(row.id));
    db.query(`
      UPDATE discovery_jobs
      SET segment_id = COALESCE(segment_id, ?1),
          geography_id = COALESCE(geography_id, ?2),
          geography_text = CASE WHEN geography_text = '' THEN ?3 ELSE geography_text END,
          coverage_slice_id = COALESCE(coverage_slice_id, ?4)
      WHERE id = ?5
    `).run(segmentId, geographyId, geographyText, coverageSliceId, String(row.discovery_job_id));
    touched.add(coverageSliceId);
  }
  for (const coverageSliceId of touched) rollUpCoverageSlice(coverageSliceId, now);
}

function parseJsonObjectField(value: unknown, fallback: Record<string, unknown>) {
  if (value === undefined) return fallback;
  if (typeof value === "string") return jsonParse<Record<string, unknown>>(value, fallback);
  return objectRecord(value);
}

function normalizeSegmentStatus(value: unknown, fallback = "active") {
  const status = String(value ?? fallback).trim().toLowerCase();
  return status === "active" || status === "parked" ? status : null;
}

function normalizeCoverageStatus(value: unknown, fallback = "active") {
  const status = String(value ?? fallback).trim().toLowerCase();
  return ["active", "paused", "stalled"].includes(status) ? status : null;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBooleanInput(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function schedulerSettingsPatchFromBody(body: Record<string, unknown>): SchedulerSettingsPatch {
  const patch: SchedulerSettingsPatch = {};
  if (body.enabled !== undefined) patch.enabled = normalizeBooleanInput(body.enabled);
  if (body.acquisitionEnabled !== undefined || body.acquisition_enabled !== undefined) {
    patch.acquisitionEnabled = normalizeBooleanInput(body.acquisitionEnabled ?? body.acquisition_enabled);
  }
  if (body.enrichmentEnabled !== undefined || body.enrichment_enabled !== undefined) {
    patch.enrichmentEnabled = normalizeBooleanInput(body.enrichmentEnabled ?? body.enrichment_enabled);
  }
  if (body.scoringEnabled !== undefined || body.scoring_enabled !== undefined) {
    patch.scoringEnabled = normalizeBooleanInput(body.scoringEnabled ?? body.scoring_enabled);
  }
  if (body.outreachEnabled !== undefined || body.outreach_enabled !== undefined) {
    patch.outreachEnabled = normalizeBooleanInput(body.outreachEnabled ?? body.outreach_enabled);
  }
  if (body.targetPoolSize !== undefined || body.target_pool_size !== undefined) {
    patch.targetPoolSize = Number(body.targetPoolSize ?? body.target_pool_size);
  }
  if (body.enrichedFloor !== undefined || body.enriched_floor !== undefined) {
    patch.enrichedFloor = Number(body.enrichedFloor ?? body.enriched_floor);
  }
  if (body.topTargetCount !== undefined || body.top_target_count !== undefined) {
    patch.topTargetCount = Number(body.topTargetCount ?? body.top_target_count);
  }
  if (body.outreachTargetCount !== undefined || body.outreach_target_count !== undefined) {
    patch.outreachTargetCount = Number(body.outreachTargetCount ?? body.outreach_target_count);
  }
  if (body.perRoleConcurrency !== undefined || body.per_role_concurrency_json !== undefined) {
    patch.perRoleConcurrency = parseJsonObjectField(body.perRoleConcurrency ?? body.per_role_concurrency_json, {}) as Record<string, number>;
  }
  if (body.cooldowns !== undefined || body.cooldowns_json !== undefined) {
    patch.cooldowns = parseJsonObjectField(body.cooldowns ?? body.cooldowns_json, {}) as Record<string, number>;
  }
  return patch;
}

type SchedulerActionKey = "acquisition" | "enrichment" | "scoring" | "outreach";
const PROSPECTING_LOOP_INTERVAL_MS = 60 * 1000;
const STALE_ACTIVE_PIPELINE_RUN_MS = 6 * 60 * 60 * 1000;
const ROLE_STALE_ACTIVE_PIPELINE_RUN_MS: Record<string, number> = {
  draft_outreach: 20 * 60 * 1000,
  enrich_company: 35 * 60 * 1000,
  score_company_service_fit: 35 * 60 * 1000,
  scan_target_list: 30 * 60 * 1000,
};
const ACQUISITION_PARTIAL_STALE_PIPELINE_RUN_MS = 90 * 60 * 1000;
const SCHEDULED_ACQUISITION_TARGET_COUNT = 50;
const SCHEDULED_SCORING_BATCH_LIMIT = 1;
const SCHEDULED_PIPELINE_AGENT = process.env.KINDLING_SCHEDULED_PIPELINE_AGENT || "claude";
const SCHEDULED_PIPELINE_MODEL = process.env.KINDLING_SCHEDULED_PIPELINE_MODEL || "";
const SCHEDULED_OUTREACH_PIPELINE_MODEL = process.env.KINDLING_OUTREACH_PIPELINE_MODEL || "";
const SCHEDULED_PIPELINE_WORKING_DIRECTORY = process.env.KINDLING_PIPELINE_WORKING_DIRECTORY || "/workspace/athena-kindling";

type SchedulerRoleEvaluation = {
  action: SchedulerActionKey;
  roleKey: string;
  status: "selected" | "skipped";
  reason: string;
  activeCount: number;
  concurrencyLimit: number;
};

function scheduledPipelineModelForRole(roleKey: string) {
  if (roleKey === "draft_outreach") return SCHEDULED_OUTREACH_PIPELINE_MODEL;
  return SCHEDULED_PIPELINE_MODEL;
}

type SchedulerDryRunDecision = {
  dryRun: boolean;
  workAvailable: boolean;
  action: SchedulerActionKey | "no_work";
  roleKey: string | null;
  item: Record<string, unknown> | null;
  reason: string;
  evaluatedRoles: SchedulerRoleEvaluation[];
  activeLock: Record<string, unknown> | null;
};

type SchedulerAcquisitionWork = {
  kind?: unknown;
  coverageSliceId?: unknown;
  segmentId?: unknown;
  segmentLabel?: unknown;
  segmentTier?: unknown;
  segmentPriority?: unknown;
  geographyId?: unknown;
  geographyText?: unknown;
  sourceFamily?: unknown;
  strategyType?: unknown;
  targetCounts?: unknown;
  currentCounts?: unknown;
  deficit?: unknown;
  yieldMetrics?: unknown;
  cooldown?: unknown;
  selection?: unknown;
};

function numericField(record: Record<string, unknown>, key: string, fallback = 0) {
  const value = Number(record[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function activeSchedulerLock(now: number, lockKey = "prospecting") {
  const lock = getSchedulerLock(lockKey);
  return lock && lock.leaseExpiresAt > now ? lock : null;
}

function roleConcurrencyState(roleKey: string, settings = getSchedulerSettings()) {
  const configuredLimit = Number(settings.perRoleConcurrency[roleKey] ?? 1);
  const concurrencyLimit = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 1;
  const role = db.query("SELECT enabled FROM pipeline_roles WHERE role_key = ?1").get(roleKey) as Record<string, unknown> | null;
  const roleEnabled = role ? Boolean(Number(role.enabled)) : false;
  const activeKindling = db.query(`
    SELECT COUNT(*) AS count
    FROM kindling_pipeline_runs
    WHERE role_key = ?1
      AND status IN ('queued', 'running', 'mock')
  `).get(roleKey) as Record<string, unknown> | null;
  const activeScheduler = db.query(`
    SELECT COUNT(*) AS count
    FROM scheduler_runs
    WHERE role_key = ?1
      AND status = 'running'
      AND run_type != 'dry_run'
  `).get(roleKey) as Record<string, unknown> | null;
  const activeCount = Math.max(Number(activeKindling?.count ?? 0), Number(activeScheduler?.count ?? 0));
  return {
    roleEnabled,
    activeCount,
    concurrencyLimit,
    blockedReason: !roleEnabled
      ? `role ${roleKey} is disabled or missing`
      : concurrencyLimit <= 0
        ? `role ${roleKey} concurrency limit is 0`
        : activeCount >= concurrencyLimit
          ? `role ${roleKey} is at concurrency limit ${activeCount}/${concurrencyLimit}`
          : "",
  };
}

function recentSchedulerLaunch(action: SchedulerActionKey, roleKey: string, cooldownMs: number, now = Date.now()) {
  if (cooldownMs <= 0) return null;
  const row = db.query(`
    SELECT id, started_at
    FROM scheduler_runs
    WHERE selected_action = ?1
      AND role_key = ?2
      AND run_type != 'dry_run'
      AND status IN ('running', 'complete')
      AND started_at > ?3
    ORDER BY started_at DESC
    LIMIT 1
  `).get(action, roleKey, now - cooldownMs) as Record<string, unknown> | null;
  if (!row) return null;
  const startedAt = Number(row.started_at ?? 0);
  return {
    id: String(row.id),
    startedAt,
    remainingMs: Math.max(0, cooldownMs - (now - startedAt)),
  };
}

function scheduledKindlingOrigin() {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const testDbPath = process.env.CHAT_WAPP_DB_PATH || "";
  const runningContractTests = /kindling-api-|test\.sqlite$/.test(testDbPath);
  if (PORT === 3256 && !runningContractTests) {
    throw new Error("CHAT_WAPP_PUBLIC_ORIGIN must point at the Kindling WApp origin before scheduled automation can start");
  }
  return `http://localhost:${PORT}`;
}

function roleStaleTimeoutMs(roleKey: string, run: Record<string, unknown> | null = null) {
  if (roleKey === "scan_target_list" && run) {
    const requestId = String(run.local_request_id ?? "");
    return matchingCompanyCountForJob(requestId) > 0
      ? ACQUISITION_PARTIAL_STALE_PIPELINE_RUN_MS
      : ROLE_STALE_ACTIVE_PIPELINE_RUN_MS.scan_target_list;
  }
  return ROLE_STALE_ACTIVE_PIPELINE_RUN_MS[roleKey] ?? STALE_ACTIVE_PIPELINE_RUN_MS;
}

function roleTimeoutReason(roleKey: string, timeoutMs: number, run: Record<string, unknown> | null = null) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  if (roleKey === "scan_target_list" && run && matchingCompanyCountForJob(String(run.local_request_id ?? "")) <= 0) {
    return `Timed out after ${minutes} minutes without discovery results`;
  }
  return `Timed out after ${minutes} minutes without completion callback`;
}

function reconcileStaleActiveKindlingRuns(now = Date.now()) {
  const rows = db.query(`
    SELECT *
    FROM kindling_pipeline_runs
    WHERE status IN ('queued', 'running', 'mock')
    ORDER BY updated_at ASC
    LIMIT 50
  `).all() as Record<string, unknown>[];
  let reconciled = 0;
  for (const row of rows) {
    const roleKey = String(row.role_key ?? "");
    const timeoutMs = roleStaleTimeoutMs(roleKey, row);
    if (Number(row.updated_at ?? row.created_at ?? now) >= now - timeoutMs) continue;
    markKindlingRunFailedFromAutopilot(
      row,
      roleTimeoutReason(roleKey, timeoutMs, row),
    );
    reconciled += 1;
  }
  return reconciled;
}

function reconcileStaleSchedulerState(now = Date.now()) {
  const schedulerRows = db.query(`
    SELECT *
    FROM scheduler_runs
    WHERE status = 'running'
    ORDER BY updated_at ASC
    LIMIT 100
  `).all() as Record<string, unknown>[];
  let schedulerCount = 0;
  for (const row of schedulerRows) {
    const roleKey = String(row.role_key ?? "");
    const timeoutMs = roleStaleTimeoutMs(roleKey);
    if (Number(row.updated_at ?? row.started_at ?? now) >= now - timeoutMs) continue;
    const reason = roleTimeoutReason(roleKey, timeoutMs);
    db.query(`
      UPDATE scheduler_runs
      SET status = 'failed',
          error = CASE WHEN error = '' THEN ?1 ELSE error END,
          finished_at = COALESCE(finished_at, ?2),
          updated_at = ?2
      WHERE id = ?3
        AND status = 'running'
    `).run(reason, now, String(row.id));
    releaseSchedulerLock(String(row.lock_key ?? "prospecting"), String(row.id));
    schedulerCount += 1;
  }

  const queueRows = db.query(`
    SELECT *
    FROM work_queue
    WHERE status = 'running'
    ORDER BY updated_at ASC
    LIMIT 100
  `).all() as Record<string, unknown>[];
  let queueCount = 0;
  for (const row of queueRows) {
    const kind = String(row.kind ?? "");
    const timeoutMs = kind === "company_enrichment"
      ? ROLE_STALE_ACTIVE_PIPELINE_RUN_MS.enrich_company
      : kind === "service_fit_assessment"
        ? ROLE_STALE_ACTIVE_PIPELINE_RUN_MS.score_company_service_fit
        : STALE_ACTIVE_PIPELINE_RUN_MS;
    if (Number(row.updated_at ?? row.created_at ?? now) >= now - timeoutMs) continue;
    const reason = roleTimeoutReason(kind, timeoutMs);
    db.query(`
      UPDATE work_queue
      SET status = 'failed',
          error = CASE WHEN error = '' THEN ?1 ELSE error END,
          locked_by_run_id = NULL,
          next_run_after_at = NULL,
          updated_at = ?2
      WHERE id = ?3
        AND status = 'running'
    `).run(reason, now, String(row.id));
    if (String(row.kind ?? "") === "company_enrichment") {
      db.query(`
        UPDATE enrichment_requests
        SET status = 'failed',
            summary = CASE WHEN summary = '' THEN ?1 ELSE summary END,
            updated_at = ?2
        WHERE COALESCE(NULLIF(work_queue_id, ''), id) = ?3
          AND status = 'running'
      `).run(reason, now, String(row.id));
      db.query(`
        UPDATE companies
        SET enrichment_status = 'failed',
            updated_at = ?1
        WHERE id = ?2
          AND enrichment_status = 'running'
      `).run(now, String(row.target_id ?? ""));
    }
    queueCount += 1;
  }

  return { scheduler: schedulerCount, queue: queueCount };
}

function reconcileSchedulerState(now = Date.now()) {
  return {
    kindling: reconcileStaleActiveKindlingRuns(now),
    ...reconcileStaleSchedulerState(now),
  };
}

function schedulerCompanyCounts() {
  const row = db.query(`
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN data_ring != 'parked' THEN 1 ELSE 0 END) AS active_pool_count,
      SUM(CASE
        WHEN enrichment_status = 'complete'
          OR data_ring IN ('enhanced', 'ranked', 'scored', 'outreach_ready', 'outreach', 'contacted')
        THEN 1 ELSE 0 END) AS enriched_count,
      SUM(CASE
        WHEN EXISTS (SELECT 1 FROM service_fit_assessments sfa WHERE sfa.company_id = companies.id)
        THEN 1 ELSE 0 END) AS scored_count,
      SUM(CASE
        WHEN data_ring IN ('outreach_ready', 'outreach', 'contacted')
          OR EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = companies.id)
        THEN 1 ELSE 0 END) AS outreach_ready_count
    FROM companies
  `).get() as Record<string, unknown> | null;
  return {
    total: Number(row?.total_count ?? 0),
    activePool: Number(row?.active_pool_count ?? 0),
    enriched: Number(row?.enriched_count ?? 0),
    scored: Number(row?.scored_count ?? 0),
    outreachReady: Number(row?.outreach_ready_count ?? 0),
  };
}

type AcquisitionCoverageCounts = CoverageCompanyCounts & {
  sourceBackedUnique: number;
};

type AcquisitionCandidate = {
  source: "coverage_slice" | "segment_default";
  coverageSliceId: string | null;
  segmentId: string | null;
  segmentLabel: string;
  segmentTier: number | null;
  segmentPriority: number;
  geographyId: string | null;
  geographyText: string;
  sourceFamily: string;
  strategyType: string;
  status: string;
  targetCounts: Record<string, unknown>;
  defaultTargetCount: number;
  yieldMetrics: Record<string, unknown>;
  lastRunAt: number | null;
  nextRunAfterAt: number | null;
  stalledReason: string;
  createdAt: number;
};

function acquisitionGeographyValues(geographyText: string) {
  const values = [geographyText.trim()].filter(Boolean);
  const withoutState = geographyText.replace(/,\s*(wa|western australia)$/i, "").trim();
  if (withoutState && !values.some((value) => value.toLowerCase() === withoutState.toLowerCase())) values.push(withoutState);
  return values;
}

function acquisitionSegmentGeographyKey(segmentId: string | null, geographyText: string) {
  const geographyValues = acquisitionGeographyValues(geographyText);
  const geographyKey = geographyValues[geographyValues.length - 1] ?? geographyText.trim();
  return `${segmentId ?? ""}|${geographyKey.toLowerCase()}`;
}

function countAcquisitionCoverageCompanies(filters: { segmentId?: string | null; geographyText?: string | null } = {}): AcquisitionCoverageCounts {
  const clauses = ["c.data_ring != 'parked'"];
  const values: string[] = [];
  const segmentId = String(filters.segmentId ?? "").trim();
  if (segmentId) {
    values.push(segmentId);
    clauses.push(`EXISTS (
      SELECT 1
      FROM company_segments cs
      WHERE cs.company_id = c.id
        AND cs.segment_id = ?${values.length}
    )`);
  }
  const geographyValues = acquisitionGeographyValues(String(filters.geographyText ?? ""));
  if (geographyValues.length) {
    const placeholders = geographyValues.map((value) => {
      values.push(value);
      return `?${values.length}`;
    });
    clauses.push(`lower(COALESCE(c.location, '')) IN (${placeholders.map((placeholder) => `lower(${placeholder})`).join(", ")})`);
  }
  const row = db.query(`
    SELECT
      COUNT(*) AS found_count,
      SUM(CASE WHEN c.duplicate_status = 'unique' THEN 1 ELSE 0 END) AS unique_count,
      SUM(CASE WHEN c.duplicate_status IN ('possible_duplicate', 'duplicate') THEN 1 ELSE 0 END) AS duplicate_count,
      SUM(CASE
        WHEN NOT EXISTS (SELECT 1 FROM sources s WHERE s.company_id = c.id) THEN 1
        WHEN COALESCE((SELECT MAX(s.confidence) FROM sources s WHERE s.company_id = c.id), 0) < 0.5 THEN 1
        ELSE 0
      END) AS weak_source_count,
      SUM(CASE
        WHEN c.duplicate_status = 'unique'
          AND c.data_ring != 'stale'
          AND EXISTS (
            SELECT 1
            FROM sources s
            WHERE s.company_id = c.id
              AND s.confidence >= 0.5
          )
        THEN 1 ELSE 0 END) AS source_backed_unique_count,
      SUM(CASE
        WHEN c.enrichment_status = 'complete'
          OR c.data_ring IN ('enhanced', 'agent', 'enriched', 'ranked', 'scored', 'outreach_ready', 'outreach', 'contacted')
        THEN 1 ELSE 0
      END) AS enriched_count,
      SUM(CASE
        WHEN EXISTS (SELECT 1 FROM service_fit_assessments sfa WHERE sfa.company_id = c.id)
        THEN 1 ELSE 0
      END) AS scored_count,
      SUM(CASE
        WHEN c.data_ring IN ('outreach_ready', 'outreach', 'contacted')
          OR EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = c.id)
        THEN 1 ELSE 0
      END) AS outreach_ready_count,
      SUM(CASE WHEN c.data_ring = 'parked' THEN 1 ELSE 0 END) AS parked_count,
      SUM(CASE WHEN c.data_ring = 'stale' THEN 1 ELSE 0 END) AS stale_count
    FROM companies c
    WHERE ${clauses.join(" AND ")}
  `).get(...values) as Record<string, unknown> | null;
  return {
    found: Number(row?.found_count ?? 0),
    unique: Number(row?.unique_count ?? 0),
    duplicate: Number(row?.duplicate_count ?? 0),
    weakSource: Number(row?.weak_source_count ?? 0),
    sourceBackedUnique: Number(row?.source_backed_unique_count ?? 0),
    enriched: Number(row?.enriched_count ?? 0),
    scored: Number(row?.scored_count ?? 0),
    outreachReady: Number(row?.outreach_ready_count ?? 0),
    parked: Number(row?.parked_count ?? 0),
    stale: Number(row?.stale_count ?? 0),
  };
}

function acquisitionTargetFound(candidate: AcquisitionCandidate) {
  return numericField(candidate.targetCounts, "found", candidate.defaultTargetCount);
}

function acquisitionCandidateFromCoverageRow(row: Record<string, unknown>): AcquisitionCandidate {
  const segmentTargets = jsonParse<Record<string, unknown>>(row.segment_coverage_targets_json, {});
  const sliceTargets = jsonParse<Record<string, unknown>>(row.target_counts_json, {});
  return {
    source: "coverage_slice",
    coverageSliceId: String(row.id),
    segmentId: row.segment_id ? String(row.segment_id) : null,
    segmentLabel: row.segment_label ? String(row.segment_label) : "",
    segmentTier: row.segment_tier === null || row.segment_tier === undefined ? null : Number(row.segment_tier),
    segmentPriority: Number(row.segment_priority ?? 999999),
    geographyId: row.geography_id ? String(row.geography_id) : null,
    geographyText: String(row.geography_text ?? row.geography_label ?? ""),
    sourceFamily: String(row.source_family ?? ""),
    strategyType: String(row.strategy_type ?? ""),
    status: String(row.status ?? "active"),
    targetCounts: Object.keys(sliceTargets).length ? sliceTargets : segmentTargets,
    defaultTargetCount: Number(row.default_target_count ?? 0),
    yieldMetrics: jsonParse<Record<string, unknown>>(row.yield_metrics_json, {}),
    lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
    nextRunAfterAt: row.next_run_after_at ? Number(row.next_run_after_at) : null,
    stalledReason: row.stalled_reason ? String(row.stalled_reason) : "",
    createdAt: Number(row.created_at ?? 0),
  };
}

function listAcquisitionCandidates(now: number): AcquisitionCandidate[] {
  const sliceRows = db.query(`
    SELECT
      cs.*,
      ts.label AS segment_label,
      ts.tier AS segment_tier,
      ts.priority AS segment_priority,
      ts.default_target_count,
      ts.coverage_targets_json AS segment_coverage_targets_json,
      tg.label AS geography_label
    FROM coverage_slices cs
    LEFT JOIN target_segments ts ON ts.id = cs.segment_id
    LEFT JOIN target_geographies tg ON tg.id = cs.geography_id
    WHERE cs.status IN ('active', 'stalled')
      AND (cs.next_run_after_at IS NULL OR cs.next_run_after_at <= ?1)
      AND (ts.id IS NULL OR ts.status = 'active')
      AND (tg.id IS NULL OR tg.status = 'active')
  `).all(now) as Record<string, unknown>[];

  const candidates = sliceRows.map(acquisitionCandidateFromCoverageRow);
  const coveredDefaults = new Set(candidates
    .map((candidate) => acquisitionSegmentGeographyKey(candidate.segmentId, candidate.geographyText))
    .filter((key) => key !== "|"));

  const segmentRows = db.query(`
    SELECT *
    FROM target_segments
    WHERE status = 'active'
  `).all() as Record<string, unknown>[];
  for (const row of segmentRows) {
    const segmentId = String(row.id);
    const geographyText = String(row.default_geo ?? "").trim() || "Perth";
    const defaultKey = acquisitionSegmentGeographyKey(segmentId, geographyText);
    if (coveredDefaults.has(defaultKey)) continue;
    candidates.push({
      source: "segment_default",
      coverageSliceId: null,
      segmentId,
      segmentLabel: String(row.label),
      segmentTier: Number(row.tier ?? 999),
      segmentPriority: Number(row.priority ?? 999999),
      geographyId: null,
      geographyText,
      sourceFamily: "web",
      strategyType: "search",
      status: "active",
      targetCounts: jsonParse<Record<string, unknown>>(row.coverage_targets_json, {}),
      defaultTargetCount: Number(row.default_target_count ?? 0),
      yieldMetrics: {},
      lastRunAt: null,
      nextRunAfterAt: null,
      stalledReason: "",
      createdAt: Number(row.created_at ?? 0),
    });
  }

  return candidates;
}

function evaluateAcquisitionCandidate(candidate: AcquisitionCandidate, settings: ReturnType<typeof getSchedulerSettings>, now: number) {
  const targetFound = acquisitionTargetFound(candidate);
  if (targetFound <= 0) return null;
  const currentCounts = countAcquisitionCoverageCompanies({
    segmentId: candidate.segmentId,
    geographyText: candidate.geographyText,
  });
  const sourceBackedUniqueDeficit = Math.max(0, targetFound - currentCounts.sourceBackedUnique);
  if (sourceBackedUniqueDeficit <= 0) return null;

  const executedAttempts = numericField(candidate.yieldMetrics, "executedAttempts", 0);
  const resultCount = numericField(candidate.yieldMetrics, "resultCount", 0);
  const netNewCompanies = numericField(candidate.yieldMetrics, "netNewCompanies", resultCount);
  const blockedAttempts = numericField(candidate.yieldMetrics, "blockedAttempts", 0);
  const averageResultCount = numericField(candidate.yieldMetrics, "averageResultCount", executedAttempts ? resultCount / executedAttempts : 0);
  const lowYield = executedAttempts > 0 && (candidate.status === "stalled" || netNewCompanies <= 0 || averageResultCount < 1 || blockedAttempts > 0);
  const acquisitionCooldownMs = Math.max(0, Number(settings.cooldowns.acquisitionMs ?? 0));
  const lowYieldCooldownMs = Math.max(0, Number(settings.cooldowns.stalledSliceMs ?? acquisitionCooldownMs));
  const cooldownMs = lowYield ? Math.max(acquisitionCooldownMs, lowYieldCooldownMs) : acquisitionCooldownMs;
  const nextEligibleAt = candidate.lastRunAt && cooldownMs > 0 ? candidate.lastRunAt + cooldownMs : null;
  if (lowYield && nextEligibleAt && nextEligibleAt > now) return null;

  const isTier1Perth = candidate.segmentTier === 1 && /perth/i.test(candidate.geographyText);
  const deficitRatio = sourceBackedUniqueDeficit / Math.max(1, targetFound);
  const recencyPenalty = nextEligibleAt && nextEligibleAt > now ? 25 : 0;
  const lowYieldPenalty = lowYield ? 500 : 0;
  const score = (candidate.segmentPriority * 1000)
    - (isTier1Perth ? 100 : 0)
    - (deficitRatio * 50)
    + lowYieldPenalty
    + recencyPenalty;

  return {
    candidate,
    targetFound,
    currentCounts,
    sourceBackedUniqueDeficit,
    lowYield,
    cooldownMs,
    nextEligibleAt,
    isTier1Perth,
    score,
  };
}

function acquisitionExplorationRank(candidate: AcquisitionCandidate) {
  const executedAttempts = numericField(candidate.yieldMetrics, "executedAttempts", 0);
  if (candidate.source === "segment_default") return 0;
  if (executedAttempts <= 0) return 1;
  if (!candidate.lastRunAt) return 2;
  return 3;
}

function selectAcquisitionDryRun(settings = getSchedulerSettings(), now = Date.now(), options: { preferExploration?: boolean } = {}) {
  const counts = schedulerCompanyCounts();
  if (counts.activePool >= settings.targetPoolSize) {
    return { item: null, reason: `target pool has ${counts.activePool}/${settings.targetPoolSize} active companies` };
  }

  const evaluated = listAcquisitionCandidates(now)
    .map((candidate) => evaluateAcquisitionCandidate(candidate, settings, now))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) =>
      (options.preferExploration ? acquisitionExplorationRank(a.candidate) - acquisitionExplorationRank(b.candidate) : 0)
      || a.score - b.score
      || b.sourceBackedUniqueDeficit - a.sourceBackedUniqueDeficit
      || a.candidate.segmentPriority - b.candidate.segmentPriority
      || (a.candidate.lastRunAt ?? 0) - (b.candidate.lastRunAt ?? 0)
      || a.candidate.geographyText.localeCompare(b.candidate.geographyText)
      || a.candidate.sourceFamily.localeCompare(b.candidate.sourceFamily)
      || a.candidate.strategyType.localeCompare(b.candidate.strategyType)
      || a.candidate.segmentLabel.localeCompare(b.candidate.segmentLabel)
    );

  const selected = evaluated[0];
  if (selected) {
    const candidate = selected.candidate;
    return {
      item: {
        kind: "acquisition_slice",
        coverageSliceId: candidate.coverageSliceId,
        segmentId: candidate.segmentId,
        segmentLabel: candidate.segmentLabel,
        segmentTier: candidate.segmentTier,
        segmentPriority: candidate.segmentPriority,
        geographyId: candidate.geographyId,
        geographyText: candidate.geographyText,
        sourceFamily: candidate.sourceFamily,
        strategyType: candidate.strategyType,
        targetCounts: candidate.targetCounts,
        currentCounts: selected.currentCounts,
        deficit: {
          targetFound: selected.targetFound,
          sourceBackedUnique: selected.sourceBackedUniqueDeficit,
        },
        yieldMetrics: candidate.yieldMetrics,
        cooldown: {
          lowYield: selected.lowYield,
          cooldownMs: selected.cooldownMs,
          lastRunAt: candidate.lastRunAt,
          nextEligibleAt: selected.nextEligibleAt,
          stalledReason: candidate.stalledReason,
        },
        selection: {
          source: candidate.source,
          score: selected.score,
          preferredTier1Perth: selected.isTier1Perth,
          explorationRank: acquisitionExplorationRank(candidate),
          preferExploration: Boolean(options.preferExploration),
        },
      },
      reason: `target pool has ${counts.activePool}/${settings.targetPoolSize} active companies; ${candidate.segmentLabel || "coverage slice"} in ${candidate.geographyText || "unspecified geography"} needs ${selected.sourceBackedUniqueDeficit} more source-backed unique prospects to reach ${selected.targetFound}`,
    };
  }

  return { item: null, reason: "target pool is below target, but no active due segment or coverage slice needs acquisition" };
}

function selectEnrichmentDryRun(settings = getSchedulerSettings()) {
  const counts = schedulerCompanyCounts();
  if (counts.enriched >= settings.enrichedFloor) {
    return { item: null, reason: `enriched floor is met at ${counts.enriched}/${settings.enrichedFloor}` };
  }
  const now = Date.now();
  const queued = db.query(`
    SELECT wq.*, c.id AS company_id, c.name, c.location, c.industry, c.website, c.data_ring,
      c.duplicate_status, c.enrichment_status, c.confidence, c.profile_json, c.created_at AS company_created_at,
      c.updated_at AS company_updated_at
    FROM work_queue wq
    JOIN companies c ON c.id = wq.target_id AND wq.target_type = 'company'
    WHERE wq.kind = 'company_enrichment'
      AND wq.status IN ('queued', 'failed')
      AND (wq.next_run_after_at IS NULL OR wq.next_run_after_at <= ?1)
      AND COALESCE(wq.locked_by_run_id, '') = ''
      AND c.data_ring NOT IN ('parked', 'contacted')
    ORDER BY CASE WHEN wq.status = 'queued' THEN 0 ELSE 1 END,
      wq.priority ASC,
      COALESCE(wq.next_run_after_at, 0) ASC,
      wq.updated_at ASC,
      lower(c.name) ASC
    LIMIT 1
  `).get(now) as Record<string, unknown> | null;
  if (queued) {
    return {
      item: {
        kind: "work_queue",
        queueItem: mapWorkQueueItem(queued),
        company: mapCompany({
          id: queued.company_id,
          name: queued.name,
          location: queued.location,
          industry: queued.industry,
          website: queued.website,
          data_ring: queued.data_ring,
          duplicate_status: queued.duplicate_status,
          enrichment_status: queued.enrichment_status,
          confidence: queued.confidence,
          profile_json: queued.profile_json,
          created_at: queued.company_created_at,
          updated_at: queued.company_updated_at,
        }),
      },
      reason: `enriched floor is ${counts.enriched}/${settings.enrichedFloor}; queued enrichment ${String(queued.id)} is due for ${String(queued.name)}`,
    };
  }
  const row = db.query(`
    SELECT c.*, COALESCE(MIN(ts.priority), 999999) AS segment_priority, COUNT(s.id) AS source_count
    FROM companies c
    LEFT JOIN company_segments cseg ON cseg.company_id = c.id
    LEFT JOIN target_segments ts ON ts.id = cseg.segment_id
    LEFT JOIN sources s ON s.company_id = c.id
    WHERE c.enrichment_status IN ('not_started', 'failed')
      AND c.data_ring NOT IN ('parked', 'contacted')
      AND NOT EXISTS (
        SELECT 1
        FROM enrichment_requests er
        WHERE er.company_id = c.id
          AND er.status IN ('queued', 'running')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM work_queue wq
        WHERE wq.kind = 'company_enrichment'
          AND wq.target_type = 'company'
          AND wq.target_id = c.id
          AND wq.status IN ('queued', 'running')
      )
    GROUP BY c.id
    ORDER BY CASE WHEN COALESCE(c.website, '') != '' THEN 0 ELSE 1 END ASC,
      source_count DESC,
      segment_priority ASC,
      c.updated_at ASC,
      lower(c.name) ASC
    LIMIT 1
  `).get() as Record<string, unknown> | null;
  if (!row) return { item: null, reason: `enriched floor is ${counts.enriched}/${settings.enrichedFloor}, but no unqueued enrichment candidate exists` };
  return {
    item: {
      kind: "company",
      company: mapCompany(row),
      sourceCount: Number(row.source_count ?? 0),
    },
    reason: `enriched floor is ${counts.enriched}/${settings.enrichedFloor}; company ${String(row.name)} is unqueued for enrichment`,
  };
}

function selectScoringDryRun(settings = getSchedulerSettings()) {
  const counts = schedulerCompanyCounts();
  const activeScoring = listActiveScoringOfferings();
  const marketProfileVersionId = activeScoring.profile?.currentVersionId ?? "";
  const offeringCount = activeScoring.offerings.length;
  if (!marketProfileVersionId || !offeringCount) {
    return { item: null, reason: "no active service offerings are available for scoring" };
  }
  if (counts.scored >= settings.topTargetCount) {
    return { item: null, reason: `top-target scoring target is met at ${counts.scored}/${settings.topTargetCount}` };
  }
  const row = selectScoringCandidateRows(marketProfileVersionId, offeringCount, 1)[0] ?? null;
  if (!row) return { item: null, reason: `top-target scoring target is ${counts.scored}/${settings.topTargetCount}, but no enriched unscored company exists` };
  return {
    item: {
      kind: "company",
      company: mapCompany(row),
    },
    reason: `top-target scoring target is ${counts.scored}/${settings.topTargetCount}; company ${String(row.name)} is enriched and needs scoring against ${offeringCount} offering${offeringCount === 1 ? "" : "s"}`,
  };
}

function selectScoringCandidateRows(marketProfileVersionId: string, offeringCount: number, limit: number) {
  if (!marketProfileVersionId || offeringCount <= 0 || limit <= 0) return [];
  return db.query(`
    SELECT c.*, COALESCE(MIN(ts.priority), 999999) AS segment_priority
    FROM companies c
    LEFT JOIN company_segments cseg ON cseg.company_id = c.id
    LEFT JOIN target_segments ts ON ts.id = cseg.segment_id
    WHERE (c.enrichment_status = 'complete' OR c.data_ring IN ('enhanced', 'ranked', 'stale'))
      AND c.data_ring NOT IN ('scored', 'outreach_ready', 'outreach', 'contacted', 'parked')
      AND (
        SELECT COUNT(DISTINCT sfa.service_offering_id)
        FROM service_fit_assessments sfa
        WHERE sfa.company_id = c.id
          AND sfa.market_profile_version_id = ?1
      ) < ?2
      AND NOT EXISTS (
        SELECT 1
        FROM work_queue wq
        WHERE wq.kind = 'service_fit_assessment'
          AND wq.status IN ('queued', 'running')
          AND (
            wq.target_id = c.id || ':all:' || ?1
            OR wq.target_id LIKE c.id || ':%:' || ?1
          )
      )
    GROUP BY c.id
    ORDER BY segment_priority ASC, c.confidence DESC, c.updated_at ASC, lower(c.name) ASC
    LIMIT ?3
  `).all(marketProfileVersionId, offeringCount, Math.max(1, Math.min(100, Math.floor(limit)))) as Record<string, unknown>[];
}

function selectOutreachDryRun(settings = getSchedulerSettings()) {
  const counts = schedulerCompanyCounts();
  if (counts.outreachReady >= settings.outreachTargetCount) {
    return { item: null, reason: `outreach-ready target is met at ${counts.outreachReady}/${settings.outreachTargetCount}` };
  }
  const latestTopTargetRun = latestTopTargetRunId();
  if (latestTopTargetRun) {
    const topTarget = db.query(`
      SELECT
        tli.*,
        c.name,
        c.location,
        c.industry,
        c.website,
        c.data_ring,
        c.duplicate_status,
        c.enrichment_status,
        c.confidence AS company_confidence,
        c.profile_json,
        c.created_at AS company_created_at,
        c.updated_at AS company_updated_at
      FROM target_list_items tli
      JOIN companies c ON c.id = tli.company_id
      WHERE tli.target_list_run_id = ?1
        AND c.data_ring NOT IN ('contacted', 'parked')
        AND EXISTS (SELECT 1 FROM service_fit_assessments sfa WHERE sfa.company_id = tli.company_id)
        AND NOT EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = tli.company_id)
        AND NOT EXISTS (
          SELECT 1
          FROM kindling_pipeline_runs kpr
          WHERE kpr.role_key = 'draft_outreach'
            AND kpr.status IN ('queued', 'running', 'mock')
            AND kpr.local_request_id = tli.company_id
        )
      ORDER BY tli.rank ASC
      LIMIT 1
    `).get(latestTopTargetRun) as Record<string, unknown> | null;
    if (topTarget) {
      const companyRow = {
        id: topTarget.company_id,
        name: topTarget.name,
        location: topTarget.location,
        industry: topTarget.industry,
        website: topTarget.website,
        data_ring: topTarget.data_ring,
        duplicate_status: topTarget.duplicate_status,
        enrichment_status: topTarget.enrichment_status,
        confidence: topTarget.company_confidence,
        profile_json: topTarget.profile_json,
        created_at: topTarget.company_created_at,
        updated_at: topTarget.company_updated_at,
      };
      return {
        item: {
          kind: "company",
          company: mapCompany(companyRow),
          topTarget: mapTopTargetItem(topTarget),
          ranking: {
            id: String(topTarget.id),
            rank: Number(topTarget.rank ?? 0),
            reason: String(topTarget.reason ?? ""),
            source: "top_targets",
          },
        },
        reason: `outreach-ready target is ${counts.outreachReady}/${settings.outreachTargetCount}; top target #${Number(topTarget.rank ?? 0)} ${String(topTarget.name)} is the first undrafted ranked company`,
      };
    }
  }
  const row = db.query(`
    SELECT c.*
    FROM companies c
    WHERE EXISTS (SELECT 1 FROM service_fit_assessments sfa WHERE sfa.company_id = c.id)
      AND c.data_ring NOT IN ('contacted', 'parked')
      AND NOT EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = c.id)
    ORDER BY c.confidence DESC,
      c.updated_at ASC,
      lower(c.name) ASC
    LIMIT 1
  `).get() as Record<string, unknown> | null;
  if (!row) return { item: null, reason: `outreach-ready target is ${counts.outreachReady}/${settings.outreachTargetCount}, but no scored undrafted company exists` };
  return {
    item: {
      kind: "company",
      company: mapCompany(row),
    },
    reason: `outreach-ready target is ${counts.outreachReady}/${settings.outreachTargetCount}; company ${String(row.name)} is ready for outreach drafting`,
  };
}

function computeSchedulerDryRunDecision(now = Date.now()): SchedulerDryRunDecision {
  reconcileSchedulerState(now);
  const settings = getSchedulerSettings();
  const lock = activeSchedulerLock(now);
  const evaluatedRoles: SchedulerRoleEvaluation[] = [];
  if (!settings.enabled) {
    return {
      dryRun: true,
      workAvailable: false,
      action: "no_work",
      roleKey: null,
      item: null,
      reason: "scheduler is disabled",
      evaluatedRoles,
      activeLock: lock,
    };
  }
  if (lock) {
    return {
      dryRun: true,
      workAvailable: false,
      action: "no_work",
      roleKey: null,
      item: null,
      reason: `scheduler lock prospecting is held by ${lock.ownerId} until ${lock.leaseExpiresAt}`,
      evaluatedRoles,
      activeLock: lock,
    };
  }

  const candidates: Array<{
    action: SchedulerActionKey;
    roleKey: string;
    enabled: boolean;
    select: () => { item: Record<string, unknown> | null; reason: string };
  }> = [
    { action: "acquisition", roleKey: "scan_target_list", enabled: settings.acquisitionEnabled, select: () => selectAcquisitionDryRun(settings, now) },
    { action: "enrichment", roleKey: "enrich_company", enabled: settings.enrichmentEnabled, select: () => selectEnrichmentDryRun(settings) },
    { action: "scoring", roleKey: "score_company_service_fit", enabled: settings.scoringEnabled, select: () => selectScoringDryRun(settings) },
    { action: "outreach", roleKey: "draft_outreach", enabled: settings.outreachEnabled, select: () => selectOutreachDryRun(settings) },
  ];

  for (const candidate of candidates) {
    const concurrency = roleConcurrencyState(candidate.roleKey, settings);
    if (!candidate.enabled) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "skipped",
        reason: `${candidate.action} is disabled in scheduler settings`,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      continue;
    }
    if (concurrency.blockedReason) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "skipped",
        reason: concurrency.blockedReason,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      continue;
    }
    const selection = candidate.select();
    if (selection.item) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "selected",
        reason: selection.reason,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      return {
        dryRun: true,
        workAvailable: true,
        action: candidate.action,
        roleKey: candidate.roleKey,
        item: selection.item,
        reason: selection.reason,
        evaluatedRoles,
        activeLock: null,
      };
    }
    evaluatedRoles.push({
      action: candidate.action,
      roleKey: candidate.roleKey,
      status: "skipped",
      reason: selection.reason,
      activeCount: concurrency.activeCount,
      concurrencyLimit: concurrency.concurrencyLimit,
    });
  }

  return {
    dryRun: true,
    workAvailable: false,
    action: "no_work",
    roleKey: null,
    item: null,
    reason: "no scheduler work is available",
    evaluatedRoles,
    activeLock: null,
  };
}

function computeProspectingLoopDecision(now = Date.now()): SchedulerDryRunDecision {
  reconcileSchedulerState(now);
  const settings = getSchedulerSettings();
  const lock = activeSchedulerLock(now);
  const evaluatedRoles: SchedulerRoleEvaluation[] = [];
  if (!settings.enabled) {
    return {
      dryRun: true,
      workAvailable: false,
      action: "no_work",
      roleKey: null,
      item: null,
      reason: "scheduler is disabled",
      evaluatedRoles,
      activeLock: lock,
    };
  }
  if (lock) {
    return {
      dryRun: true,
      workAvailable: false,
      action: "no_work",
      roleKey: null,
      item: null,
      reason: `scheduler lock prospecting is held by ${lock.ownerId} until ${lock.leaseExpiresAt}`,
      evaluatedRoles,
      activeLock: lock,
    };
  }

  const candidates: Array<{
    action: SchedulerActionKey;
    roleKey: string;
    enabled: boolean;
    select: () => { item: Record<string, unknown> | null; reason: string };
  }> = [
    { action: "acquisition", roleKey: "scan_target_list", enabled: settings.acquisitionEnabled, select: () => selectAcquisitionDryRun(settings, now) },
    { action: "scoring", roleKey: "score_company_service_fit", enabled: settings.scoringEnabled, select: () => selectScoringDryRun(settings) },
  ];

  for (const candidate of candidates) {
    const concurrency = roleConcurrencyState(candidate.roleKey, settings);
    if (!candidate.enabled) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "skipped",
        reason: `${candidate.action} is disabled in scheduler settings`,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      continue;
    }
    if (concurrency.blockedReason) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "skipped",
        reason: concurrency.blockedReason,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      continue;
    }
    const selected = candidate.select();
    if (selected.item) {
      evaluatedRoles.push({
        action: candidate.action,
        roleKey: candidate.roleKey,
        status: "selected",
        reason: selected.reason,
        activeCount: concurrency.activeCount,
        concurrencyLimit: concurrency.concurrencyLimit,
      });
      return {
        dryRun: true,
        workAvailable: true,
        action: candidate.action,
        roleKey: candidate.roleKey,
        item: selected.item,
        reason: selected.reason,
        evaluatedRoles,
        activeLock: null,
      };
    }
    evaluatedRoles.push({
      action: candidate.action,
      roleKey: candidate.roleKey,
      status: "skipped",
      reason: selected.reason,
      activeCount: concurrency.activeCount,
      concurrencyLimit: concurrency.concurrencyLimit,
    });
  }

  return {
    dryRun: true,
    workAvailable: false,
    action: "no_work",
    roleKey: null,
    item: null,
    reason: "no executable automated prospecting work is available",
    evaluatedRoles,
    activeLock: null,
  };
}

function schedulerAcquisitionTargetCount(item: SchedulerAcquisitionWork) {
  const currentCounts = objectRecord(item.currentCounts);
  const deficit = objectRecord(item.deficit);
  const targetCounts = objectRecord(item.targetCounts);
  const targetFound = numericField(deficit, "targetFound", numericField(targetCounts, "found", 25));
  const sourceBackedDeficit = numericField(deficit, "sourceBackedUnique", targetFound);
  const currentFound = numericField(currentCounts, "found", 0);
  const remaining = Math.max(1, currentFound + sourceBackedDeficit - currentFound);
  return clampTargetCount(Math.min(SCHEDULED_ACQUISITION_TARGET_COUNT, remaining));
}

function listPriorAcquisitionStrategies(input: {
  coverageSliceId: string | null;
  industry: string;
  location: string;
  limit?: number;
}) {
  if (input.coverageSliceId) {
    const rows = db.query(`
      SELECT *
      FROM scan_strategy_attempts
      WHERE coverage_slice_id = ?1
        AND status != 'planned'
      ORDER BY created_at DESC
      LIMIT ?2
    `).all(input.coverageSliceId, input.limit ?? 50) as Record<string, unknown>[];
    return rows.map((row) => ({
      strategyType: String(row.strategy_type),
      query: String(row.query),
      status: String(row.status),
      resultCount: Number(row.result_count),
      notes: String(row.notes ?? ""),
      industry: String(row.industry),
      location: String(row.location),
      geographyText: String(row.geography_text ?? row.location ?? ""),
      coverageSliceId: row.coverage_slice_id ? String(row.coverage_slice_id) : null,
      sourceFamily: String(row.source_family ?? ""),
      createdAt: Number(row.created_at),
    }));
  }
  return listScanStrategyHistory(input.industry, input.location, input.limit ?? 50);
}

function updateSchedulerRunForRequest(input: {
  requestId: string;
  status: "running" | "complete" | "failed";
  roleKey?: string;
  result?: Record<string, unknown>;
  error?: string;
  autopilotRunId?: string | null;
  finish?: boolean;
  releaseLock?: boolean;
}) {
  const schedulerRun = db.query(`
    SELECT *
    FROM scheduler_runs
    WHERE local_request_id = ?1
      AND role_key = ?2
      AND run_type != 'dry_run'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(input.requestId, input.roleKey ?? "scan_target_list") as Record<string, unknown> | null;
  if (!schedulerRun) return null;
  const now = Date.now();
  const existingResult = jsonParse<Record<string, unknown>>(schedulerRun.result_json, {});
  const nextResult = input.result ? { ...existingResult, ...input.result } : existingResult;
  db.query(`
    UPDATE scheduler_runs
    SET status = ?1,
        autopilot_run_id = COALESCE(?2, autopilot_run_id),
        result_json = ?3,
        error = CASE WHEN ?4 = '' THEN error ELSE ?4 END,
        finished_at = CASE WHEN ?5 = 1 THEN COALESCE(finished_at, ?6) ELSE finished_at END,
        updated_at = ?6
    WHERE id = ?7
  `).run(
    input.status,
    input.autopilotRunId || null,
    JSON.stringify(nextResult),
    input.error ?? "",
    input.finish ? 1 : 0,
    now,
    String(schedulerRun.id),
  );
  if (input.releaseLock) releaseSchedulerLock(String(schedulerRun.lock_key ?? "prospecting"), String(schedulerRun.id));
  return String(schedulerRun.id);
}

function markSchedulerAcquisitionFailed(requestId: string, error: string, result: Record<string, unknown> = {}) {
  const now = Date.now();
  const persistedCount = matchingCompanyCountForJob(requestId);
  const status = persistedCount > 0 ? "partial_failed" : "failed";
  db.query(`
    UPDATE discovery_jobs
    SET status = ?1,
        company_count = MAX(company_count, ?2),
        summary = ?3,
        updated_at = ?4
    WHERE id = ?5
      AND status IN ('queued', 'running', 'partial')
  `).run(
    status,
    persistedCount,
    persistedCount > 0
      ? `Scheduled acquisition stopped after writing ${persistedCount} companies: ${error}`
      : `Scheduled acquisition failed before writing companies: ${error}`,
    now,
    requestId,
  );
  updateSchedulerRunForRequest({
    requestId,
    status: "failed",
    result: {
      terminalStatus: "failed",
      retryable: true,
      persistedCount,
      ...result,
    },
    error,
    finish: true,
    releaseLock: true,
  });
}

function buildScheduledAcquisitionJob(input: {
  item: SchedulerAcquisitionWork;
  decision: SchedulerDryRunDecision;
  schedulerRunId: string;
  req?: Request;
  origin?: string;
  automated?: boolean;
  session: { pubkey: string; npub?: string };
}) {
  const now = Date.now();
  const item = input.item;
  const segmentId = findTargetSegmentIdForScan(item.segmentId) ?? findTargetSegmentIdForScan(item.segmentLabel);
  const industry = String(item.segmentLabel ?? "").trim() || "Target companies";
  const location = String(item.geographyText ?? "").trim() || "Perth, WA";
  const geographyId = String(item.geographyId ?? "").trim() || getOrCreateTargetGeography(location, now);
  const geographyText = location;
  const sourceFamily = normalizeSourceFamily(item.sourceFamily, String(item.strategyType ?? "search"));
  const strategyType = String(item.strategyType ?? "search").trim() || "search";
  const targetCount = schedulerAcquisitionTargetCount(item);
  const scanMode = scanModeForTargetCount(targetCount);
  const scheduledTargetCounts = targetCountsForScheduledAcquisition(segmentId, targetCount);
  const coverageSliceId = String(item.coverageSliceId ?? "").trim() || getOrCreateCoverageSlice({
    segmentId,
    geographyId,
    geographyText,
    sourceFamily,
    strategyType,
    targetCounts: scheduledTargetCounts,
    now,
  });
  db.query("UPDATE coverage_slices SET target_counts_json = ?1, updated_at = ?2 WHERE id = ?3")
    .run(JSON.stringify(scheduledTargetCounts), now, coverageSliceId);
  const jobId = crypto.randomUUID();
  db.query(`
    INSERT INTO discovery_jobs(
      id, industry, location, segment_id, geography_id, geography_text, coverage_slice_id,
      target_count, scan_mode, status, summary, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?11, ?11)
  `).run(
    jobId,
    industry,
    location,
    segmentId,
    geographyId,
    geographyText,
    coverageSliceId,
    targetCount,
    scanMode,
    `Queued by scheduler run ${input.schedulerRunId}`,
    now,
  );

  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const origin = input.req ? webhookOrigin(input.req) : input.origin || PUBLIC_ORIGIN || `http://localhost:${PORT}`;
  const scanContext = buildScanContext(industry, location, targetCount);
  const priorScanStrategies = listPriorAcquisitionStrategies({
    coverageSliceId,
    industry,
    location,
    limit: 50,
  });
  const correlation = {
    schedulerRunId: input.schedulerRunId,
    acquisitionJobId: jobId,
    coverageSliceId,
    roleKey: "scan_target_list",
  };
  const triggerRequest = buildKindlingTriggerRequest({
    roleKey: "scan_target_list",
    localRequestId: jobId,
    message: `Scheduler acquisition: find ${Math.max(1, numericField(objectRecord(item.deficit), "sourceBackedUnique", targetCount))} more source-backed unique prospects for ${industry} in ${location}`,
    context: {
      scheduler: {
        action: "acquisition",
        correlation,
        decisionReason: input.decision.reason,
        selectedWork: item,
      },
      acquisition: {
        segment: {
          id: segmentId,
          label: industry,
          tier: item.segmentTier === null || item.segmentTier === undefined ? null : Number(item.segmentTier),
          priority: Number(item.segmentPriority ?? 0),
        },
        geography: {
          id: geographyId,
          text: geographyText,
        },
        coverageSlice: {
          id: coverageSliceId,
          sourceFamily,
          strategyType,
          targetCounts: objectRecord(item.targetCounts),
          currentCounts: objectRecord(item.currentCounts),
          yieldMetrics: objectRecord(item.yieldMetrics),
          cooldown: objectRecord(item.cooldown),
        },
        targetCount,
        requestedSourceBackedUnique: numericField(objectRecord(item.deficit), "sourceBackedUnique", targetCount),
      },
      industry,
      location,
      segmentId,
      geography: {
        id: geographyId,
        text: geographyText,
      },
      coverageSlice: {
        id: coverageSliceId,
        sourceFamily,
        strategyType,
      },
      targetCount,
      scanMode,
      profile: getCurrentMarketProfile(),
      scanContext,
      priorScanStrategies,
      priorExecutedStrategies: priorScanStrategies,
      scanContextApi: {
        url: `${origin}/api/nip98/kindling/scan-context?industry=${encodeURIComponent(industry)}&location=${encodeURIComponent(location)}&targetCount=${targetCount}`,
        auth: "nip98-read",
      },
      writeApi: {
        url: `${origin}/api/kindling/pipeline-write/target-scan`,
        token: webhookToken,
        authHeader: "x-kindling-pipeline-token",
      },
    },
    webhookUrl: `${origin}/api/kindling/pipeline-webhook`,
    webhookToken,
    userPubkey: input.session.pubkey,
    userNpub: input.session.npub || pubkeyToNpub(input.session.pubkey),
  });
  const kindlingRunId = createKindlingRun({ roleKey: "scan_target_list", localRequestId: jobId, triggerRequest, status: "queued" });
  db.query(`
    UPDATE scheduler_runs
    SET local_request_id = ?1,
        context_json = ?2,
        result_json = ?3,
        updated_at = ?4
    WHERE id = ?5
  `).run(
    jobId,
    JSON.stringify({
      dryRun: false,
      automated: Boolean(input.automated),
      userPubkey: input.session.pubkey,
      evaluatedRoles: input.decision.evaluatedRoles,
      selectedAcquisitionWork: item,
      correlation,
    }),
    JSON.stringify({
      dryRun: false,
      automated: Boolean(input.automated),
      decision: input.decision,
      jobId,
      kindlingRunId,
      triggerPayload: {
        url: triggerRequest.url,
        roleKey: "scan_target_list",
        requestId: jobId,
        correlation,
      },
    }),
    Date.now(),
    input.schedulerRunId,
  );
  recordActivity("scheduler", input.schedulerRunId, "scheduler", "acquisition_queued", `Scheduled acquisition queued for ${industry} in ${location}`, correlation);
  return { jobId, kindlingRunId, triggerRequest, coverageSliceId, targetCount, scanMode, correlation };
}

function hasTargetSegmentParentLoop(segmentId: string, parentId: string | null) {
  let current = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === segmentId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const row = db.query("SELECT parent_id FROM target_segments WHERE id = ?1").get(current) as Record<string, unknown> | null;
    current = row?.parent_id ? String(row.parent_id) : null;
  }
  return false;
}

function listCompanySegments(companyId: string) {
  const rows = db.query(`
    SELECT
      cs.company_id,
      cs.segment_id,
      cs.confidence,
      cs.source,
      cs.created_at,
      ts.parent_id,
      ts.label,
      ts.tier,
      ts.priority,
      ts.status
    FROM company_segments cs
    JOIN target_segments ts ON ts.id = cs.segment_id
    WHERE cs.company_id = ?1
    ORDER BY cs.confidence DESC, ts.priority ASC, ts.label ASC
  `).all(companyId) as Record<string, unknown>[];
  return rows.map((row) => ({
    companyId: String(row.company_id),
    segmentId: String(row.segment_id),
    confidence: Number(row.confidence ?? 0),
    source: String(row.source ?? ""),
    createdAt: Number(row.created_at ?? 0),
    segment: {
      id: String(row.segment_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      label: String(row.label),
      tier: Number(row.tier),
      priority: Number(row.priority),
      status: String(row.status),
    },
  }));
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

function createCompanyEnrichmentQueueItem(input: {
  id?: string;
  companyId: string;
  requestKind: string;
  reason: string;
  priority?: number;
  context?: Record<string, unknown>;
  status?: WorkQueueStatus;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const company = db.query("SELECT * FROM companies WHERE id = ?1").get(input.companyId) as Record<string, unknown> | null;
  const segment = primarySegmentForCompany(input.companyId);
  const queueId = input.id || crypto.randomUUID();
  const requestKind = input.requestKind.trim() || "standard";
  const priority = Number.isFinite(input.priority)
    ? Math.max(0, Math.floor(Number(input.priority)))
    : requestKind === "standard"
      ? 10
      : requestKind === "industry_batch"
        ? 50
        : 100;
  const context = {
    requestKind,
    companyName: String(company?.name ?? ""),
    industry: String(company?.industry ?? ""),
    location: String(company?.location ?? ""),
    website: String(company?.website ?? ""),
    ...(input.context ?? {}),
  };
  db.query(`
    INSERT INTO work_queue(
      id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
      next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
    )
    VALUES (?1, 'company_enrichment', 'company', ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, NULL, '', ?9, ?10, ?10)
  `).run(
    queueId,
    input.companyId,
    segment?.segment_id ? String(segment.segment_id) : null,
    segment?.label ? String(segment.label) : String(company?.industry ?? ""),
    priority,
    input.status ?? "queued",
    input.reason,
    now,
    JSON.stringify(context),
    now,
  );
  return queueId;
}

function attachEnrichmentQueueToRun(queueIds: string[], runId: string, now = Date.now()) {
  if (!queueIds.length) return;
  const placeholders = queueIds.map((_, index) => `?${index + 3}`).join(", ");
  db.query(`
    UPDATE work_queue
    SET locked_by_run_id = ?1, updated_at = ?2
    WHERE id IN (${placeholders})
      AND kind = 'company_enrichment'
  `).run(runId, now, ...queueIds);
}

function markRunEnrichmentQueueRunning(run: Record<string, unknown>, remoteRunId: string, now = Date.now()) {
  const roleKey = String(run.role_key ?? "");
  const requestId = String(run.local_request_id ?? "");
  if (roleKey === "enrich_company") {
    db.query(`
      UPDATE work_queue
      SET status = 'running',
          attempts = attempts + 1,
          locked_by_run_id = ?1,
          error = '',
          updated_at = ?2
      WHERE id IN (
        SELECT COALESCE(NULLIF(work_queue_id, ''), id)
        FROM enrichment_requests
        WHERE id = ?3
      )
    `).run(remoteRunId || String(run.id), now, requestId);
    db.query("UPDATE enrichment_requests SET status = 'running', updated_at = ?1 WHERE id = ?2 AND status = 'queued'")
      .run(now, requestId);
    db.query(`
      UPDATE companies
      SET enrichment_status = 'running', updated_at = ?1
      WHERE id IN (SELECT company_id FROM enrichment_requests WHERE id = ?2)
        AND enrichment_status = 'queued'
    `).run(now, requestId);
  }
  if (roleKey === "enrich_industry_segment") {
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
    `).run(remoteRunId || String(run.id), now, String(run.id));
    db.query(`
      UPDATE enrichment_requests
      SET status = 'running', updated_at = ?1
      WHERE COALESCE(NULLIF(work_queue_id, ''), id) IN (
        SELECT id FROM work_queue WHERE locked_by_run_id = ?2 AND status = 'running'
      )
        AND status = 'queued'
    `).run(now, remoteRunId || String(run.id));
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
    `).run(now, remoteRunId || String(run.id));
  }
}

function completeEnrichmentQueueForRequest(requestId: string, companyId: string, summary: string, now = Date.now()) {
  const requestRow = db.query(`
    SELECT id, work_queue_id
    FROM enrichment_requests
    WHERE (id = ?1 OR company_id = ?2)
      AND status IN ('queued', 'running')
    ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `).get(requestId, companyId) as Record<string, unknown> | null;
  if (!requestRow) return null;
  db.query("UPDATE enrichment_requests SET status = 'complete', summary = ?1, updated_at = ?2 WHERE id = ?3")
    .run(summary || "Enrichment complete", now, String(requestRow.id));
  db.query(`
    UPDATE work_queue
    SET status = 'complete',
        error = '',
        next_run_after_at = NULL,
        updated_at = ?1
    WHERE id = ?2
  `).run(now, String(requestRow.work_queue_id || requestRow.id));
  return requestRow;
}

function failEnrichmentQueueForRequest(requestId: string, reason: string, now = Date.now()) {
  const requestRow = db.query("SELECT id, company_id, work_queue_id FROM enrichment_requests WHERE id = ?1")
    .get(requestId) as Record<string, unknown> | null;
  if (!requestRow) return false;
  db.query("UPDATE enrichment_requests SET status = 'failed', summary = ?1, updated_at = ?2 WHERE id = ?3")
    .run(reason, now, requestId);
  db.query(`
    UPDATE work_queue
    SET status = 'failed',
        error = ?1,
        next_run_after_at = ?2,
        locked_by_run_id = NULL,
        updated_at = ?2
    WHERE id = ?3
  `).run(reason, now, String(requestRow.work_queue_id || requestRow.id));
  db.query(`
    UPDATE companies
    SET enrichment_status = 'failed', updated_at = ?1
    WHERE id = ?2
      AND enrichment_status IN ('queued', 'running')
  `).run(now, String(requestRow.company_id));
  return true;
}

function failEnrichmentQueueForRun(run: Record<string, unknown>, reason: string, now = Date.now()) {
  const roleKey = String(run.role_key ?? "");
  const requestId = String(run.local_request_id ?? "");
  if (roleKey === "enrich_company") {
    failEnrichmentQueueForRequest(requestId, reason, now);
    db.query(`
      UPDATE work_queue
      SET attempts = attempts + CASE WHEN status = 'failed' THEN 1 ELSE 0 END,
          updated_at = ?1
      WHERE id IN (
        SELECT COALESCE(NULLIF(work_queue_id, ''), id)
        FROM enrichment_requests
        WHERE id = ?2
      )
        AND attempts = 0
    `).run(now, requestId);
  }
  if (roleKey === "enrich_industry_segment") {
    const lockIds = [String(run.autopilot_run_id ?? ""), String(run.id ?? "")].filter(Boolean);
    const lockPlaceholders = lockIds.map((_, index) => `?${index + 3}`).join(", ");
    db.query(`
      UPDATE work_queue
      SET status = 'failed',
          attempts = attempts + CASE WHEN attempts = 0 THEN 1 ELSE 0 END,
          error = ?1,
          next_run_after_at = ?2,
          locked_by_run_id = NULL,
          updated_at = ?2
      WHERE kind = 'company_enrichment'
        AND locked_by_run_id IN (${lockPlaceholders})
        AND status IN ('queued', 'running')
    `).run(reason, now, ...lockIds);
    db.query(`
      UPDATE enrichment_requests
      SET status = 'failed', summary = ?1, updated_at = ?2
      WHERE status IN ('queued', 'running')
        AND COALESCE(NULLIF(work_queue_id, ''), id) IN (
          SELECT id
          FROM work_queue
          WHERE kind = 'company_enrichment'
            AND error = ?1
            AND updated_at = ?2
        )
    `).run(reason, now);
    db.query(`
      UPDATE companies
      SET enrichment_status = 'failed', updated_at = ?1
      WHERE id IN (
        SELECT target_id
        FROM work_queue
        WHERE kind = 'company_enrichment'
          AND target_type = 'company'
          AND error = ?2
          AND updated_at = ?1
      )
        AND enrichment_status IN ('queued', 'running')
    `).run(now, reason);
  }
}

function listWorkQueueItems(filters: URLSearchParams) {
  const clauses: string[] = [];
  const values: string[] = [];
  const add = (column: string, value: string | null) => {
    if (!value) return;
    values.push(value);
    clauses.push(`wq.${column} = ?${values.length}`);
  };
  add("kind", filters.get("kind"));
  add("status", filters.get("status"));
  add("target_type", filters.get("targetType") || filters.get("target_type"));
  add("target_id", filters.get("targetId") || filters.get("target_id"));
  const { limit, offset } = pagingFromParams(filters);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.query(`SELECT COUNT(*) AS count FROM work_queue wq ${where}`).get(...values) as { count: number } | null;
  const rows = db.query(`
    SELECT wq.*, c.name AS company_name, c.industry AS company_industry, c.location AS company_location, c.website AS company_website
    FROM work_queue wq
    LEFT JOIN companies c ON wq.target_type = 'company' AND c.id = wq.target_id
    ${where}
    ORDER BY
      CASE wq.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
      wq.priority ASC,
      COALESCE(wq.next_run_after_at, 0) ASC,
      wq.updated_at ASC
    LIMIT ?${values.length + 1}
    OFFSET ?${values.length + 2}
  `).all(...values, limit, offset) as Record<string, unknown>[];
  const items = rows.map((row) => {
    const mapped = mapWorkQueueItem(row);
    return {
      ...mapped,
      context: undefined,
      target: row.company_name
        ? {
          id: String(row.target_id),
          type: String(row.target_type),
          name: String(row.company_name),
          industry: String(row.company_industry ?? ""),
          location: String(row.company_location ?? ""),
          website: String(row.company_website ?? ""),
        }
        : { id: String(row.target_id), type: String(row.target_type) },
    };
  });
  return {
    items,
    total: Number(total?.count ?? 0),
    returned: items.length,
    limit,
    offset,
  };
}

function retryWorkQueueItem(id: string, now = Date.now()) {
  const row = db.query("SELECT * FROM work_queue WHERE id = ?1").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  if (!["failed", "cancelled"].includes(String(row.status))) return false;
  db.query(`
    UPDATE work_queue
    SET status = 'queued',
        next_run_after_at = ?1,
        locked_by_run_id = NULL,
        error = '',
        updated_at = ?1
    WHERE id = ?2
  `).run(now, id);
  db.query(`
    UPDATE enrichment_requests
    SET status = 'queued',
        summary = 'Retry queued',
        updated_at = ?1
    WHERE COALESCE(NULLIF(work_queue_id, ''), id) = ?2
  `).run(now, id);
  if (String(row.kind) === "company_enrichment" && String(row.target_type) === "company") {
    db.query(`
      UPDATE companies
      SET enrichment_status = 'queued', updated_at = ?1
      WHERE id = ?2
    `).run(now, String(row.target_id));
  }
  return db.query("SELECT * FROM work_queue WHERE id = ?1").get(id) as Record<string, unknown>;
}

function clearFailedWorkQueueItems(input: { kind?: string; now?: number } = {}) {
  const now = input.now ?? Date.now();
  const kind = String(input.kind ?? "").trim();
  const clauses = ["status = 'failed'"];
  const values: string[] = [];
  if (kind) {
    values.push(kind);
    clauses.push(`kind = ?${values.length}`);
  }
  const where = clauses.join(" AND ");
  const rows = db.query(`SELECT * FROM work_queue WHERE ${where}`).all(...values) as Record<string, unknown>[];
  if (!rows.length) return { cleared: 0, byKind: {}, ids: [] };

  const byKind: Record<string, number> = {};
  for (const row of rows) {
    const rowKind = String(row.kind ?? "");
    byKind[rowKind] = (byKind[rowKind] ?? 0) + 1;
  }
  const ids = rows.map((row) => String(row.id));

  const transaction = db.transaction(() => {
    db.query(`
      UPDATE work_queue
      SET status = 'cancelled',
          locked_by_run_id = NULL,
          updated_at = ?${values.length + 1}
      WHERE ${where}
    `).run(...values, now);
    const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ");
    db.query(`
      UPDATE enrichment_requests
      SET status = 'cancelled',
          summary = CASE WHEN summary = '' THEN 'Failed queue item cleared' ELSE summary END,
          updated_at = ?1
      WHERE work_queue_id IN (${placeholders})
        AND status = 'failed'
    `).run(now, ...ids);
  });
  transaction();
  return { cleared: rows.length, byKind, ids };
}

const KINDLING_IMPORT_TABLES = {
  market_profiles: ["id", "name", "current_version_id", "created_at", "updated_at"],
  market_profile_versions: [
    "id",
    "profile_id",
    "version_number",
    "structured_json",
    "summary",
    "rationale",
    "source_references_json",
    "created_at",
  ],
  service_offerings: [
    "id",
    "market_profile_version_id",
    "key",
    "name",
    "variant_key",
    "structured_json",
    "status",
    "created_at",
    "updated_at",
  ],
  service_fit_assessments: [
    "id",
    "company_id",
    "service_offering_id",
    "market_profile_version_id",
    "score",
    "band",
    "confidence",
    "drivers_json",
    "fit_explanation",
    "evidence_json",
    "caveats_json",
    "recommended_action",
    "source_run_id",
    "assessment_json",
    "created_at",
    "updated_at",
  ],
  target_segments: [
    "id",
    "parent_id",
    "label",
    "tier",
    "priority",
    "status",
    "default_geo",
    "default_target_count",
    "default_batch_size",
    "coverage_targets_json",
    "scan_prompts_json",
    "created_at",
    "updated_at",
  ],
  companies: [
    "id",
    "name",
    "location",
    "industry",
    "website",
    "data_ring",
    "duplicate_status",
    "enrichment_status",
    "confidence",
    "profile_json",
    "created_at",
    "updated_at",
  ],
  sources: [
    "id",
    "company_id",
    "source_type",
    "url",
    "title",
    "summary",
    "extracted_data_json",
    "confidence",
    "last_checked_at",
    "last_checked_by_run_id",
    "terms_notes",
    "created_at",
  ],
  customer_profile_versions: [
    "id",
    "company_id",
    "version_number",
    "status",
    "profile_json",
    "change_summary",
    "source_ids_json",
    "activity_ids_json",
    "created_by",
    "created_at",
  ],
  signals: [
    "id",
    "company_id",
    "signal_type",
    "summary",
    "source_id",
    "source_url",
    "observed_date",
    "strength",
    "confidence",
    "adapt_relevance",
    "evidence_json",
    "created_at",
  ],
  activities: [
    "id",
    "target_type",
    "target_id",
    "actor",
    "action_type",
    "summary",
    "payload_json",
    "created_at",
  ],
  discovery_jobs: [
    "id",
    "industry",
    "location",
    "segment_id",
    "geography_id",
    "geography_text",
    "coverage_slice_id",
    "target_count",
    "scan_mode",
    "status",
    "company_count",
    "source_count",
    "summary",
    "created_at",
    "updated_at",
  ],
  scan_strategy_attempts: [
    "id",
    "discovery_job_id",
    "segment_id",
    "geography_id",
    "geography_text",
    "coverage_slice_id",
    "source_family",
    "industry",
    "location",
    "strategy_type",
    "query",
    "status",
    "result_count",
    "notes",
    "payload_json",
    "created_at",
  ],
  enrichment_requests: [
    "id",
    "company_id",
    "work_queue_id",
    "status",
    "request_kind",
    "summary",
    "created_at",
    "updated_at",
  ],
  work_queue: [
    "id",
    "kind",
    "target_type",
    "target_id",
    "segment_id",
    "segment",
    "priority",
    "status",
    "reason",
    "attempts",
    "next_run_after_at",
    "locked_by_run_id",
    "error",
    "context_json",
    "created_at",
    "updated_at",
  ],
  ranking_runs: [
    "id",
    "ranking_type",
    "status",
    "reason",
    "candidate_count",
    "ranked_count",
    "score_version",
    "parameters_json",
    "created_by",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
  ],
  ranking_items: [
    "id",
    "ranking_run_id",
    "company_id",
    "rank",
    "score",
    "reason",
    "score_json",
    "created_at",
  ],
  target_list_runs: [
    "id",
    "status",
    "reason",
    "candidate_count",
    "ranked_count",
    "score_version",
    "parameters_json",
    "created_by",
    "started_at",
    "completed_at",
    "created_at",
    "updated_at",
  ],
  target_list_items: [
    "id",
    "target_list_run_id",
    "company_id",
    "service_fit_assessment_id",
    "market_profile_version_id",
    "rank",
    "score",
    "reason",
    "best_offering_id",
    "best_offering_key",
    "best_offering_name",
    "best_variant_key",
    "why_now",
    "evidence_quality",
    "confidence",
    "caveats_json",
    "next_action",
    "flags_json",
    "score_json",
    "created_at",
  ],
  outreach_drafts: [
    "id",
    "company_id",
    "pitch_text",
    "status",
    "source_run_id",
    "created_at",
    "updated_at",
  ],
  company_segments: [
    "company_id",
    "segment_id",
    "confidence",
    "source",
    "created_at",
  ],
  target_geographies: [
    "id",
    "parent_id",
    "label",
    "kind",
    "canonical_key",
    "status",
    "created_at",
    "updated_at",
  ],
  coverage_slices: [
    "id",
    "segment_id",
    "geography_id",
    "geography_text",
    "source_family",
    "strategy_type",
    "status",
    "target_counts_json",
    "current_counts_json",
    "yield_metrics_json",
    "last_run_at",
    "next_run_after_at",
    "stalled_reason",
    "created_at",
    "updated_at",
  ],
  scheduler_settings: [
    "id",
    "enabled",
    "acquisition_enabled",
    "enrichment_enabled",
    "scoring_enabled",
    "outreach_enabled",
    "target_pool_size",
    "enriched_floor",
    "top_target_count",
    "per_role_concurrency_json",
    "cooldowns_json",
    "created_at",
    "updated_at",
  ],
  scheduler_runs: [
    "id",
    "run_type",
    "status",
    "selected_action",
    "skip_reason",
    "role_key",
    "local_request_id",
    "autopilot_run_id",
    "lock_key",
    "context_json",
    "result_json",
    "error",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
  ],
  scheduler_locks: [
    "lock_key",
    "run_id",
    "owner_id",
    "lease_expires_at",
    "acquired_at",
    "updated_at",
  ],
} as const;

type KindlingImportTable = keyof typeof KINDLING_IMPORT_TABLES;
type SqlImportValue = string | number | bigint | boolean | null | Uint8Array;

function sqlImportValue(value: unknown): SqlImportValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function sortTargetSegmentRows(rows: unknown[]) {
  const records = rows.filter((row) => row && typeof row === "object" && !Array.isArray(row)) as Record<string, unknown>[];
  const byId = new Map(records.map((row) => [String(row.id ?? ""), row]));
  const ordered: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (row: Record<string, unknown>) => {
    const id = String(row.id ?? "");
    if (!id || seen.has(id)) return;
    if (visiting.has(id)) {
      seen.add(id);
      ordered.push(row);
      return;
    }
    visiting.add(id);
    const parentId = String(row.parent_id ?? "");
    const parent = parentId ? byId.get(parentId) : null;
    if (parent) visit(parent);
    visiting.delete(id);
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(row);
  };
  for (const row of records) visit(row);
  return ordered;
}

function importRows(table: KindlingImportTable, rows: unknown[]): number {
  const columns = KINDLING_IMPORT_TABLES[table];
  if (!rows.length) return 0;
  const placeholders = columns.map((_, index) => `?${index + 1}`).join(", ");
  const statement = db.query(`
    INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders})
  `);
  let count = 0;
  const rowsToImport = table === "target_segments" ? sortTargetSegmentRows(rows) : rows;
  for (const raw of rowsToImport) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    statement.run(...columns.map((column) => sqlImportValue(row[column])));
    count += 1;
  }
  return count;
}

function importKindlingData(body: Record<string, unknown>) {
  const tables = body.tables && typeof body.tables === "object" && !Array.isArray(body.tables)
    ? body.tables as Record<string, unknown>
    : body;
  const counts: Record<string, number> = {};
  const order: KindlingImportTable[] = [
    "market_profiles",
    "market_profile_versions",
    "service_offerings",
    "target_segments",
    "target_geographies",
    "coverage_slices",
    "scheduler_settings",
    "scheduler_runs",
    "scheduler_locks",
    "companies",
    "company_segments",
    "discovery_jobs",
    "sources",
    "customer_profile_versions",
    "signals",
    "service_fit_assessments",
    "activities",
    "scan_strategy_attempts",
    "work_queue",
    "enrichment_requests",
    "ranking_runs",
    "ranking_items",
    "target_list_runs",
    "target_list_items",
    "outreach_drafts",
  ];
  const transaction = db.transaction(() => {
    for (const table of order) {
      const rows = Array.isArray(tables[table]) ? tables[table] as unknown[] : [];
      counts[table] = importRows(table, rows);
    }
  });
  transaction();
  return counts;
}

function mapDiscoveryJob(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    industry: String(row.industry),
    location: String(row.location),
    segmentId: row.segment_id ? String(row.segment_id) : null,
    geographyId: row.geography_id ? String(row.geography_id) : null,
    geographyText: String(row.geography_text || row.location || ""),
    coverageSliceId: row.coverage_slice_id ? String(row.coverage_slice_id) : null,
    targetCount: Number(row.target_count ?? 25),
    scanMode: String(row.scan_mode ?? "interactive"),
    status: String(row.status),
    companyCount: Number(row.company_count ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    summary: String(row.summary ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapStrategyAttempt(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    discoveryJobId: String(row.discovery_job_id),
    segmentId: row.segment_id ? String(row.segment_id) : null,
    geographyId: row.geography_id ? String(row.geography_id) : null,
    geographyText: String(row.geography_text || row.location || ""),
    coverageSliceId: row.coverage_slice_id ? String(row.coverage_slice_id) : null,
    sourceFamily: String(row.source_family ?? "web"),
    industry: String(row.industry),
    location: String(row.location),
    strategyType: String(row.strategy_type),
    query: String(row.query),
    status: String(row.status),
    resultCount: Number(row.result_count ?? 0),
    notes: String(row.notes ?? ""),
    payload: jsonParse<Record<string, unknown>>(row.payload_json, {}),
    createdAt: Number(row.created_at),
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

const defaultScoringOfferingTemplates = [
  { key: "ai_consulting", name: "AI consulting", variantKey: "", kind: "service_line" },
  { key: "wingman_implementations", name: "Wingman implementations", variantKey: "", kind: "service_line" },
  { key: "custom_wapps", name: "Custom WApps", variantKey: "", kind: "service_line" },
  { key: "training", name: "Training", variantKey: "", kind: "service_line" },
  { key: "scale", name: "Scale", variantKey: "scale", kind: "positioning_variant" },
  { key: "exit", name: "Exit", variantKey: "exit", kind: "positioning_variant" },
  { key: "succession", name: "Succession", variantKey: "succession", kind: "positioning_variant" },
  { key: "handover", name: "Handover", variantKey: "handover", kind: "positioning_variant" },
  { key: "maximizing_value", name: "Maximizing value", variantKey: "maximizing_value", kind: "positioning_variant" },
  { key: "reducing_owner_dependence", name: "Reducing owner dependence", variantKey: "reducing_owner_dependence", kind: "positioning_variant" },
] as const;

function primaryOfferingKeyFromTitle(title: string) {
  if (/^adapt\s+lumia\b/i.test(title)) return "adapt_lumia";
  return slugKey(title);
}

function slugKey(value: unknown) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "offering";
}

function readableName(value: unknown, fallback: string) {
  const name = String(value ?? "").trim();
  return name || fallback;
}

function valuesArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function primaryServiceOfferingFromProfile(structured: Record<string, unknown>): ExtractedServiceOffering | null {
  const title = readableName(
    structured.serviceOfferingName
      ?? structured.offeringName
      ?? structured.title
      ?? structured.name,
    "",
  );
  const services = valuesArray(structured.services);
  if (!title || services.length === 0) return null;
  return {
    key: slugKey(structured.serviceOfferingKey ?? structured.offeringKey ?? primaryOfferingKeyFromTitle(title)),
    name: title,
    variantKey: "",
    structured: {
      ...structured,
      kind: "primary_service_offering",
      source: "market_profile_structured",
      scoringUnit: "company_to_primary_offer",
      services,
    },
    status: "active",
  };
}

type ExtractedServiceOffering = {
  key: string;
  name: string;
  variantKey: string;
  structured: Record<string, unknown>;
  status: "active" | "inactive";
};

function addExtractedOffering(
  offerings: Map<string, ExtractedServiceOffering>,
  input: { key: string; name: string; variantKey?: string; structured?: Record<string, unknown>; status?: unknown },
) {
  const key = slugKey(input.key);
  const variantKey = input.variantKey ? slugKey(input.variantKey) : "";
  const mapKey = `${key}:${variantKey}`;
  if (offerings.has(mapKey)) return;
  const status = String(input.status ?? "active").toLowerCase() === "inactive" ? "inactive" : "active";
  offerings.set(mapKey, {
    key,
    name: readableName(input.name, key.replace(/_/g, " ")),
    variantKey,
    structured: input.structured ?? {},
    status,
  });
}

function addOfferingValue(
  offerings: Map<string, ExtractedServiceOffering>,
  value: unknown,
  fallbackKind: "service_line" | "positioning_variant",
) {
  if (typeof value === "string") {
    const key = slugKey(value);
    addExtractedOffering(offerings, {
      key,
      name: value,
      variantKey: fallbackKind === "positioning_variant" ? key : "",
      structured: { kind: fallbackKind, source: "market_profile_text", value },
    });
    return;
  }
  const record = objectRecord(value);
  if (!Object.keys(record).length) return;
  const name = readableName(record.name ?? record.label ?? record.title, "");
  const key = slugKey(record.key ?? record.serviceKey ?? (name || record.id));
  const variantKey = fallbackKind === "positioning_variant"
    ? slugKey(record.variantKey ?? record.key ?? name)
    : (record.variantKey ? slugKey(record.variantKey) : "");
  addExtractedOffering(offerings, {
    key,
    name: name || key.replace(/_/g, " "),
    variantKey,
    structured: { ...record, kind: fallbackKind, source: "market_profile_structured" },
    status: record.status,
  });

  for (const variant of valuesArray(record.variants)) {
    const variantRecord = objectRecord(variant);
    const variantName = typeof variant === "string"
      ? variant
      : readableName(variantRecord.name ?? variantRecord.label ?? variantRecord.title, "");
    const extractedVariantKey = slugKey(variantRecord.variantKey ?? variantRecord.key ?? variantName);
    addExtractedOffering(offerings, {
      key: `${key}_${extractedVariantKey}`,
      name: `${name || key.replace(/_/g, " ")}: ${variantName || extractedVariantKey.replace(/_/g, " ")}`,
      variantKey: extractedVariantKey,
      structured: {
        ...variantRecord,
        kind: "service_variant",
        source: "market_profile_structured",
        serviceKey: key,
      },
      status: variantRecord.status,
    });
  }
}

function extractServiceOfferingsFromProfile(structured: Record<string, unknown>): ExtractedServiceOffering[] {
  const primaryOffering = primaryServiceOfferingFromProfile(structured);
  if (primaryOffering) return [primaryOffering];

  const offerings = new Map<string, ExtractedServiceOffering>();
  for (const key of ["services", "serviceLines", "serviceOfferings", "offerings"]) {
    for (const value of valuesArray(structured[key])) addOfferingValue(offerings, value, "service_line");
  }
  for (const key of ["variants", "serviceVariants", "positioningVariants", "scoringVariants"]) {
    for (const value of valuesArray(structured[key])) addOfferingValue(offerings, value, "positioning_variant");
  }
  if (offerings.size === 0) {
    for (const template of defaultScoringOfferingTemplates) {
      addExtractedOffering(offerings, {
        key: template.key,
        name: template.name,
        variantKey: template.variantKey,
        structured: { kind: template.kind, source: "default_scoring_catalog" },
      });
    }
  }
  return [...offerings.values()];
}

function serviceOfferingId(marketProfileVersionId: string, key: string, variantKey: string) {
  return `service_offering:${marketProfileVersionId}:${key}:${variantKey || "base"}`;
}

function replaceServiceOfferingsForMarketProfileVersion(marketProfileVersionId: string, structured: Record<string, unknown>, now = Date.now()) {
  const offerings = extractServiceOfferingsFromProfile(structured);
  db.query("UPDATE service_offerings SET status = 'inactive', updated_at = ?1 WHERE market_profile_version_id = ?2")
    .run(now, marketProfileVersionId);
  const upsert = db.query(`
    INSERT INTO service_offerings(
      id, market_profile_version_id, key, name, variant_key, structured_json, status, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      variant_key = excluded.variant_key,
      structured_json = excluded.structured_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  for (const offering of offerings) {
    upsert.run(
      serviceOfferingId(marketProfileVersionId, offering.key, offering.variantKey),
      marketProfileVersionId,
      offering.key,
      offering.name,
      offering.variantKey,
      JSON.stringify(offering.structured),
      offering.status,
      now,
    );
  }
  return offerings;
}

function mapServiceOffering(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    marketProfileVersionId: String(row.market_profile_version_id),
    key: String(row.key),
    name: String(row.name),
    variantKey: String(row.variant_key ?? ""),
    structured: jsonParse<Record<string, unknown>>(row.structured_json, {}),
    status: String(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function getCurrentMarketProfile() {
  const profile = db.query("SELECT * FROM market_profiles ORDER BY created_at ASC LIMIT 1").get() as Record<string, unknown> | null;
  if (!profile) return null;
  const version = profile.current_version_id
    ? db.query("SELECT * FROM market_profile_versions WHERE id = ?1").get(String(profile.current_version_id)) as Record<string, unknown> | null
    : null;
  const offerings = version
    ? db.query("SELECT * FROM service_offerings WHERE market_profile_version_id = ?1 ORDER BY key ASC, variant_key ASC")
      .all(String(version.id)) as Record<string, unknown>[]
    : [];
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
      serviceOfferings: offerings.map(mapServiceOffering),
      createdAt: Number(version.created_at),
    } : null,
    createdAt: Number(profile.created_at),
    updatedAt: Number(profile.updated_at),
  };
}

function mapMarketProfileVersionForContext(version: Record<string, unknown> | null) {
  if (!version) return null;
  const offerings = db.query("SELECT * FROM service_offerings WHERE market_profile_version_id = ?1 ORDER BY key ASC, variant_key ASC")
    .all(String(version.id)) as Record<string, unknown>[];
  return {
    id: String(version.id),
    versionNumber: Number(version.version_number),
    structured: jsonParse<Record<string, unknown>>(version.structured_json, {}),
    summary: String(version.summary),
    rationale: String(version.rationale),
    sourceReferences: jsonParse<string[]>(version.source_references_json, []),
    serviceOfferings: offerings.map(mapServiceOffering),
    createdAt: Number(version.created_at),
  };
}

function listActiveScoringOfferings() {
  const profile = getCurrentMarketProfile();
  if (!profile?.currentVersionId || !profile.version) return { profile, offerings: [] };
  const existingCount = Number((db.query("SELECT COUNT(*) AS count FROM service_offerings WHERE market_profile_version_id = ?1")
    .get(profile.currentVersionId) as { count: number } | null)?.count ?? 0);
  if (!existingCount) {
    replaceServiceOfferingsForMarketProfileVersion(profile.currentVersionId, profile.version.structured);
  }
  const rows = db.query(`
    SELECT *
    FROM service_offerings
    WHERE market_profile_version_id = ?1
      AND status = 'active'
    ORDER BY
      CASE WHEN variant_key = '' THEN 0 ELSE 1 END,
      key ASC,
      variant_key ASC
  `).all(profile.currentVersionId) as Record<string, unknown>[];
  return { profile: getCurrentMarketProfile(), offerings: rows.map(mapServiceOffering) };
}

function serviceFitAssessmentId(companyId: string, serviceOfferingId: string, marketProfileVersionId: string, sourceRunId: string) {
  return `service_fit_assessment:${companyId}:${serviceOfferingId}:${marketProfileVersionId}:${sourceRunId}`;
}

function jsonCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "object") return [value];
  return [value];
}

function normalizeAssessmentScore(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, parsed));
}

function normalizeAssessmentBand(value: unknown, score: number) {
  const band = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (band) return band;
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function serviceFitAssessmentPayload(body: Record<string, unknown>) {
  const result = objectRecord(body.result);
  const assessment = objectRecord(body.assessment);
  const source = Object.keys(assessment).length ? assessment : result;
  return {
    outputKind: String(source.outputKind ?? "service_fit_assessment"),
    companyId: String(source.companyId ?? body.companyId ?? "").trim(),
    serviceOfferingId: String(source.serviceOfferingId ?? body.serviceOfferingId ?? "").trim(),
    marketProfileVersionId: String(source.marketProfileVersionId ?? body.marketProfileVersionId ?? "").trim(),
    variantKey: String(source.variantKey ?? body.variantKey ?? "").trim(),
    score: source.score ?? body.score,
    band: source.band ?? body.band,
    confidence: source.confidence ?? body.confidence,
    drivers: source.drivers ?? source.scoreDrivers ?? body.drivers,
    fitExplanation: source.fitExplanation ?? source.explanation ?? body.fitExplanation ?? body.explanation,
    evidence: source.evidence ?? body.evidence,
    caveats: source.caveats ?? source.warnings ?? body.caveats,
    recommendedAction: source.recommendedAction ?? source.nextAction ?? source.recommendation ?? body.recommendedAction ?? body.nextAction,
    raw: source,
  };
}

function serviceFitIdentityFromRun(run: Record<string, unknown>) {
  const trigger = jsonParse<Record<string, unknown>>(run.trigger_payload_json, {});
  const body = objectRecord(trigger.body);
  const input = objectRecord(body.input);
  const localContext = objectRecord(input.localContext);
  const serviceOffering = objectRecord(localContext.serviceOffering);
  const marketProfileVersion = objectRecord(localContext.marketProfileVersion);
  return {
    companyId: String(input.companyId ?? localContext.companyId ?? "").trim(),
    serviceOfferingId: String(input.serviceOfferingId ?? localContext.serviceOfferingId ?? serviceOffering.id ?? "").trim(),
    marketProfileVersionId: String(
      input.marketProfileVersionId
        ?? localContext.marketProfileVersionId
        ?? serviceOffering.marketProfileVersionId
        ?? marketProfileVersion.id
        ?? "",
    ).trim(),
  };
}

function serviceFitAllowedOfferingIdsFromRun(run: Record<string, unknown>) {
  const trigger = jsonParse<Record<string, unknown>>(run.trigger_payload_json, {});
  const body = objectRecord(trigger.body);
  const input = objectRecord(body.input);
  const localContext = objectRecord(input.localContext);
  const offerings = Array.isArray(localContext.serviceOfferings) ? localContext.serviceOfferings : [];
  return new Set(offerings
    .map((offering) => String(objectRecord(offering).id ?? "").trim())
    .filter(Boolean));
}

function validateServiceFitRunIdentity(
  payload: ReturnType<typeof serviceFitAssessmentPayload>,
  marketProfileVersionId: string,
  run: Record<string, unknown>,
) {
  const expected = serviceFitIdentityFromRun(run);
  if (expected.companyId && payload.companyId !== expected.companyId) {
    return { ok: false as const, error: "companyId does not match service assessment run" };
  }
  if (expected.serviceOfferingId && payload.serviceOfferingId !== expected.serviceOfferingId) {
    return { ok: false as const, error: "serviceOfferingId does not match service assessment run" };
  }
  const allowedOfferingIds = serviceFitAllowedOfferingIdsFromRun(run);
  if (!expected.serviceOfferingId && allowedOfferingIds.size && !allowedOfferingIds.has(payload.serviceOfferingId)) {
    return { ok: false as const, error: "serviceOfferingId is not in service assessment run offering set" };
  }
  if (expected.marketProfileVersionId && marketProfileVersionId !== expected.marketProfileVersionId) {
    return { ok: false as const, error: "marketProfileVersionId does not match service assessment run" };
  }
  return { ok: true as const };
}

function persistServiceFitAssessment(input: { body: Record<string, unknown>; run: Record<string, unknown>; now?: number }) {
  const now = input.now ?? Date.now();
  const payload = serviceFitAssessmentPayload(input.body);
  if (!payload.companyId) return { ok: false as const, error: "companyId is required" };
  if (!payload.serviceOfferingId) return { ok: false as const, error: "serviceOfferingId is required" };
  const score = normalizeAssessmentScore(payload.score);
  if (score === null) return { ok: false as const, error: "score is required" };

  const company = db.query("SELECT * FROM companies WHERE id = ?1").get(payload.companyId) as Record<string, unknown> | null;
  if (!company) return { ok: false as const, error: "company not found" };
  const offering = db.query("SELECT * FROM service_offerings WHERE id = ?1").get(payload.serviceOfferingId) as Record<string, unknown> | null;
  if (!offering) return { ok: false as const, error: "service offering not found" };
  const marketProfileVersionId = payload.marketProfileVersionId || String(offering.market_profile_version_id);
  if (marketProfileVersionId !== String(offering.market_profile_version_id)) {
    return { ok: false as const, error: "service offering does not belong to market profile version" };
  }
  const runIdentity = validateServiceFitRunIdentity(payload, marketProfileVersionId, input.run);
  if (!runIdentity.ok) return runIdentity;

  const sourceRunId = String(input.run.id);
  const assessmentId = serviceFitAssessmentId(payload.companyId, payload.serviceOfferingId, marketProfileVersionId, sourceRunId);
  const existing = db.query(`
    SELECT id
    FROM service_fit_assessments
    WHERE company_id = ?1
      AND service_offering_id = ?2
      AND market_profile_version_id = ?3
      AND source_run_id = ?4
  `).get(payload.companyId, payload.serviceOfferingId, marketProfileVersionId, sourceRunId) as Record<string, unknown> | null;
  const band = normalizeAssessmentBand(payload.band, score);
  const confidence = clampConfidence(payload.confidence, 0);
  const drivers = jsonCollection(payload.drivers);
  const evidence = jsonCollection(payload.evidence);
  const caveats = jsonCollection(payload.caveats);
  const fitExplanation = String(payload.fitExplanation ?? "").trim();
  const recommendedAction = String(payload.recommendedAction ?? "").trim();
  const assessmentJson = {
    ...objectRecord(payload.raw),
    outputKind: "service_fit_assessment",
    companyId: payload.companyId,
    serviceOfferingId: payload.serviceOfferingId,
    marketProfileVersionId,
    variantKey: payload.variantKey || String(offering.variant_key ?? ""),
    score,
    band,
    confidence,
    drivers,
    fitExplanation,
    evidence,
    caveats,
    recommendedAction,
    sourceRunId,
  };

  db.query(`
    INSERT INTO service_fit_assessments(
      id, company_id, service_offering_id, market_profile_version_id, score, band, confidence,
      drivers_json, fit_explanation, evidence_json, caveats_json, recommended_action,
      source_run_id, assessment_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
    ON CONFLICT(company_id, service_offering_id, market_profile_version_id, source_run_id) DO UPDATE SET
      score = excluded.score,
      band = excluded.band,
      confidence = excluded.confidence,
      drivers_json = excluded.drivers_json,
      fit_explanation = excluded.fit_explanation,
      evidence_json = excluded.evidence_json,
      caveats_json = excluded.caveats_json,
      recommended_action = excluded.recommended_action,
      assessment_json = excluded.assessment_json,
      updated_at = excluded.updated_at
  `).run(
    assessmentId,
    payload.companyId,
    payload.serviceOfferingId,
    marketProfileVersionId,
    score,
    band,
    confidence,
    JSON.stringify(drivers),
    fitExplanation,
    JSON.stringify(evidence),
    JSON.stringify(caveats),
    recommendedAction,
    sourceRunId,
    JSON.stringify(assessmentJson),
    now,
  );
  db.query("UPDATE companies SET data_ring = 'scored', updated_at = ?1 WHERE id = ?2").run(now, payload.companyId);
  db.query("UPDATE work_queue SET status = 'complete', error = '', updated_at = ?1 WHERE id = ?2 AND kind = 'service_fit_assessment'")
    .run(now, String(input.run.local_request_id ?? ""));
  if (!existing) {
    recordActivity("company", payload.companyId, "pipeline", "service_fit_assessed", fitExplanation || `Service fit scored ${score}`, {
      requestId: String(input.run.local_request_id ?? ""),
      runId: sourceRunId,
      serviceOfferingId: payload.serviceOfferingId,
      marketProfileVersionId,
      score,
      band,
    });
  }

  const row = db.query(`
    SELECT sfa.*, so.key AS offering_key, so.name AS offering_name, so.variant_key AS offering_variant_key
    FROM service_fit_assessments sfa
    JOIN service_offerings so ON so.id = sfa.service_offering_id
    WHERE sfa.company_id = ?1
      AND sfa.service_offering_id = ?2
      AND sfa.market_profile_version_id = ?3
      AND sfa.source_run_id = ?4
  `).get(payload.companyId, payload.serviceOfferingId, marketProfileVersionId, sourceRunId) as Record<string, unknown>;
  return { ok: true as const, assessment: mapServiceFitAssessment(row) };
}

function serviceFitAssessmentBodies(body: Record<string, unknown>) {
  const result = objectRecord(body.result);
  const directAssessments = Array.isArray(body.assessments) ? body.assessments : [];
  const resultAssessments = Array.isArray(result.assessments) ? result.assessments : [];
  const assessments = (directAssessments.length ? directAssessments : resultAssessments)
    .map(objectRecord)
    .filter((assessment) => Object.keys(assessment).length);
  if (!assessments.length) return [body];
  return assessments.map((assessment) => ({
    ...body,
    result: {
      ...assessment,
      outputKind: String(assessment.outputKind ?? "service_fit_assessment"),
      companyId: String(assessment.companyId ?? result.companyId ?? body.companyId ?? ""),
      marketProfileVersionId: String(assessment.marketProfileVersionId ?? result.marketProfileVersionId ?? body.marketProfileVersionId ?? ""),
    },
  }));
}

function persistServiceFitAssessmentBatch(input: { body: Record<string, unknown>; run: Record<string, unknown>; now?: number }) {
  const persisted = [];
  for (const body of serviceFitAssessmentBodies(input.body)) {
    const result = persistServiceFitAssessment({ body, run: input.run, now: input.now });
    if (!result.ok) return result;
    persisted.push(result.assessment);
  }
  if (persisted.length) {
    runTopTargetAggregation({
      reason: `Service-fit scoring updated ${persisted.length} assessment${persisted.length === 1 ? "" : "s"}`,
      limit: null,
      createdBy: "pipeline",
    });
  }
  return {
    ok: true as const,
    assessment: persisted[0],
    assessments: persisted,
  };
}

function listServiceFitAssessmentsForCompany(companyId: string) {
  const rows = db.query(`
    SELECT sfa.*, so.key AS offering_key, so.name AS offering_name, so.variant_key AS offering_variant_key
    FROM service_fit_assessments sfa
    LEFT JOIN service_offerings so ON so.id = sfa.service_offering_id
    WHERE sfa.company_id = ?1
    ORDER BY sfa.updated_at DESC, sfa.score DESC
  `).all(companyId) as Record<string, unknown>[];
  return rows.map(mapServiceFitAssessment);
}

function recordActivity(targetType: string, targetId: string, actor: string, actionType: string, summary: string, payload: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  db.query(`
    INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).run(id, targetType, targetId, actor, actionType, summary, JSON.stringify(payload), Date.now());
  return id;
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

function listScanStrategyHistory(industry: string, location: string, limit = 30, includePlanned = false) {
  const rows = db.query(`
    SELECT sat.*
    FROM scan_strategy_attempts sat
    WHERE (lower(sat.industry) = lower(?1)
       OR lower(sat.location) = lower(?2)
       OR lower(sat.industry || ' ' || sat.location) LIKE lower(?3))
      AND (?5 = 1 OR sat.status != 'planned')
    ORDER BY sat.created_at DESC
    LIMIT ?4
  `).all(industry, location, `%${industry} ${location}%`, limit, includePlanned ? 1 : 0) as Record<string, unknown>[];
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

function listCoverageSlicesForScan(industry: string, location: string, limit = 25) {
  const rows = db.query(`
    SELECT cs.*, ts.label AS segment_label, tg.label AS geography_label
    FROM coverage_slices cs
    LEFT JOIN target_segments ts ON ts.id = cs.segment_id
    LEFT JOIN target_geographies tg ON tg.id = cs.geography_id
    WHERE lower(cs.geography_text) = lower(?2)
       OR lower(COALESCE(ts.label, '')) = lower(?1)
       OR lower(cs.strategy_type) = lower(?1)
    ORDER BY COALESCE(cs.last_run_at, cs.updated_at) DESC, cs.strategy_type ASC
    LIMIT ?3
  `).all(industry, location, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    segmentId: row.segment_id ? String(row.segment_id) : null,
    segmentLabel: row.segment_label ? String(row.segment_label) : "",
    geographyId: row.geography_id ? String(row.geography_id) : null,
    geographyText: String(row.geography_text ?? row.geography_label ?? ""),
    sourceFamily: String(row.source_family ?? ""),
    strategyType: String(row.strategy_type ?? ""),
    status: String(row.status ?? "active"),
    targetCounts: jsonParse<Record<string, unknown>>(row.target_counts_json, {}),
    currentCounts: jsonParse<Record<string, unknown>>(row.current_counts_json, {}),
    yieldMetrics: jsonParse<Record<string, unknown>>(row.yield_metrics_json, {}),
    lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
    nextRunAfterAt: row.next_run_after_at ? Number(row.next_run_after_at) : null,
    stalledReason: row.stalled_reason ? String(row.stalled_reason) : "",
  }));
}

type CoverageCompanyCounts = {
  found: number;
  unique: number;
  duplicate: number;
  weakSource: number;
  enriched: number;
  scored: number;
  outreachReady: number;
  parked: number;
  stale: number;
};

function emptyCoverageCompanyCounts(): CoverageCompanyCounts {
  return {
    found: 0,
    unique: 0,
    duplicate: 0,
    weakSource: 0,
    enriched: 0,
    scored: 0,
    outreachReady: 0,
    parked: 0,
    stale: 0,
  };
}

function coverageCompanyWhere(filters: { segmentId?: string | null; geographyText?: string | null }) {
  const clauses: string[] = [];
  const values: string[] = [];
  const segmentId = String(filters.segmentId ?? "").trim();
  const geographyText = String(filters.geographyText ?? "").trim();
  if (segmentId) {
    values.push(segmentId);
    clauses.push(`EXISTS (
      SELECT 1
      FROM company_segments cs
      WHERE cs.company_id = c.id
        AND cs.segment_id = ?${values.length}
    )`);
  }
  if (geographyText) {
    values.push(geographyText);
    clauses.push(`lower(COALESCE(c.location, '')) = lower(?${values.length})`);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function countCoverageCompanies(filters: { segmentId?: string | null; geographyText?: string | null } = {}): CoverageCompanyCounts {
  const { where, values } = coverageCompanyWhere(filters);
  const row = db.query(`
    SELECT
      COUNT(*) AS found_count,
      SUM(CASE WHEN c.duplicate_status = 'unique' THEN 1 ELSE 0 END) AS unique_count,
      SUM(CASE WHEN c.duplicate_status IN ('possible_duplicate', 'duplicate') THEN 1 ELSE 0 END) AS duplicate_count,
      SUM(CASE
        WHEN NOT EXISTS (SELECT 1 FROM sources s WHERE s.company_id = c.id) THEN 1
        WHEN COALESCE((SELECT MAX(s.confidence) FROM sources s WHERE s.company_id = c.id), 0) < 0.5 THEN 1
        ELSE 0
      END) AS weak_source_count,
      SUM(CASE
        WHEN c.enrichment_status = 'complete'
          OR c.data_ring IN ('enhanced', 'agent', 'enriched', 'ranked', 'scored', 'outreach_ready', 'outreach', 'contacted')
        THEN 1 ELSE 0
      END) AS enriched_count,
      SUM(CASE
        WHEN EXISTS (SELECT 1 FROM service_fit_assessments sfa WHERE sfa.company_id = c.id)
        THEN 1 ELSE 0
      END) AS scored_count,
      SUM(CASE
        WHEN c.data_ring IN ('outreach_ready', 'outreach', 'contacted')
          OR EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = c.id)
        THEN 1 ELSE 0
      END) AS outreach_ready_count,
      SUM(CASE WHEN c.data_ring = 'parked' THEN 1 ELSE 0 END) AS parked_count,
      SUM(CASE WHEN c.data_ring = 'stale' THEN 1 ELSE 0 END) AS stale_count
    FROM companies c
    ${where}
  `).get(...values) as Record<string, unknown> | null;
  return {
    found: Number(row?.found_count ?? 0),
    unique: Number(row?.unique_count ?? 0),
    duplicate: Number(row?.duplicate_count ?? 0),
    weakSource: Number(row?.weak_source_count ?? 0),
    enriched: Number(row?.enriched_count ?? 0),
    scored: Number(row?.scored_count ?? 0),
    outreachReady: Number(row?.outreach_ready_count ?? 0),
    parked: Number(row?.parked_count ?? 0),
    stale: Number(row?.stale_count ?? 0),
  };
}

function addCoverageCounts(target: CoverageCompanyCounts, source: CoverageCompanyCounts) {
  target.found += source.found;
  target.unique += source.unique;
  target.duplicate += source.duplicate;
  target.weakSource += source.weakSource;
  target.enriched += source.enriched;
  target.scored += source.scored;
  target.outreachReady += source.outreachReady;
  target.parked += source.parked;
  target.stale += source.stale;
}

function coverageAttemptStats(filters: { coverageSliceId?: string; segmentId?: string | null; geographyText?: string | null } = {}) {
  const clauses = ["status != 'planned'"];
  const values: string[] = [];
  if (filters.coverageSliceId) {
    values.push(filters.coverageSliceId);
    clauses.push(`coverage_slice_id = ?${values.length}`);
  }
  if (filters.segmentId) {
    values.push(filters.segmentId);
    clauses.push(`segment_id = ?${values.length}`);
  }
  if (filters.geographyText) {
    values.push(filters.geographyText);
    clauses.push(`lower(geography_text) = lower(?${values.length})`);
  }
  const row = db.query(`
    SELECT
      COUNT(*) AS executed_attempts,
      COALESCE(SUM(result_count), 0) AS result_count,
      MAX(created_at) AS last_run_at
    FROM scan_strategy_attempts
    WHERE ${clauses.join(" AND ")}
  `).get(...values) as Record<string, unknown> | null;
  return {
    executedAttempts: Number(row?.executed_attempts ?? 0),
    resultCount: Number(row?.result_count ?? 0),
    lastRunAt: row?.last_run_at ? Number(row.last_run_at) : null,
  };
}

function recommendedScanStrategies(limit = 100) {
  const runs = db.query(`
    SELECT id, local_request_id, result_payload_json, updated_at
    FROM kindling_pipeline_runs
    WHERE role_key = 'scan_target_list'
      AND COALESCE(result_payload_json, '') != ''
    ORDER BY updated_at DESC
    LIMIT 50
  `).all() as Record<string, unknown>[];
  const recommendations: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    const payload = jsonParse<Record<string, unknown>>(run.result_payload_json, {});
    const result = objectRecord(payload.result);
    const planned = [
      ...(Array.isArray(result.plannedNextStrategies) ? result.plannedNextStrategies as Record<string, unknown>[] : []),
      ...(Array.isArray(result.searchSlices) ? (result.searchSlices as Record<string, unknown>[]).filter((strategy) => String(strategy.status ?? "") === "planned") : []),
    ];
    planned.forEach((strategy, index) => {
      if (recommendations.length >= limit) return;
      const strategyType = String(strategy.strategyType ?? strategy.strategy ?? "search");
      recommendations.push({
        id: `recommended-${String(run.id)}-${index}`,
        discoveryJobId: String(run.local_request_id),
        segmentId: String(strategy.segmentId ?? strategy.targetSegmentId ?? "").trim() || null,
        geographyText: String(strategy.geographyText ?? strategy.location ?? result.location ?? "").trim(),
        sourceFamily: normalizeSourceFamily(strategy.sourceFamily ?? strategy.source_family, strategyType),
        strategyType,
        query: String(strategy.query ?? ""),
        status: String(strategy.status ?? "planned") || "planned",
        resultCount: Number(strategy.resultCount ?? strategy.companiesFound ?? 0),
        notes: String(strategy.notes ?? ""),
        executed: false,
        recommended: true,
        createdAt: Number(run.updated_at ?? 0),
      });
    });
  }
  return recommendations;
}

function mapCoverageSlice(row: Record<string, unknown>, recommendations: Array<Record<string, unknown>> = []) {
  const segmentId = row.segment_id ? String(row.segment_id) : null;
  const geographyText = String(row.geography_text ?? row.geography_label ?? "");
  const companyCounts = countCoverageCompanies({ segmentId, geographyText });
  const attempts = coverageAttemptStats({ coverageSliceId: String(row.id) });
  const matchingRecommendations = recommendations.filter((recommendation) => {
    const recommendationSegmentId = recommendation.segmentId ? String(recommendation.segmentId) : null;
    const recommendationGeography = String(recommendation.geographyText ?? "");
    const recommendationStrategy = String(recommendation.strategyType ?? "");
    return (!segmentId || !recommendationSegmentId || recommendationSegmentId === segmentId)
      && (!geographyText || !recommendationGeography || recommendationGeography.toLowerCase() === geographyText.toLowerCase())
      && recommendationStrategy.toLowerCase() === String(row.strategy_type ?? "").toLowerCase();
  });
  return {
    id: String(row.id),
    segmentId,
    segmentLabel: row.segment_label ? String(row.segment_label) : "",
    geographyId: row.geography_id ? String(row.geography_id) : null,
    geographyText,
    geographyLabel: row.geography_label ? String(row.geography_label) : "",
    sourceFamily: String(row.source_family ?? ""),
    strategyType: String(row.strategy_type ?? ""),
    status: String(row.status ?? "active"),
    targetCounts: jsonParse<Record<string, unknown>>(row.target_counts_json, {}),
    storedCounts: jsonParse<Record<string, unknown>>(row.current_counts_json, {}),
    currentCounts: companyCounts,
    yieldMetrics: jsonParse<Record<string, unknown>>(row.yield_metrics_json, {}),
    attempts: {
      executed: attempts.executedAttempts,
      resultCount: attempts.resultCount,
      planned: 0,
      recommended: matchingRecommendations.length,
    },
    recommendations: matchingRecommendations,
    lastRunAt: row.last_run_at ? Number(row.last_run_at) : attempts.lastRunAt,
    nextRunAfterAt: row.next_run_after_at ? Number(row.next_run_after_at) : null,
    stalledReason: row.stalled_reason ? String(row.stalled_reason) : "",
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function buildCoverageSummary() {
  const recommendations = recommendedScanStrategies(100);
  const rows = db.query(`
    SELECT cs.*, ts.label AS segment_label, tg.label AS geography_label
    FROM coverage_slices cs
    LEFT JOIN target_segments ts ON ts.id = cs.segment_id
    LEFT JOIN target_geographies tg ON tg.id = cs.geography_id
    ORDER BY ts.priority ASC, COALESCE(tg.label, cs.geography_text) ASC, cs.source_family ASC, cs.strategy_type ASC
  `).all() as Record<string, unknown>[];
  const slices = rows.map((row) => mapCoverageSlice(row, recommendations));
  const bySegment = (db.query(`
    SELECT id, label, tier, priority, status
    FROM target_segments
    ORDER BY priority ASC, label ASC
  `).all() as Record<string, unknown>[]).map((segment) => {
    const segmentId = String(segment.id);
    const attempts = coverageAttemptStats({ segmentId });
    return {
      segmentId,
      segmentLabel: String(segment.label),
      tier: Number(segment.tier),
      priority: Number(segment.priority),
      status: String(segment.status),
      currentCounts: countCoverageCompanies({ segmentId }),
      attempts: {
        executed: attempts.executedAttempts,
        resultCount: attempts.resultCount,
        planned: 0,
        recommended: recommendations.filter((recommendation) => recommendation.segmentId === segmentId).length,
      },
    };
  });
  const geographyKeys = [...new Set([
    ...rows.map((row) => String(row.geography_text ?? "").trim()).filter(Boolean),
    ...(db.query("SELECT DISTINCT location FROM companies WHERE COALESCE(location, '') != '' ORDER BY location ASC").all() as Record<string, unknown>[])
      .map((row) => String(row.location ?? "").trim())
      .filter(Boolean),
  ])];
  const byGeography = geographyKeys.map((geographyText) => {
    const attempts = coverageAttemptStats({ geographyText });
    return {
      geographyText,
      currentCounts: countCoverageCompanies({ geographyText }),
      attempts: {
        executed: attempts.executedAttempts,
        resultCount: attempts.resultCount,
        planned: 0,
        recommended: recommendations.filter((recommendation) => String(recommendation.geographyText ?? "").toLowerCase() === geographyText.toLowerCase()).length,
      },
    };
  });
  const totals = countCoverageCompanies();
  const attemptTotals = coverageAttemptStats();
  return {
    totals,
    attempts: {
      executed: attemptTotals.executedAttempts,
      resultCount: attemptTotals.resultCount,
      planned: 0,
      recommended: recommendations.length,
    },
    slices,
    bySegment,
    byGeography,
    recommendations,
  };
}

function buildLightCoverageSummary(limit = 25) {
  const rows = db.query(`
    SELECT cs.*, ts.label AS segment_label, tg.label AS geography_label
    FROM coverage_slices cs
    LEFT JOIN target_segments ts ON ts.id = cs.segment_id
    LEFT JOIN target_geographies tg ON tg.id = cs.geography_id
    ORDER BY COALESCE(cs.next_run_after_at, 0) ASC, COALESCE(cs.last_run_at, 0) ASC, ts.priority ASC, COALESCE(tg.label, cs.geography_text) ASC
    LIMIT ?1
  `).all(limit) as Record<string, unknown>[];
  const attemptTotals = coverageAttemptStats();
  return {
    totals: emptyCoverageCompanyCounts(),
    attempts: {
      executed: attemptTotals.executedAttempts,
      resultCount: attemptTotals.resultCount,
      planned: 0,
      recommended: 0,
    },
    slices: rows.map((row) => ({
      id: String(row.id),
      segmentId: row.segment_id ? String(row.segment_id) : null,
      segmentLabel: row.segment_label ? String(row.segment_label) : "",
      geographyId: row.geography_id ? String(row.geography_id) : null,
      geographyText: String(row.geography_text ?? row.geography_label ?? ""),
      geographyLabel: row.geography_label ? String(row.geography_label) : "",
      sourceFamily: String(row.source_family ?? ""),
      strategyType: String(row.strategy_type ?? ""),
      status: String(row.status ?? "active"),
      targetCounts: jsonParse<Record<string, unknown>>(row.target_counts_json, {}),
      storedCounts: jsonParse<Record<string, unknown>>(row.current_counts_json, {}),
      currentCounts: jsonParse<Record<string, unknown>>(row.current_counts_json, {}),
      yieldMetrics: jsonParse<Record<string, unknown>>(row.yield_metrics_json, {}),
      attempts: {
        executed: 0,
        resultCount: 0,
        planned: 0,
        recommended: 0,
      },
      recommendations: [],
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
      nextRunAfterAt: row.next_run_after_at ? Number(row.next_run_after_at) : null,
      stalledReason: row.stalled_reason ? String(row.stalled_reason) : "",
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    })),
    bySegment: [],
    byGeography: [],
    recommendations: [],
    light: true,
  };
}

function buildScanContext(industry: string, location: string, targetCount: number) {
  linkLegacyCoverageForScan(industry, location);
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
    coverageSlices: listCoverageSlicesForScan(industry, location, 25),
    priorScanStrategies: listScanStrategyHistory(industry, location, 50),
    plannedNextStrategies: listScanStrategyHistory(industry, location, 50, true).filter((strategy) => strategy.status === "planned"),
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
  if (roleKey === "score_company_service_fit") {
    return {
      companyId: String(context.companyId ?? ""),
      companyName: String(context.companyName ?? ""),
      serviceOfferingId: String(context.serviceOfferingId ?? ""),
      marketProfileVersionId: String(context.marketProfileVersionId ?? ""),
    };
  }
  if (roleKey === "enrich_industry_segment") {
    const batchSize = Number(context.batchSize ?? 0);
    return {
      industry: String(context.industry ?? ""),
      batchId: String(context.batchId ?? ""),
      batchSize,
      batchLoop: {
        iteration: 1,
        index: 0,
        total: batchSize,
      },
    };
  }
  if (roleKey === "develop_service_offering") {
    return {
      history: Array.isArray(context.history) ? context.history : [],
    };
  }
  return {};
}

const INDUSTRY_ENRICHMENT_BATCH_LIMIT = 21;
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
  if (!settings.autopilotUrl) throw new Error("Autopilot URL is required");
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
        agent: SCHEDULED_PIPELINE_AGENT,
        model: scheduledPipelineModelForRole(input.roleKey),
        workingDirectory: SCHEDULED_PIPELINE_WORKING_DIRECTORY,
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
  return !authorization && !/^kindling-.+-stub$/.test(roleSlug);
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

function buildCompanyFilterQuery(filters: URLSearchParams | null = null) {
  const clauses: string[] = [];
  const values: string[] = [];
  const add = (column: string, value: string | null) => {
    if (!value) return;
    values.push(value);
    clauses.push(`${column} = ?${values.length}`);
  };
  add("industry", filters?.get("industry") || null);
  add("location", filters?.get("location") || null);
  const dataRing = filters?.get("dataRing") || null;
  if (dataRing) {
    const ringValues = companyDataRingFilterValues(dataRing);
    const placeholders = ringValues.map((value) => {
      values.push(value);
      return `?${values.length}`;
    });
    clauses.push(`data_ring IN (${placeholders.join(", ")})`);
  }
  add("duplicate_status", filters?.get("duplicateStatus") || null);
  add("enrichment_status", filters?.get("enrichmentStatus") || null);
  const query = String(filters?.get("q") || filters?.get("search") || "").trim();
  if (query) {
    values.push(`%${query.toLowerCase()}%`);
    clauses.push(`lower(name) LIKE ?${values.length}`);
  }
  if (filters?.get("hasWebsite") === "yes") clauses.push("website IS NOT NULL AND website != ''");
  if (filters?.get("hasWebsite") === "no") clauses.push("(website IS NULL OR website = '')");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, values };
}

function countCompanies(filters: URLSearchParams | null = null) {
  const { where, values } = buildCompanyFilterQuery(filters);
  const row = db.query(`SELECT COUNT(*) AS count FROM companies ${where}`).get(...values) as { count: number } | null;
  return Number(row?.count ?? 0);
}

function countEnrichedCompanies() {
  const row = db.query("SELECT COUNT(*) AS count FROM companies WHERE enrichment_status = 'complete'").get() as { count: number } | null;
  return Number(row?.count ?? 0);
}

function countServiceFitAssessments() {
  const row = db.query("SELECT COUNT(*) AS count FROM service_fit_assessments").get() as { count: number } | null;
  return Number(row?.count ?? 0);
}

function countScoredCompanies() {
  const row = db.query(`
    SELECT COUNT(DISTINCT company_id) AS count
    FROM service_fit_assessments
  `).get() as { count: number } | null;
  return Number(row?.count ?? 0);
}

function countOutreachReadyCompanies() {
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM companies c
    WHERE c.data_ring IN ('outreach_ready', 'outreach', 'contacted')
      OR EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = c.id)
  `).get() as { count: number } | null;
  return Number(row?.count ?? 0);
}

function workQueueCounts() {
  const rows = db.query("SELECT status, COUNT(*) AS count FROM work_queue GROUP BY status").all() as Record<string, unknown>[];
  const counts = { queued: 0, running: 0, complete: 0, failed: 0, cancelled: 0, active: 0, total: 0 };
  for (const row of rows) {
    const status = String(row.status) as keyof typeof counts;
    const count = Number(row.count ?? 0);
    if (status in counts) counts[status] = count;
    counts.total += count;
  }
  counts.active = counts.queued + counts.running + counts.failed;
  return counts;
}

function listCompanies(filters: URLSearchParams | null = null, options: { limit?: number; offset?: number; compact?: boolean } = {}) {
  const { where, values } = buildCompanyFilterQuery(filters);
  const limit = Math.max(1, Math.min(COMPANY_LIST_LIMIT, Math.floor(options.limit ?? COMPANY_LIST_LIMIT)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const rows = db.query(`
    SELECT *
    FROM companies
    ${where}
    ORDER BY updated_at DESC, lower(name) ASC
    LIMIT ?${values.length + 1}
    OFFSET ?${values.length + 2}
  `).all(...values, limit, offset) as Record<string, unknown>[];
  return rows.map(options.compact ? mapCompanyListItem : mapCompany);
}

function normaliseIndustryBatchLimit(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return INDUSTRY_ENRICHMENT_BATCH_LIMIT;
  return Math.min(parsed, INDUSTRY_ENRICHMENT_BATCH_LIMIT);
}

function listEnrichmentIndustries(filters: URLSearchParams | null = null) {
  const { limit, offset } = pagingFromParams(filters ?? new URLSearchParams());
  const rows = db.query(`
    SELECT
      COALESCE(NULLIF(TRIM(industry), ''), '(blank)') AS industry,
      SUM(CASE WHEN enrichment_status IN ('not_started', 'failed') THEN 1 ELSE 0 END) AS unprocessed_count,
      SUM(CASE WHEN enrichment_status = 'not_started' THEN 1 ELSE 0 END) AS not_started_count,
      SUM(CASE WHEN enrichment_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN enrichment_status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN enrichment_status = 'complete' THEN 1 ELSE 0 END) AS complete_count
    FROM companies
    GROUP BY COALESCE(NULLIF(TRIM(industry), ''), '(blank)')
    HAVING unprocessed_count > 0
    ORDER BY unprocessed_count DESC, industry ASC
    LIMIT ?1
    OFFSET ?2
  `).all(limit, offset) as Record<string, unknown>[];
  const total = db.query(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT COALESCE(NULLIF(TRIM(industry), ''), '(blank)') AS industry
      FROM companies
      GROUP BY COALESCE(NULLIF(TRIM(industry), ''), '(blank)')
      HAVING SUM(CASE WHEN enrichment_status IN ('not_started', 'failed') THEN 1 ELSE 0 END) > 0
    )
  `).get() as { count: number } | null;
  const industries = rows.map((row) => ({
    industry: String(row.industry ?? ""),
    unprocessedCount: Number(row.unprocessed_count ?? 0),
    notStartedCount: Number(row.not_started_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    queuedCount: Number(row.queued_count ?? 0),
    completeCount: Number(row.complete_count ?? 0),
  }));
  return {
    industries,
    total: Number(total?.count ?? 0),
    returned: industries.length,
    limit,
    offset,
  };
}

function listCompaniesForIndustryEnrichment(industry: string, limit: number) {
  const rows = db.query(`
    SELECT *
    FROM companies
    WHERE COALESCE(NULLIF(TRIM(industry), ''), '(blank)') = ?1
      AND enrichment_status IN ('not_started', 'failed')
    ORDER BY updated_at ASC, name ASC
    LIMIT ?2
  `).all(industry, limit) as Record<string, unknown>[];
  return rows.map(mapCompany);
}

function knownSourcesForCompany(companyId: string) {
  return (db.query(`
    SELECT source_type, url, summary, confidence, created_at
    FROM sources
    WHERE company_id = ?1
    ORDER BY confidence DESC, created_at DESC
    LIMIT 12
  `).all(companyId) as Record<string, unknown>[]).map((source) => ({
    type: String(source.source_type ?? ""),
    url: String(source.url ?? ""),
    summary: String(source.summary ?? ""),
    confidence: Number(source.confidence ?? 0),
    createdAt: Number(source.created_at ?? 0),
  }));
}

function buildServiceFitScoringContext(company: Record<string, unknown>, offeringsInput: Record<string, unknown>[], origin: string, webhookToken: string) {
  const companyId = String(company.id);
  const marketProfile = getCurrentMarketProfile();
  const offerings = offeringsInput.map(mapServiceOffering);
  const firstOffering = offeringsInput[0] ?? {};
  const offeringMarketProfileVersion = mapMarketProfileVersionForContext(
    db.query("SELECT * FROM market_profile_versions WHERE id = ?1")
      .get(String(firstOffering.market_profile_version_id ?? marketProfile?.currentVersionId ?? "")) as Record<string, unknown> | null,
  );
  const sources = (db.query("SELECT * FROM sources WHERE company_id = ?1 ORDER BY confidence DESC, created_at DESC").all(companyId) as Record<string, unknown>[])
    .map(mapSource);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const signals = (db.query("SELECT * FROM signals WHERE company_id = ?1 ORDER BY created_at DESC").all(companyId) as Record<string, unknown>[])
    .map(mapSignal)
    .map((signal) => ({
      ...signal,
      source: signal.sourceId ? sourceById.get(signal.sourceId) ?? null : null,
    }));
  const customerProfileVersions = (db.query(`
    SELECT *
    FROM customer_profile_versions
    WHERE company_id = ?1
    ORDER BY version_number DESC, created_at DESC
    LIMIT 5
  `).all(companyId) as Record<string, unknown>[]).map(mapCustomerProfileVersion);
  return {
    companyId,
    companyName: String(company.name),
    company: mapCompany(company),
    customerProfileVersions,
    activeCustomerProfileVersion: customerProfileVersions.find((version) => version.status === "active") ?? customerProfileVersions[0] ?? null,
    sources,
    knownSources: knownSourcesForCompany(companyId),
    signals,
    evidence: { sources, signals },
    segments: listCompanySegments(companyId),
    serviceOfferingId: offerings.length === 1 ? String(firstOffering.id ?? "") : "",
    serviceOffering: offerings[0] ?? null,
    serviceOfferings: offerings,
    marketProfileVersionId: String(firstOffering.market_profile_version_id ?? marketProfile?.currentVersionId ?? ""),
    marketProfile,
    marketProfileVersion: offeringMarketProfileVersion,
    scoringRubric: {
      dimensions: [
        "service_fit",
        "timing",
        "owner_dependence",
        "scale_pain",
        "succession_exit",
        "advisory_partner_value",
        "reachable_contact",
        "evidence_quality",
        "risk_or_compliance",
      ],
      scoreRange: { min: 0, max: 100 },
      bands: { high: "75-100", medium: "50-74", low: "0-49" },
    },
    writeApi: {
      url: `${origin}/api/kindling/pipeline-write/service-assessment`,
      token: webhookToken,
      authHeader: "x-kindling-pipeline-token",
    },
  };
}

function createServiceFitAssessmentQueueItem(input: {
  id: string;
  companyId: string;
  serviceOfferingId: string;
  marketProfileVersionId: string;
  reason: string;
  priority: number;
  context: Record<string, unknown>;
  now: number;
}) {
  db.query(`
    INSERT INTO work_queue(
      id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
      next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
    )
    VALUES (?1, 'service_fit_assessment', 'company_service_offering', ?2, NULL, '', ?3, 'queued', ?4, 0, ?5, NULL, '', ?6, ?5, ?5)
  `).run(
    input.id,
    `${input.companyId}:${input.serviceOfferingId}:${input.marketProfileVersionId}`,
    input.priority,
    input.reason,
    input.now,
    JSON.stringify(input.context),
  );
  return input.id;
}

function createServiceFitScoringRun(input: {
  company: Record<string, unknown>;
  origin: string;
  userPubkey: string;
  userNpub: string;
  reason?: string;
  priority?: number;
  now?: number;
}) {
  const activeScoring = listActiveScoringOfferings();
  const offeringRows = (activeScoring.offerings || [])
    .map((offering) => db.query("SELECT * FROM service_offerings WHERE id = ?1").get(String(offering.id)) as Record<string, unknown> | null)
    .filter(Boolean) as Record<string, unknown>[];
  if (!offeringRows.length) throw new Error("no active service offerings to score against");
  const marketProfileVersionId = String(activeScoring.profile?.currentVersionId ?? offeringRows[0]?.market_profile_version_id ?? "");
  const now = input.now ?? Date.now();
  const requestId = crypto.randomUUID();
  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const reason = input.reason || `Score ${String(input.company.name)} against all active Adapt service offerings`;
  const context = buildServiceFitScoringContext(input.company, offeringRows, input.origin, webhookToken);
  const queueId = createServiceFitAssessmentQueueItem({
    id: requestId,
    companyId: String(input.company.id),
    serviceOfferingId: "all",
    marketProfileVersionId,
    reason,
    priority: input.priority ?? 40,
    context,
    now,
  });
  const triggerRequest = buildKindlingTriggerRequest({
    roleKey: "score_company_service_fit",
    localRequestId: requestId,
    message: reason,
    context,
    webhookUrl: `${input.origin}/api/kindling/pipeline-webhook`,
    webhookToken,
    userPubkey: input.userPubkey,
    userNpub: input.userNpub,
  });
  const runId = createKindlingRun({ roleKey: "score_company_service_fit", localRequestId: requestId, triggerRequest, status: "queued" });
  return { runId, requestId, queueId, offeringCount: offeringRows.length, triggerRequest };
}

function scanJobInputFromRun(run: Record<string, unknown> | null, job: ReturnType<typeof mapDiscoveryJob>) {
  const trigger = jsonParse<Record<string, unknown>>(run?.trigger_payload_json, {});
  const body = objectRecord(trigger.body);
  const input = objectRecord(body.input);
  return {
    requestId: job.id,
    message: String(input.message ?? ""),
    industry: String(input.industry ?? job.industry),
    location: String(input.location ?? job.location),
    targetCount: Number(input.targetCount ?? job.targetCount),
    scanMode: String(input.scanMode ?? job.scanMode),
    pipelineRole: String(input.pipelineRole ?? input.roleKey ?? "scan_target_list"),
  };
}

async function fetchAutopilotPipelineRun(autopilotRunId: string) {
  if (!autopilotRunId) return null;
  const autopilotUrl = toServerAutopilotUrl(getAppSettings().autopilotUrl);
  const runUrl = new URL(`/api/pipelines/runs/${encodeURIComponent(autopilotRunId)}`, autopilotUrl);
  runUrl.searchParams.set("includePayload", "1");
  try {
    const authorization = buildServerNip98Authorization(runUrl.toString(), "GET", "");
    const res = await fetch(runUrl, {
      headers: authorization ? { authorization } : undefined,
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
    return objectRecord(payload?.run);
  } catch {
    return null;
  }
}

function industryBatchCompanyIdsFromRun(run: Record<string, unknown>) {
  const trigger = jsonParse<Record<string, unknown>>(run.trigger_payload_json, {});
  const body = objectRecord(trigger.body);
  const input = objectRecord(body.input);
  const context = objectRecord(input.localContext);
  const rawCompanies = Array.isArray(context.companies)
    ? context.companies
    : Array.isArray(input.companies)
      ? input.companies
      : [];
  return [...new Set(rawCompanies
    .map((company) => String(objectRecord(company).id ?? "").trim())
    .filter(Boolean))];
}

function industryBatchQueuedSummaries(batchId: string) {
  return [
    `Queued by automatic industry batch ${batchId}`,
    `Queued by industry batch ${batchId}`,
  ];
}

function countCompleteIndustryBatchCompanies(companyIds: string[]) {
  if (!companyIds.length) return 0;
  const placeholders = companyIds.map((_, index) => `?${index + 1}`).join(", ");
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM companies
    WHERE id IN (${placeholders})
      AND enrichment_status = 'complete'
  `).get(...companyIds) as { count: number } | null;
  return Number(row?.count ?? 0);
}

function finalizeIndustryEnrichmentBatch(run: Record<string, unknown>, terminalStatus: "complete" | "failed", reason: string, now = Date.now()) {
  const batchId = String(run.local_request_id ?? "");
  const summaries = industryBatchQueuedSummaries(batchId);
  const pendingRows = db.query(`
    SELECT id, company_id
    FROM enrichment_requests
    WHERE request_kind = 'industry_batch'
      AND status IN ('queued', 'running')
      AND summary IN (?1, ?2)
  `).all(...summaries) as Array<{ id: string; company_id: string }>;

  const pendingCompanyIds = [...new Set(pendingRows.map((row) => String(row.company_id)).filter(Boolean))];
  const cleanupReason = terminalStatus === "failed"
    ? reason
    : reason || "Pipeline completed without writing enrichment for this company";
  if (pendingRows.length) {
    const requestIds = pendingRows.map((row) => String(row.id));
    const requestPlaceholders = requestIds.map((_, index) => `?${index + 3}`).join(", ");
    db.query(`
      UPDATE enrichment_requests
      SET status = 'failed', summary = ?1, updated_at = ?2
      WHERE id IN (${requestPlaceholders})
    `).run(cleanupReason, now, ...requestIds);
    db.query(`
      UPDATE work_queue
      SET status = 'failed',
          error = ?1,
          next_run_after_at = ?2,
          locked_by_run_id = NULL,
          updated_at = ?2
      WHERE id IN (
        SELECT COALESCE(NULLIF(work_queue_id, ''), id)
        FROM enrichment_requests
        WHERE id IN (${requestPlaceholders})
      )
        AND status IN ('queued', 'running')
    `).run(cleanupReason, now, ...requestIds);
  }

  if (pendingCompanyIds.length) {
    const companyPlaceholders = pendingCompanyIds.map((_, index) => `?${index + 2}`).join(", ");
    db.query(`
      UPDATE companies
      SET enrichment_status = 'failed', updated_at = ?1
      WHERE id IN (${companyPlaceholders})
        AND enrichment_status IN ('queued', 'running')
    `).run(now, ...pendingCompanyIds);
  }

  const completeCount = countCompleteIndustryBatchCompanies(industryBatchCompanyIdsFromRun(run));
  const status = terminalStatus === "complete"
    ? pendingRows.length > 0 ? "partial_failed" : "complete"
    : completeCount > 0 ? "partial_failed" : "failed";
  const error = status === "complete" ? "" : cleanupReason;
  return { status, error, pendingCount: pendingRows.length, completeCount };
}

function markKindlingRunFailedFromAutopilot(run: Record<string, unknown>, error: string) {
  const now = Date.now();
  const roleKey = String(run.role_key ?? "");
  const requestId = String(run.local_request_id ?? "");
  const persistedCount = roleKey === "scan_target_list" ? matchingCompanyCountForJob(requestId) : 0;
  let localStatus = persistedCount > 0 ? "partial_failed" : "failed";
  let localError = error;
  if (roleKey === "enrich_industry_segment") {
    const finalized = finalizeIndustryEnrichmentBatch(run, "failed", error, now);
    localStatus = finalized.status;
    localError = finalized.error || error;
  }
  if (roleKey === "enrich_company") {
    failEnrichmentQueueForRequest(requestId, error, now);
  }
  db.query(`
    UPDATE kindling_pipeline_runs
    SET status = ?1, error = ?2, updated_at = ?3
    WHERE id = ?4
  `).run(localStatus, localError, now, String(run.id));

  if (roleKey === "scan_target_list") {
    const summary = persistedCount > 0
      ? `Scan stopped after writing ${persistedCount} companies: ${error}`
      : `Scan failed before writing companies: ${error}`;
    db.query(`
      UPDATE discovery_jobs
      SET status = ?1,
          company_count = MAX(company_count, ?2),
          summary = ?3,
          updated_at = ?4
      WHERE id = ?5
    `).run(localStatus, persistedCount, summary, now, requestId);
    updateSchedulerRunForRequest({
      requestId,
      status: "failed",
      result: {
        terminalStatus: localStatus,
        retryable: true,
        persistedCount,
        source: "autopilot_reconcile",
      },
      error,
      finish: true,
      releaseLock: true,
    });
  }
  if (roleKey === "enrich_company" || roleKey === "enrich_industry_segment") {
    failEnrichmentQueueForRun(run, error, now);
  }
  if (roleKey === "score_company_service_fit") {
    db.query(`
      UPDATE work_queue
      SET status = 'failed',
          error = ?1,
          updated_at = ?2
      WHERE id = ?3
        AND kind = 'service_fit_assessment'
    `).run(error, now, requestId);
  }
  if (roleKey === "score_company_service_fit" || roleKey === "enrich_company" || roleKey === "draft_outreach") {
    updateSchedulerRunForRequest({
      requestId,
      roleKey,
      status: "failed",
      result: {
        terminalStatus: localStatus,
        retryable: true,
        source: "autopilot_reconcile",
      },
      error,
      finish: true,
      releaseLock: false,
    });
  }
}

async function reconcileActiveKindlingRuns() {
  const rows = db.query(`
    SELECT *
    FROM kindling_pipeline_runs
    WHERE status IN ('queued', 'running')
      AND COALESCE(autopilot_run_id, '') != ''
    ORDER BY updated_at ASC
    LIMIT 12
  `).all() as Record<string, unknown>[];
  for (const row of rows) {
    const remoteRun = await fetchAutopilotPipelineRun(String(row.autopilot_run_id ?? ""));
    const remoteStatus = String(remoteRun?.status ?? "");
    if (remoteStatus !== "error") continue;
    markKindlingRunFailedFromAutopilot(row, String(remoteRun?.error ?? "Autopilot pipeline failed"));
  }
}

function getDiscoveryJobDetail(jobId: string) {
  const jobRow = db.query("SELECT * FROM discovery_jobs WHERE id = ?1").get(jobId) as Record<string, unknown> | null;
  if (!jobRow) return null;
  const job = mapDiscoveryJob(jobRow);
  const run = db.query(`
    SELECT *
    FROM kindling_pipeline_runs
    WHERE local_request_id = ?1 AND role_key = 'scan_target_list'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(jobId) as Record<string, unknown> | null;
  const strategies = (db.query(`
    SELECT *
    FROM scan_strategy_attempts
    WHERE discovery_job_id = ?1
    ORDER BY created_at ASC
  `).all(jobId) as Record<string, unknown>[]).map(mapStrategyAttempt);
  const resultPayload = jsonParse<Record<string, unknown>>(run?.result_payload_json, {});
  const result = objectRecord(resultPayload.result);
  const plannedNextStrategies = Array.isArray(result.plannedNextStrategies)
    ? (result.plannedNextStrategies as Record<string, unknown>[]).map((strategy, index) => ({
      id: `planned-${job.id}-${index}`,
      discoveryJobId: job.id,
      industry: String(strategy.industry ?? result.industry ?? job.industry),
      location: String(strategy.location ?? result.location ?? job.location),
      strategyType: String(strategy.strategyType ?? strategy.strategy ?? "search"),
      query: String(strategy.query ?? ""),
      status: "planned",
      resultCount: Number(strategy.resultCount ?? strategy.companiesFound ?? 0),
      notes: String(strategy.notes ?? ""),
      payload: strategy,
      createdAt: Number(run?.updated_at ?? job.updatedAt),
    }))
    : [];
  const returnedCompanies = Array.isArray(result.companies) ? result.companies as Record<string, unknown>[] : [];
  const returnedWebsites = new Set(returnedCompanies.map((company) => String(company.website ?? "").trim().toLowerCase()).filter(Boolean));
  const returnedNames = new Set(returnedCompanies.map((company) => String(company.name ?? "").trim().toLowerCase()).filter(Boolean));
  const scanCompanyIds = new Set((db.query(`
    SELECT c.id
    FROM companies c
    JOIN activities a
      ON a.target_type = 'company'
     AND a.target_id = c.id
     AND a.action_type IN ('company_created', 'company_matched')
    WHERE json_extract(a.payload_json, '$.requestId') = ?1
  `).all(job.id) as Record<string, unknown>[]).map((row) => String(row.id)));
  const createdIds = new Set((db.query(`
    SELECT c.id
    FROM companies c
    JOIN activities a
      ON a.target_type = 'company'
     AND a.target_id = c.id
     AND a.action_type = 'company_created'
    WHERE json_extract(a.payload_json, '$.requestId') = ?1
  `).all(job.id) as Record<string, unknown>[]).map((row) => String(row.id)));
  const allCompanies = (db.query("SELECT * FROM companies ORDER BY updated_at DESC, name ASC").all() as Record<string, unknown>[]);
  const companies = allCompanies
    .filter((company) => {
      const id = String(company.id);
      const website = String(company.website ?? "").trim().toLowerCase();
      const name = String(company.name ?? "").trim().toLowerCase();
      return scanCompanyIds.has(id) || (website && returnedWebsites.has(website)) || (name && returnedNames.has(name));
    })
    .slice(0, 120)
    .map(mapCompany);
  const companyIds = new Set(companies.map((company) => company.id));
  const sourceRows = db.query("SELECT company_id FROM sources").all() as Record<string, unknown>[];
  const sourceCount = sourceRows.filter((source) => companyIds.has(String(source.company_id))).length;
  const returnedSourceCount = returnedCompanies.reduce((total, company) => {
    const sources = Array.isArray(company.sources) ? company.sources : [];
    return total + (sources.length || (String(company.website ?? "").trim() ? 1 : 0));
  }, 0);
  const searchedStrategies = strategies.filter((strategy) => strategy.status !== "planned");
  const legacyPlannedStrategies = strategies.filter((strategy) => strategy.status === "planned");
  const plannedStrategies = plannedNextStrategies.length ? plannedNextStrategies : legacyPlannedStrategies;
  const returnedCount = returnedCompanies.length || Number(resultPayload?.persistence && objectRecord(resultPayload.persistence).companiesArtifact ? objectRecord(objectRecord(resultPayload.persistence).companiesArtifact).count : 0) || job.companyCount;
  const netNewCount = createdIds.size;
  return {
    job,
    input: scanJobInputFromRun(run, job),
    strategies: searchedStrategies,
    searchedStrategies,
    plannedStrategies,
    outputs: {
      companyCount: returnedCount,
      returnedCompanies: returnedCount,
      netNewCompanies: netNewCount,
      existingMatchedCompanies: Math.max(0, returnedCount - netNewCount),
      sourceCount: returnedSourceCount || job.sourceCount || sourceCount,
      shownCompanies: companies.length,
      companies,
      summary: job.summary,
      run: run ? mapRun(run) : null,
      targetCount: job.targetCount,
      remainingTarget: Math.max(0, job.targetCount - returnedCount),
    },
  };
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function textIncludesAny(value: string, tokens: string[]) {
  const lower = value.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function numericProfileField(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function companyProfileSearchText(company: Record<string, unknown>, profile: Record<string, unknown>) {
  return JSON.stringify({
    name: company.name,
    industry: company.industry,
    location: company.location,
    summary: profile.summary,
    description: profile.description,
    servicesOffered: profile.servicesOffered,
    customerTypes: profile.customerTypes,
    ownership: profile.ownership,
    technologyHints: profile.technologyHints,
  });
}

function employeeBandScore(profile: Record<string, unknown>) {
  const size = objectRecord(profile.size);
  const bucket = String(size.employeeCountBucket ?? size.employee_count_bucket ?? "").trim();
  if (["5-20", "20-50", "50-100"].includes(bucket)) return 1;
  if (["<5", "100-500"].includes(bucket)) return 0.65;
  if (bucket === "1" || bucket === "500+") return 0.35;
  return 0.45;
}

type RankingCandidateScore = {
  companyId: string;
  score: number;
  reason: string;
  scoreJson: Record<string, unknown>;
};

function scoreInitialRankingCandidate(row: Record<string, unknown>, now = Date.now()): RankingCandidateScore {
  const profile = jsonParse<Record<string, unknown>>(row.profile_json, {});
  const text = companyProfileSearchText(row, profile);
  const sourceCount = Number(row.source_count ?? 0);
  const maxSourceConfidence = Number(row.max_source_confidence ?? 0);
  const avgSourceConfidence = Number(row.avg_source_confidence ?? 0);
  const signalCount = Number(row.signal_count ?? 0);
  const signalStrengthScore = Number(row.signal_strength_score ?? 0);
  const latestEvidenceAt = Math.max(
    Number(row.latest_source_at ?? 0),
    Number(row.latest_profile_at ?? 0),
    Number(row.latest_signal_at ?? 0),
    Number(row.updated_at ?? 0),
  );
  const sourceQuality = clampScore(
    (String(row.website ?? "").trim() ? 0.18 : 0)
      + Math.min(sourceCount, 4) * 0.11
      + maxSourceConfidence * 0.24
      + avgSourceConfidence * 0.12
      + Number(row.confidence ?? 0) * 0.06,
  );
  const segmentPriority = Number(row.best_segment_priority ?? 999);
  const segmentTier = Number(row.best_segment_tier ?? 5);
  const segmentConfidence = Number(row.best_segment_confidence ?? 0);
  const segmentScore = clampScore(
    segmentPriority <= 10 ? 0.95
      : segmentPriority <= 25 ? 0.85
        : segmentPriority <= 50 ? 0.72
          : segmentPriority <= 100 ? 0.58
            : segmentPriority < 999 ? 0.42
              : 0.3,
  ) * clampScore(0.75 + Math.min(segmentConfidence, 1) * 0.25) * (segmentTier === 1 ? 1 : segmentTier === 2 ? 0.9 : segmentTier === 3 ? 0.78 : 0.65);
  const location = String(row.location ?? "");
  const geographyScore = textIncludesAny(location, ["perth"]) ? 0.95
    : textIncludesAny(location, ["western australia", " wa", ",wa", "wa "]) ? 0.85
      : textIncludesAny(location, ["australia"]) ? 0.6
        : location.trim() ? 0.45 : 0.25;
  const ownership = objectRecord(profile.ownership);
  const ownerLedLikelihood = numericProfileField(ownership.ownerLedLikelihood ?? ownership.owner_led_likelihood, NaN);
  const ownerLedScore = Number.isFinite(ownerLedLikelihood)
    ? clampScore(ownerLedLikelihood)
    : textIncludesAny(text, ["owner-led", "owner led", "founder", "principal", "partner-owned", "partner owned", "directors", "family business"])
      ? 0.78
      : 0.4;
  const triggerScore = clampScore((Math.min(signalCount, 5) * 0.12) + Math.min(signalStrengthScore, 2.5) * 0.28);
  const contactPaths = Array.isArray(profile.contactPaths) ? profile.contactPaths : [];
  const reachabilityScore = clampScore(
    (String(row.website ?? "").trim() ? 0.42 : 0)
      + (contactPaths.length ? 0.38 : 0)
      + (sourceCount > 0 ? 0.14 : 0)
      + (textIncludesAny(text, ["contact", "book a call", "email", "phone"]) ? 0.06 : 0),
  );
  const ageMs = latestEvidenceAt > 0 ? Math.max(0, now - latestEvidenceAt) : Number.POSITIVE_INFINITY;
  const freshnessScore = ageMs <= 30 * 24 * 60 * 60 * 1000 ? 1
    : ageMs <= 90 * 24 * 60 * 60 * 1000 ? 0.82
      : ageMs <= 180 * 24 * 60 * 60 * 1000 ? 0.62
        : latestEvidenceAt > 0 ? 0.4 : 0.2;
  const gaps = Array.isArray(profile.gaps) ? profile.gaps : [];
  const missingChecks = [
    String(row.website ?? "").trim(),
    String(row.industry ?? "").trim(),
    String(row.location ?? "").trim(),
    sourceCount > 0 ? "sources" : "",
    Number(row.best_segment_priority ?? 0) ? "segment" : "",
    String(profile.summary ?? profile.description ?? "").trim(),
  ];
  const missingCount = missingChecks.filter((value) => !value).length;
  const gapPenalty = Math.min(0.3, gaps.length * 0.06);
  const completenessScore = clampScore(1 - missingCount * 0.12 - gapPenalty);
  const advisoryReferralScore = clampScore(
    (textIncludesAny(text, ["advisory", "advisor", "accounting", "bookkeeping", "tax", "legal", "law", "wealth", "financial planning", "broker", "consulting", "cfo", "hr consulting", "leadership"]) ? 0.72 : 0.35)
      + employeeBandScore(profile) * 0.18
      + ownerLedScore * 0.1,
  );
  const dimensions = {
    sourceQuality,
    segmentPriority: segmentScore,
    geography: geographyScore,
    ownerLed: ownerLedScore,
    triggers: triggerScore,
    reachability: reachabilityScore,
    freshness: freshnessScore,
    missingFieldCompleteness: completenessScore,
    advisoryReferralPotential: advisoryReferralScore,
  };
  const weighted =
    dimensions.sourceQuality * 0.16
    + dimensions.segmentPriority * 0.15
    + dimensions.geography * 0.1
    + dimensions.ownerLed * 0.11
    + dimensions.triggers * 0.13
    + dimensions.reachability * 0.11
    + dimensions.freshness * 0.08
    + dimensions.missingFieldCompleteness * 0.08
    + dimensions.advisoryReferralPotential * 0.08;
  const score = Math.round(clampScore(weighted) * 1000) / 10;
  const drivers: string[] = [];
  if (sourceQuality >= 0.75) drivers.push("strong source evidence");
  if (segmentScore >= 0.75) drivers.push("priority segment fit");
  if (geographyScore >= 0.85) drivers.push("Perth/WA fit");
  if (ownerLedScore >= 0.7) drivers.push("owner-led hints");
  if (triggerScore >= 0.55) drivers.push("active public triggers");
  if (reachabilityScore >= 0.7) drivers.push("reachable public contact path");
  if (advisoryReferralScore >= 0.75) drivers.push("advisory/referral potential");
  const risks: string[] = [];
  if (sourceCount === 0) risks.push("no stored sources");
  if (!String(row.website ?? "").trim()) risks.push("missing website");
  if (Number(row.best_segment_priority ?? 0) === 0) risks.push("missing segment");
  if (missingCount > 1 || gaps.length) risks.push("profile gaps");
  const reason = [
    drivers.length ? drivers.slice(0, 3).join(", ") : "usable enhanced profile",
    risks.length ? `risks: ${risks.slice(0, 2).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return {
    companyId: String(row.id),
    score,
    reason,
    scoreJson: {
      score,
      scoreVersion: "initial-v1",
      dimensions,
      weights: {
        sourceQuality: 0.16,
        segmentPriority: 0.15,
        geography: 0.1,
        ownerLed: 0.11,
        triggers: 0.13,
        reachability: 0.11,
        freshness: 0.08,
        missingFieldCompleteness: 0.08,
        advisoryReferralPotential: 0.08,
      },
      evidence: {
        sourceCount,
        maxSourceConfidence,
        avgSourceConfidence,
        signalCount,
        signalStrengthScore,
        latestEvidenceAt: Number.isFinite(latestEvidenceAt) && latestEvidenceAt > 0 ? latestEvidenceAt : null,
        bestSegmentId: row.best_segment_id ? String(row.best_segment_id) : null,
        bestSegmentPriority: row.best_segment_priority ? Number(row.best_segment_priority) : null,
        bestSegmentTier: row.best_segment_tier ? Number(row.best_segment_tier) : null,
        profileVersionCount: Number(row.profile_version_count ?? 0),
        missingCount,
        gapCount: gaps.length,
      },
      drivers,
      risks,
    },
  };
}

function initialRankingCandidateRows(limit: number | null = null) {
  const limitClause = limit && Number.isFinite(limit) && limit > 0 ? `LIMIT ${Math.min(Math.floor(limit), 5000)}` : "";
  return db.query(`
    SELECT
      c.*,
      (SELECT COUNT(*) FROM sources s WHERE s.company_id = c.id) AS source_count,
      COALESCE((SELECT MAX(s.confidence) FROM sources s WHERE s.company_id = c.id), 0) AS max_source_confidence,
      COALESCE((SELECT AVG(s.confidence) FROM sources s WHERE s.company_id = c.id), 0) AS avg_source_confidence,
      COALESCE((SELECT MAX(s.created_at) FROM sources s WHERE s.company_id = c.id), 0) AS latest_source_at,
      (SELECT COUNT(*) FROM customer_profile_versions cpv WHERE cpv.company_id = c.id) AS profile_version_count,
      COALESCE((SELECT MAX(cpv.created_at) FROM customer_profile_versions cpv WHERE cpv.company_id = c.id), 0) AS latest_profile_at,
      (SELECT COUNT(*) FROM signals sig WHERE sig.company_id = c.id) AS signal_count,
      COALESCE((
        SELECT SUM(sig.confidence * CASE sig.strength WHEN 'high' THEN 1 WHEN 'medium' THEN 0.65 WHEN 'low' THEN 0.35 ELSE 0.25 END)
        FROM signals sig
        WHERE sig.company_id = c.id
      ), 0) AS signal_strength_score,
      COALESCE((SELECT MAX(sig.created_at) FROM signals sig WHERE sig.company_id = c.id), 0) AS latest_signal_at,
      (
        SELECT cs.segment_id
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ) AS best_segment_id,
      COALESCE((
        SELECT ts.priority
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 999999) AS best_segment_priority,
      COALESCE((
        SELECT ts.tier
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 5) AS best_segment_tier,
      COALESCE((
        SELECT cs.confidence
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 0) AS best_segment_confidence
    FROM companies c
    WHERE (c.data_ring IN ('enhanced', 'ranked') OR c.enrichment_status = 'complete')
      AND c.data_ring NOT IN ('scored', 'outreach_ready', 'contacted', 'parked')
    ORDER BY c.updated_at DESC, lower(c.name) ASC
    ${limitClause}
  `).all() as Record<string, unknown>[];
}

function mapRankingRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    rankingType: String(row.ranking_type),
    status: String(row.status),
    reason: String(row.reason ?? ""),
    candidateCount: Number(row.candidate_count ?? 0),
    rankedCount: Number(row.ranked_count ?? 0),
    scoreVersion: String(row.score_version ?? "initial-v1"),
    parameters: jsonParse<Record<string, unknown>>(row.parameters_json, {}),
    createdBy: String(row.created_by ?? "local"),
    startedAt: Number(row.started_at ?? 0),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function mapRankingItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    rankingRunId: String(row.ranking_run_id),
    companyId: String(row.company_id),
    rank: Number(row.rank ?? 0),
    score: Number(row.score ?? 0),
    reason: String(row.reason ?? ""),
    scoreJson: jsonParse<Record<string, unknown>>(row.score_json, {}),
    createdAt: Number(row.created_at ?? 0),
    company: row.name ? {
      id: String(row.company_id),
      name: String(row.name),
      location: String(row.location ?? ""),
      industry: String(row.industry ?? ""),
      website: String(row.website ?? ""),
      dataRing: normalizeCompanyDataRing(row.data_ring),
      enrichmentStatus: normalizeCompanyExecutionStatus(row.enrichment_status),
    } : undefined,
  };
}

function getRankingRunDetail(runId: string) {
  const run = db.query("SELECT * FROM ranking_runs WHERE id = ?1").get(runId) as Record<string, unknown> | null;
  if (!run) return null;
  const items = db.query(`
    SELECT ri.*, c.name, c.location, c.industry, c.website, c.data_ring, c.enrichment_status
    FROM ranking_items ri
    JOIN companies c ON c.id = ri.company_id
    WHERE ri.ranking_run_id = ?1
    ORDER BY ri.rank ASC
  `).all(runId) as Record<string, unknown>[];
  return { run: mapRankingRun(run), items: items.map(mapRankingItem) };
}

function listRankingRuns(limit = 20) {
  return (db.query(`
    SELECT *
    FROM ranking_runs
    WHERE ranking_type = 'initial'
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?1
  `).all(Math.max(1, Math.min(100, Math.floor(limit)))) as Record<string, unknown>[]).map(mapRankingRun);
}

function runInitialRanking(input: { reason?: string; limit?: number | null; createdBy?: string } = {}) {
  const now = Date.now();
  const runId = crypto.randomUUID();
  const reason = String(input.reason ?? "Initial ranking rebuild").trim() || "Initial ranking rebuild";
  const parameters = {
    limit: input.limit ?? null,
    source: "local_initial_ranking",
  };
  const candidates = initialRankingCandidateRows(input.limit ?? null);
  const scored = candidates
    .map((row) => scoreInitialRankingCandidate(row, now))
    .sort((a, b) => b.score - a.score || a.companyId.localeCompare(b.companyId));
  const transaction = db.transaction(() => {
    db.query(`
      INSERT INTO ranking_runs(
        id, ranking_type, status, reason, candidate_count, ranked_count, score_version,
        parameters_json, created_by, started_at, completed_at, created_at, updated_at
      )
      VALUES (?1, 'initial', 'running', ?2, ?3, 0, 'initial-v1', ?4, ?5, ?6, NULL, ?6, ?6)
    `).run(runId, reason, candidates.length, JSON.stringify(parameters), input.createdBy ?? "local", now);
    const insertItem = db.query(`
      INSERT INTO ranking_items(id, ranking_run_id, company_id, rank, score, reason, score_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `);
    const rankableCompanyIds: string[] = [];
    scored.forEach((item, index) => {
      const rank = index + 1;
      const scoreJson = { ...item.scoreJson, rankingRunId: runId, rankingType: "initial", rank };
      insertItem.run(crypto.randomUUID(), runId, item.companyId, rank, item.score, item.reason, JSON.stringify(scoreJson), now);
      rankableCompanyIds.push(item.companyId);
    });
    if (rankableCompanyIds.length) {
      const placeholders = rankableCompanyIds.map((_, index) => `?${index + 2}`).join(", ");
      db.query(`
        UPDATE companies
        SET data_ring = 'ranked', updated_at = ?1
        WHERE data_ring = 'enhanced'
          AND id IN (${placeholders})
      `).run(now, ...rankableCompanyIds);
    }
    db.query(`
      UPDATE ranking_runs
      SET status = 'complete',
          ranked_count = ?1,
          completed_at = ?2,
          updated_at = ?2
      WHERE id = ?3
    `).run(scored.length, now, runId);
  });
  transaction();
  recordActivity("ranking_run", runId, input.createdBy ?? "local", "initial_ranking_rebuilt", `Initial ranking rebuilt for ${scored.length} companies`, {
    candidateCount: candidates.length,
    rankedCount: scored.length,
  });
  return getRankingRunDetail(runId)!;
}

function normalizedScore100(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed <= 1 ? Math.round(clampScore(parsed) * 1000) / 10 : Math.max(0, Math.min(100, parsed));
}

function topTargetCaveatFlags(caveats: unknown[]) {
  const text = caveats.map((caveat) => typeof caveat === "string" ? caveat : JSON.stringify(caveat)).join(" ").toLowerCase();
  return {
    highCaveat: caveats.length >= 2 || textIncludesAny(text, ["unverified", "unknown", "no decision", "missing", "compliance", "risk"]),
    severeCaveat: textIncludesAny(text, ["do not contact", "privacy", "legal risk", "no consent"]),
  };
}

function topTargetEvidenceQuality(row: Record<string, unknown>, evidence: unknown[]) {
  const sourceCount = Number(row.source_count ?? 0);
  const avgSourceConfidence = Number(row.avg_source_confidence ?? 0);
  const maxSourceConfidence = Number(row.max_source_confidence ?? 0);
  const signalCount = Number(row.signal_count ?? 0);
  return clampScore(
    Math.min(evidence.length, 4) * 0.14
      + Math.min(sourceCount, 5) * 0.07
      + avgSourceConfidence * 0.2
      + maxSourceConfidence * 0.16
      + Math.min(signalCount, 4) * 0.04
      + Number(row.company_confidence ?? 0) * 0.08,
  );
}

function topTargetFreshnessScore(row: Record<string, unknown>, now: number) {
  const latestEvidenceAt = Math.max(
    Number(row.latest_source_at ?? 0),
    Number(row.latest_signal_at ?? 0),
    Number(row.latest_profile_at ?? 0),
    Number(row.updated_at ?? 0),
  );
  const ageMs = latestEvidenceAt > 0 ? Math.max(0, now - latestEvidenceAt) : Number.POSITIVE_INFINITY;
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return 1;
  if (ageMs <= 90 * 24 * 60 * 60 * 1000) return 0.8;
  if (ageMs <= 180 * 24 * 60 * 60 * 1000) return 0.55;
  return latestEvidenceAt > 0 ? 0.35 : 0.15;
}

function topTargetSegmentScore(row: Record<string, unknown>) {
  const priority = Number(row.best_segment_priority ?? 999999);
  const tier = Number(row.best_segment_tier ?? 5);
  const confidence = clampScore(Number(row.best_segment_confidence ?? 0));
  const priorityScore = priority <= 10 ? 0.95
    : priority <= 25 ? 0.84
      : priority <= 50 ? 0.68
        : priority <= 100 ? 0.52
          : priority < 999999 ? 0.36 : 0.22;
  const tierMultiplier = tier === 1 ? 1 : tier === 2 ? 0.9 : tier === 3 ? 0.78 : 0.64;
  return clampScore(priorityScore * tierMultiplier * (0.78 + confidence * 0.22));
}

function topTargetReachabilityScore(row: Record<string, unknown>) {
  const profile = jsonParse<Record<string, unknown>>(row.profile_json, {});
  const contactPaths = Array.isArray(profile.contactPaths) ? profile.contactPaths : [];
  const text = JSON.stringify({
    website: row.website,
    profile,
  });
  return clampScore(
    (String(row.website ?? "").trim() ? 0.42 : 0)
      + (contactPaths.length ? 0.36 : 0)
      + (Number(row.source_count ?? 0) > 0 ? 0.14 : 0)
      + (textIncludesAny(text, ["contact", "email", "phone", "book a call"]) ? 0.08 : 0),
  );
}

type TopTargetCandidate = {
  companyId: string;
  serviceFitAssessmentId: string;
  marketProfileVersionId: string;
  score: number;
  reason: string;
  bestOfferingId: string;
  bestOfferingKey: string;
  bestOfferingName: string;
  bestVariantKey: string;
  whyNow: string;
  evidenceQuality: number;
  confidence: number;
  caveats: unknown[];
  nextAction: string;
  flags: string[];
  scoreJson: Record<string, unknown>;
};

function scoreTopTargetAssessment(row: Record<string, unknown>, now = Date.now()): TopTargetCandidate {
  const evidence = jsonParse<unknown[]>(row.evidence_json, []);
  const caveats = jsonParse<unknown[]>(row.caveats_json, []);
  const drivers = jsonParse<unknown[]>(row.drivers_json, []);
  const assessment = jsonParse<Record<string, unknown>>(row.assessment_json, {});
  const assessmentScore = normalizedScore100(row.score);
  const confidence = clampConfidence(row.confidence, 0);
  const evidenceQuality = topTargetEvidenceQuality(row, evidence);
  const freshnessScore = topTargetFreshnessScore(row, now);
  const segmentScore = topTargetSegmentScore(row);
  const reachabilityScore = topTargetReachabilityScore(row);
  const caveatState = topTargetCaveatFlags(caveats);
  const caveatPenalty = Math.min(0.36, caveats.length * 0.08 + (caveatState.highCaveat ? 0.08 : 0) + (caveatState.severeCaveat ? 0.18 : 0));
  const confidencePenalty = confidence < 0.55 ? (0.55 - confidence) * 0.48 : 0;
  const baseScore = clampScore(
    (assessmentScore / 100) * 0.5
      + confidence * 0.13
      + evidenceQuality * 0.15
      + freshnessScore * 0.08
      + reachabilityScore * 0.08
      + segmentScore * 0.06
      - caveatPenalty
      - confidencePenalty,
  );
  const flags = [
    confidence < 0.55 ? "low_confidence" : "",
    caveatState.highCaveat ? "high_caveat" : "",
    evidenceQuality < 0.45 ? "weak_evidence" : "",
    reachabilityScore < 0.35 ? "weak_reachability" : "",
  ].filter(Boolean);
  const driverReasons = drivers
    .map((driver) => typeof driver === "string" ? driver : String(objectRecord(driver).reason ?? objectRecord(driver).dimension ?? ""))
    .filter(Boolean);
  const reason = String(row.fit_explanation ?? "").trim()
    || driverReasons.slice(0, 2).join("; ")
    || `Best service fit score ${Math.round(assessmentScore)}`;
  const signalCount = Number(row.signal_count ?? 0);
  const whyNow = signalCount > 0
    ? `${signalCount} stored trigger signal${signalCount === 1 ? "" : "s"} and recent service-fit evidence`
    : evidenceQuality >= 0.65
      ? "Strong stored assessment evidence is ready for review"
      : "Service-fit assessment is available, but evidence should be checked before action";
  const nextAction = String(row.recommended_action ?? "").trim()
    || (flags.length ? "Review caveats and evidence before outreach" : "Review for outreach positioning");
  return {
    companyId: String(row.company_id),
    serviceFitAssessmentId: String(row.id),
    marketProfileVersionId: String(row.market_profile_version_id),
    score: Math.round(baseScore * 1000) / 10,
    reason,
    bestOfferingId: String(row.service_offering_id),
    bestOfferingKey: String(row.offering_key ?? ""),
    bestOfferingName: String(row.offering_name ?? ""),
    bestVariantKey: String(row.offering_variant_key ?? assessment.variantKey ?? ""),
    whyNow,
    evidenceQuality,
    confidence,
    caveats,
    nextAction,
    flags,
    scoreJson: {
      scoreVersion: "top-target-v1",
      assessmentScore,
      confidence,
      evidenceQuality,
      dimensions: {
        assessmentScore: assessmentScore / 100,
        confidence,
        evidenceQuality,
        freshness: freshnessScore,
        reachability: reachabilityScore,
        segmentPriority: segmentScore,
      },
      penalties: {
        caveatPenalty,
        confidencePenalty,
      },
      flags,
      sourceAssessmentId: String(row.id),
      secondBestAssessmentScore: null,
    },
  };
}

function topTargetAssessmentRows() {
  return db.query(`
    SELECT
      sfa.*,
      so.key AS offering_key,
      so.name AS offering_name,
      so.variant_key AS offering_variant_key,
      c.name,
      c.location,
      c.industry,
      c.website,
      c.profile_json,
      c.confidence AS company_confidence,
      c.enrichment_status,
      c.data_ring,
      (SELECT COUNT(*) FROM sources src WHERE src.company_id = c.id) AS source_count,
      COALESCE((SELECT AVG(src.confidence) FROM sources src WHERE src.company_id = c.id), 0) AS avg_source_confidence,
      COALESCE((SELECT MAX(src.confidence) FROM sources src WHERE src.company_id = c.id), 0) AS max_source_confidence,
      COALESCE((SELECT MAX(src.created_at) FROM sources src WHERE src.company_id = c.id), 0) AS latest_source_at,
      (SELECT COUNT(*) FROM signals sig WHERE sig.company_id = c.id) AS signal_count,
      COALESCE((SELECT MAX(sig.created_at) FROM signals sig WHERE sig.company_id = c.id), 0) AS latest_signal_at,
      COALESCE((SELECT MAX(cpv.created_at) FROM customer_profile_versions cpv WHERE cpv.company_id = c.id), 0) AS latest_profile_at,
      (
        SELECT cs.segment_id
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ) AS best_segment_id,
      COALESCE((
        SELECT ts.priority
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 999999) AS best_segment_priority,
      COALESCE((
        SELECT ts.tier
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 5) AS best_segment_tier,
      COALESCE((
        SELECT cs.confidence
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = c.id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ), 0) AS best_segment_confidence
    FROM service_fit_assessments sfa
    JOIN companies c ON c.id = sfa.company_id
    JOIN service_offerings so ON so.id = sfa.service_offering_id
    WHERE c.data_ring NOT IN ('contacted', 'parked')
    ORDER BY sfa.updated_at DESC, sfa.score DESC
  `).all() as Record<string, unknown>[];
}

function topTargetCandidates(now = Date.now()) {
  const byCompany = new Map<string, TopTargetCandidate[]>();
  for (const row of topTargetAssessmentRows()) {
    const candidate = scoreTopTargetAssessment(row, now);
    const existing = byCompany.get(candidate.companyId) ?? [];
    existing.push(candidate);
    byCompany.set(candidate.companyId, existing);
  }
  const bestByCompany: TopTargetCandidate[] = [];
  for (const candidates of byCompany.values()) {
    const sorted = candidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.bestOfferingName.localeCompare(b.bestOfferingName));
    const best = sorted[0]!;
    const second = sorted[1] ?? null;
    const secondBestAssessmentScore = second ? Number(second.scoreJson.assessmentScore ?? 0) : null;
    const secondBestBoost = secondBestAssessmentScore !== null ? Math.min(4, secondBestAssessmentScore * 0.03) : 0;
    best.score = Math.round(Math.min(100, best.score + secondBestBoost) * 10) / 10;
    best.scoreJson = {
      ...best.scoreJson,
      secondBestAssessmentScore,
      secondBestOfferingId: second?.bestOfferingId ?? null,
      secondBestBoost,
    };
    bestByCompany.push(best);
  }
  return bestByCompany.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.companyId.localeCompare(b.companyId));
}

function mapTopTargetRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    status: String(row.status),
    reason: String(row.reason ?? ""),
    candidateCount: Number(row.candidate_count ?? 0),
    rankedCount: Number(row.ranked_count ?? 0),
    scoreVersion: String(row.score_version ?? "top-target-v1"),
    parameters: jsonParse<Record<string, unknown>>(row.parameters_json, {}),
    createdBy: String(row.created_by ?? "local"),
    startedAt: Number(row.started_at ?? 0),
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function scoreBand(score: number): "high" | "medium" | "low" {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function bandScoreClause(band: string | undefined, scoreExpr = "tli.score"): string {
  if (band === "high") return `AND ${scoreExpr} >= 75`;
  if (band === "medium") return `AND ${scoreExpr} >= 50 AND ${scoreExpr} < 75`;
  if (band === "low") return `AND ${scoreExpr} < 50`;
  return "";
}

function mapTopTargetItem(row: Record<string, unknown>) {
  const outreachDraftCount = Number(row.outreach_draft_count ?? 0);
  return {
    id: String(row.id),
    targetListRunId: String(row.target_list_run_id),
    companyId: String(row.company_id),
    serviceFitAssessmentId: String(row.service_fit_assessment_id),
    marketProfileVersionId: String(row.market_profile_version_id),
    rank: Number(row.rank ?? 0),
    score: Number(row.score ?? 0),
    assessmentScore: Number(row.assessment_score ?? 0),
    band: String(row.assessment_band ?? "") || scoreBand(Number(row.assessment_score ?? 0)),
    reason: String(row.reason ?? ""),
    bestOffering: {
      id: String(row.best_offering_id),
      key: String(row.best_offering_key ?? ""),
      name: String(row.best_offering_name ?? ""),
      variantKey: String(row.best_variant_key ?? ""),
    },
    bestOfferingId: String(row.best_offering_id),
    bestVariantKey: String(row.best_variant_key ?? ""),
    whyNow: String(row.why_now ?? ""),
    evidenceQuality: Number(row.evidence_quality ?? 0),
    confidence: Number(row.confidence ?? 0),
    caveats: jsonParse<unknown[]>(row.caveats_json, []),
    nextAction: String(row.next_action ?? ""),
    flags: jsonParse<string[]>(row.flags_json, []),
    scoreJson: jsonParse<Record<string, unknown>>(row.score_json, {}),
    hasOutreachDraft: outreachDraftCount > 0,
    outreachDraftCount,
    createdAt: Number(row.created_at ?? 0),
    company: row.name ? {
      id: String(row.company_id),
      name: String(row.name),
      location: String(row.location ?? ""),
      industry: String(row.industry ?? ""),
      website: String(row.website ?? ""),
      dataRing: normalizeCompanyDataRing(row.data_ring),
      enrichmentStatus: normalizeCompanyExecutionStatus(row.enrichment_status),
    } : undefined,
  };
}

function getTopTargetRunDetail(runId: string, limit = 100, offset = 0, options: { hasOutreachDraft?: boolean; band?: string } = {}) {
  const run = db.query("SELECT * FROM target_list_runs WHERE id = ?1").get(runId) as Record<string, unknown> | null;
  if (!run) return null;
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const draftFilter = options.hasOutreachDraft
    ? "AND EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = tli.company_id)"
    : "";
  // Band is derived from the service-fit assessment score (0-100), not the
  // composite ranking score on target_list_items.
  const filters = `${draftFilter} ${bandScoreClause(options.band, "sfa.score")}`;
  // Per-band counts over the whole run (ignore the draft sub-filter so tab
  // labels stay stable as the draft toggle changes).
  const bandRow = db.query(`
    SELECT
      SUM(CASE WHEN sfa.score >= 75 THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN sfa.score >= 50 AND sfa.score < 75 THEN 1 ELSE 0 END) AS medium,
      SUM(CASE WHEN sfa.score < 50 THEN 1 ELSE 0 END) AS low
    FROM target_list_items tli
    JOIN service_fit_assessments sfa ON sfa.id = tli.service_fit_assessment_id
    WHERE tli.target_list_run_id = ?1
  `).get(runId) as { high: number; medium: number; low: number } | null;
  const total = db.query(`
    SELECT COUNT(*) AS count
    FROM target_list_items tli
    JOIN service_fit_assessments sfa ON sfa.id = tli.service_fit_assessment_id
    WHERE tli.target_list_run_id = ?1
      ${filters}
  `).get(runId) as { count: number } | null;
  const items = db.query(`
    SELECT
      tli.*,
      sfa.score AS assessment_score,
      sfa.band AS assessment_band,
      c.name,
      c.location,
      c.industry,
      c.website,
      c.data_ring,
      c.enrichment_status,
      (SELECT COUNT(*) FROM outreach_drafts od WHERE od.company_id = tli.company_id) AS outreach_draft_count
    FROM target_list_items tli
    JOIN service_fit_assessments sfa ON sfa.id = tli.service_fit_assessment_id
    JOIN companies c ON c.id = tli.company_id
    WHERE tli.target_list_run_id = ?1
      ${filters}
    ORDER BY sfa.score DESC, tli.rank ASC
    LIMIT ?2
    OFFSET ?3
  `).all(runId, safeLimit, safeOffset) as Record<string, unknown>[];
  return {
    run: mapTopTargetRun(run),
    items: items.map(mapTopTargetItem),
    total: Number(total?.count ?? 0),
    limit: safeLimit,
    offset: safeOffset,
    bandCounts: {
      high: Number(bandRow?.high ?? 0),
      medium: Number(bandRow?.medium ?? 0),
      low: Number(bandRow?.low ?? 0),
    },
  };
}

function latestTopTargetRunId() {
  const run = db.query(`
    SELECT id
    FROM target_list_runs
    WHERE status = 'complete'
    ORDER BY completed_at DESC, created_at DESC, rowid DESC
    LIMIT 1
  `).get() as Record<string, unknown> | null;
  return run ? String(run.id) : null;
}

function runTopTargetAggregation(input: { reason?: string; limit?: number | null; createdBy?: string } = {}) {
  const now = Date.now();
  const runId = crypto.randomUUID();
  const reason = String(input.reason ?? "Top-target aggregation rebuild").trim() || "Top-target aggregation rebuild";
  const parameters = {
    limit: input.limit ?? null,
    source: "service_fit_assessments",
  };
  const candidates = topTargetCandidates(now);
  const ranked = input.limit && Number.isFinite(input.limit) && input.limit > 0
    ? candidates.slice(0, Math.min(10000, Math.floor(input.limit)))
    : candidates;
  const transaction = db.transaction(() => {
    db.query(`
      INSERT INTO target_list_runs(
        id, status, reason, candidate_count, ranked_count, score_version, parameters_json,
        created_by, started_at, completed_at, created_at, updated_at
      )
      VALUES (?1, 'running', ?2, ?3, 0, 'top-target-v1', ?4, ?5, ?6, NULL, ?6, ?6)
    `).run(runId, reason, candidates.length, JSON.stringify(parameters), input.createdBy ?? "local", now);
    const insertItem = db.query(`
      INSERT INTO target_list_items(
        id, target_list_run_id, company_id, service_fit_assessment_id, market_profile_version_id,
        rank, score, reason, best_offering_id, best_offering_key, best_offering_name, best_variant_key,
        why_now, evidence_quality, confidence, caveats_json, next_action, flags_json, score_json, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
    `);
    ranked.forEach((item, index) => {
      const rank = index + 1;
      const scoreJson = { ...item.scoreJson, targetListRunId: runId, rank };
      insertItem.run(
        crypto.randomUUID(),
        runId,
        item.companyId,
        item.serviceFitAssessmentId,
        item.marketProfileVersionId,
        rank,
        item.score,
        item.reason,
        item.bestOfferingId,
        item.bestOfferingKey,
        item.bestOfferingName,
        item.bestVariantKey,
        item.whyNow,
        item.evidenceQuality,
        item.confidence,
        JSON.stringify(item.caveats),
        item.nextAction,
        JSON.stringify(item.flags),
        JSON.stringify(scoreJson),
        now,
      );
    });
    db.query(`
      UPDATE target_list_runs
      SET status = 'complete',
          ranked_count = ?1,
          completed_at = ?2,
          updated_at = ?2
      WHERE id = ?3
    `).run(ranked.length, now, runId);
  });
  transaction();
  recordActivity("target_list_run", runId, input.createdBy ?? "local", "top_targets_rebuilt", `Top targets rebuilt for ${ranked.length} companies`, {
    candidateCount: candidates.length,
    rankedCount: ranked.length,
  });
  return getTopTargetRunDetail(runId, input.limit ?? 100)!;
}

function getOrBuildTopTargetDetail(limit = 100, offset = 0) {
  const runId = latestTopTargetRunId();
  const detail = runId ? getTopTargetRunDetail(runId, limit, offset) : null;
  if (detail) return { ...detail, rebuilt: false };
  const rebuilt = runTopTargetAggregation({ reason: "Read-through top-target aggregation", limit: null, createdBy: "local" });
  const limitedDetail = getTopTargetRunDetail(rebuilt.run.id, limit, offset) ?? rebuilt;
  return { ...limitedDetail, rebuilt: true };
}

function markKindlingStartFailed(run: Record<string, unknown>, error: string) {
  const now = Date.now();
  const roleKey = String(run.role_key ?? "");
  const requestId = String(run.local_request_id ?? "");
  db.query("UPDATE kindling_pipeline_runs SET status = 'failed', error = ?1, updated_at = ?2 WHERE id = ?3")
    .run(error, now, String(run.id));

  if (roleKey === "scan_target_list") {
    db.query(`
      UPDATE discovery_jobs
      SET status = 'failed', summary = ?1, updated_at = ?2
      WHERE id = ?3 AND status IN ('queued', 'running')
    `).run(error, now, requestId);
    updateSchedulerRunForRequest({
      requestId,
      status: "failed",
      result: {
        terminalStatus: "failed",
        retryable: true,
        source: "autopilot_start",
      },
      error,
      finish: true,
      releaseLock: true,
    });
  }
  if (roleKey === "enrich_company" || roleKey === "enrich_industry_segment") {
    failEnrichmentQueueForRun(run, error, now);
  }
  if (roleKey === "score_company_service_fit") {
    db.query(`
      UPDATE work_queue
      SET status = 'failed',
          error = ?1,
          locked_by_run_id = NULL,
          updated_at = ?2
      WHERE id = ?3
        AND kind = 'service_fit_assessment'
        AND status IN ('queued', 'running')
    `).run(error, now, requestId);
    updateSchedulerRunForRequest({
      requestId,
      roleKey: "score_company_service_fit",
      status: "failed",
      result: {
        terminalStatus: "failed",
        retryable: true,
        source: "autopilot_start",
      },
      error,
      finish: true,
      releaseLock: true,
    });
  }
  if (roleKey === "draft_outreach") {
    updateSchedulerRunForRequest({
      requestId,
      roleKey: "draft_outreach",
      status: "failed",
      result: {
        terminalStatus: "failed",
        retryable: true,
        source: "autopilot_start",
      },
      error,
      finish: true,
      releaseLock: false,
    });
  }
}

async function startKindlingRun(runId: string, authorization?: string) {
  const run = db.query("SELECT * FROM kindling_pipeline_runs WHERE id = ?1").get(runId) as Record<string, unknown> | null;
  if (!run) throw new Error("pipeline run not found");
  const triggerRequest = jsonParse<ReturnType<typeof buildKindlingTriggerRequest>>(run.trigger_payload_json, null as never);
  const role = getPipelineRole(String(run.role_key));
  if (!role?.enabled) throw new Error("pipeline role is disabled");

  try {
    const bodyText = JSON.stringify(triggerRequest.body);
    const effectiveAuthorization = authorization || buildServerNip98Authorization(triggerRequest.url, triggerRequest.method, bodyText);
    const res = await fetch(triggerRequest.url, {
      method: triggerRequest.method,
      headers: {
        "content-type": "application/json",
        ...(effectiveAuthorization ? { authorization: effectiveAuthorization } : {}),
      },
      body: bodyText,
    });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(payload.error ?? res.statusText));
    const remoteRun = payload.run && typeof payload.run === "object" ? payload.run as Record<string, unknown> : {};
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', autopilot_run_id = ?1, updated_at = ?2 WHERE id = ?3")
      .run(String(remoteRun.id ?? payload.runId ?? ""), Date.now(), runId);
    markRunEnrichmentQueueRunning(run, String(remoteRun.id ?? payload.runId ?? ""), Date.now());
    if (String(run.role_key ?? "") === "scan_target_list") {
      updateSchedulerRunForRequest({
        requestId: String(run.local_request_id ?? ""),
        status: "running",
        autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        result: {
          autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        },
      });
    }
    if (String(run.role_key ?? "") === "score_company_service_fit") {
      updateSchedulerRunForRequest({
        requestId: String(run.local_request_id ?? ""),
        roleKey: "score_company_service_fit",
        status: "running",
        autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        result: {
          autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        },
      });
    }
    if (String(run.role_key ?? "") === "enrich_company" || String(run.role_key ?? "") === "draft_outreach") {
      updateSchedulerRunForRequest({
        requestId: String(run.local_request_id ?? ""),
        roleKey: String(run.role_key ?? ""),
        status: "running",
        autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        result: {
          autopilotRunId: String(remoteRun.id ?? payload.runId ?? "") || null,
        },
      });
    }
    return { mode: "autopilot-http", runId: String(remoteRun.id ?? payload.runId ?? runId), status: "running" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markKindlingStartFailed(run, message);
    throw error;
  }
}

function shouldDeferKindlingAutopilotAuth(body: Record<string, unknown>, roleKey: string) {
  if (body.deferAutopilotAuth !== true) return false;
  const role = getPipelineRole(roleKey);
  return kindlingRunNeedsAutopilotAuth(role?.activePipelineSlug || roleKey);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampConfidence(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function normalizeSourceType(value: unknown) {
  const sourceType = String(value ?? "pipeline_enrichment").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return sourceType || "pipeline_enrichment";
}

function normalizeSignalStrength(value: unknown, confidence: number) {
  const strength = String(value ?? "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(strength)) return strength;
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

function normalizeKindlingCallbackRecords(roleKey: string, body: Record<string, unknown>) {
  const records = objectRecord(body.records);
  if (Object.keys(records).length) return records;
  const result = objectRecord(body.result);
  if (!Object.keys(result).length) return {};

  if (roleKey === "develop_service_offering") {
    const patch = objectRecord(result.profileVersionPatch);
    const rationaleNotes = Array.isArray(result.rationaleNotes) ? result.rationaleNotes.map(String) : [];
    const nextQuestions = Array.isArray(result.nextQuestions) ? result.nextQuestions : [];
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const structured = {
      ...patch,
      changeSummary: String(result.changeSummary ?? ""),
      response: String(result.response ?? body.response ?? ""),
      rationaleNotes,
      nextQuestions,
      evidence,
      warnings,
    };
    return {
      marketProfileVersion: {
        summary: String(patch.summary ?? body.response ?? "Service offering updated"),
        rationale: String(patch.rationale ?? rationaleNotes.join("\n") ?? ""),
        structured,
        sourceReferences: Array.isArray(patch.sourceReferences) ? patch.sourceReferences : evidence,
      },
      nextQuestions,
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
      plannedNextStrategies: Array.isArray(result.plannedNextStrategies) ? result.plannedNextStrategies : [],
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  }

  if (roleKey === "enrich_company") {
    const profilePatch = objectRecord(result.profilePatch);
    const gaps = Array.isArray(result.gaps) ? result.gaps : Array.isArray(profilePatch.gaps) ? profilePatch.gaps : [];
    const fieldsUpdated = Array.isArray(result.fieldsUpdated) ? result.fieldsUpdated : [];
    const decisionMakers = Array.isArray(result.decisionMakers)
      ? result.decisionMakers
      : Array.isArray(profilePatch.decisionMakers)
        ? profilePatch.decisionMakers
        : [];
    return {
      company: {
        id: String(result.companyId ?? ""),
        name: String(result.companyName ?? ""),
        dataRing: "enhanced",
        enrichmentStatus: "complete",
        confidence: Number(result.confidence ?? 0.75),
        profile: {
          ...profilePatch,
          fieldsUpdated,
          gaps,
          ...(decisionMakers.length ? { decisionMakers } : {}),
        },
        profilePatch,
        profileVersion: objectRecord(result.profileVersion),
        changeSummary: String(result.changeSummary ?? body.response ?? "Pipeline enrichment profile update"),
        sources: Array.isArray(result.sources) ? result.sources : [],
        signals: Array.isArray(result.signals) ? result.signals : [],
        gaps,
        sourceSummary: Array.isArray(result.gaps) && result.gaps.length ? String(result.gaps[0]) : String(body.response ?? "Pipeline enrichment source"),
      },
    };
  }

  if (roleKey === "score_company_service_fit") {
    return {
      serviceAssessment: serviceFitAssessmentPayload({
        ...body,
        result,
      }),
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

function isFailurePipelineStatus(value: unknown) {
  return ["error", "failed", "failure"].includes(String(value ?? "").trim().toLowerCase());
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

function normalizeDuplicateStatus(value: unknown) {
  const status = String(value ?? "unknown");
  return ["unknown", "unique", "possible_duplicate", "duplicate"].includes(status) ? status : "unknown";
}

function matchingCompanyCountForJob(requestId: string) {
  const job = db.query("SELECT industry, location, company_count FROM discovery_jobs WHERE id = ?1").get(requestId) as Record<string, unknown> | null;
  if (!job) return 0;
  const created = db.query(`
    SELECT COUNT(DISTINCT c.id) AS count
    FROM companies c
    JOIN activities a
      ON a.target_type = 'company'
     AND a.target_id = c.id
     AND a.action_type = 'company_created'
    WHERE json_extract(a.payload_json, '$.requestId') = ?1
  `).get(requestId) as { count: number } | null;
  if (Number(created?.count ?? 0) > 0) return Math.max(Number(created?.count ?? 0), Number(job.company_count ?? 0));
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
  const jobRow = db.query("SELECT * FROM discovery_jobs WHERE id = ?1").get(requestId) as Record<string, unknown> | null;
  const segmentId = findTargetSegmentIdForScan(records.segmentId ?? records.targetSegmentId ?? jobRow?.segment_id ?? records.industry);
  const geographyText = String(records.geographyText ?? records.location ?? jobRow?.geography_text ?? jobRow?.location ?? "").trim();
  const geographyId = jobRow?.geography_id ? String(jobRow.geography_id) : getOrCreateTargetGeography(geographyText, now);
  const touchedCoverageSlices = new Set<string>();
  let createdCompanies = 0;
  let updatedCompanies = 0;
  let sourceRecords = 0;
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
      recordActivity("company", companyId, "pipeline", "company_matched", `Matched by scan ${requestId}`, { requestId });
      updatedCompanies += 1;
    } else {
      const dataRing = normalizeCompanyDataRing(company.dataRing ?? "found");
      db.query(`
        INSERT INTO companies(id, name, location, industry, website, data_ring, duplicate_status, enrichment_status, confidence, profile_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'not_started', ?8, '{}', ?9, ?9)
      `).run(companyId, name, location, industry, website, dataRing, normalizeDuplicateStatus(company.duplicateStatus), confidence, now);
      recordActivity("company", companyId, "pipeline", "company_created", `Created by scan ${requestId}`, { requestId });
      createdCompanies += 1;
    }

    const sourceUrl = String(company.website ?? "");
    const sourceSummary = String(company.sourceSummary ?? company.evidence ?? "Scan source");
    if (!sourceAlreadyExists(companyId, sourceUrl, sourceSummary)) {
      db.query(`
        INSERT INTO sources(id, company_id, source_type, url, summary, confidence, created_at)
        VALUES (?1, ?2, 'scan', ?3, ?4, ?5, ?6)
      `).run(crypto.randomUUID(), companyId, sourceUrl, sourceSummary, confidence, now);
      sourceRecords += 1;
    }
  }

  const possibleDuplicates = Array.isArray(records.possibleDuplicates) ? records.possibleDuplicates as Record<string, unknown>[] : [];
  for (const duplicate of possibleDuplicates) {
    for (const name of [duplicate.companyName, duplicate.possibleMatchName]) {
      const companyName = String(name ?? "").trim();
      if (!companyName) continue;
      db.query("UPDATE companies SET duplicate_status = 'possible_duplicate', updated_at = ?1 WHERE lower(name) = lower(?2)")
        .run(now, companyName);
    }
  }

  let strategyAttempts = 0;
  const slices = Array.isArray(records.searchSlices) ? records.searchSlices as Record<string, unknown>[] : [];
  for (const slice of slices) {
    const strategyType = String(slice.strategyType ?? slice.strategy ?? "search");
    const query = String(slice.query ?? "");
    const location = String(slice.location ?? records.location ?? "");
    const status = String(slice.status ?? "searched");
    if (status === "planned") continue;
    const sliceSegmentId = findTargetSegmentIdForScan(slice.segmentId ?? slice.targetSegmentId ?? segmentId ?? slice.industry ?? records.industry);
    const sliceGeographyText = String(slice.geographyText ?? slice.location ?? geographyText).trim();
    const sliceGeographyId = getOrCreateTargetGeography(sliceGeographyText, now);
    const sourceFamily = normalizeSourceFamily(slice.sourceFamily ?? slice.source_family, strategyType);
    const coverageSliceId = getOrCreateCoverageSlice({
      segmentId: sliceSegmentId,
      geographyId: sliceGeographyId,
      geographyText: sliceGeographyText,
      sourceFamily,
      strategyType,
      targetCounts: targetCountsForCoverage(sliceSegmentId, Number(jobRow?.target_count ?? 0)),
      now,
    });
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
    if (existing) {
      touchedCoverageSlices.add(coverageSliceId);
      continue;
    }
    db.query(`
      INSERT INTO scan_strategy_attempts(
        id, discovery_job_id, segment_id, geography_id, geography_text, coverage_slice_id, source_family,
        industry, location, strategy_type, query, status, result_count, notes, payload_json, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `).run(
      crypto.randomUUID(),
      requestId,
      sliceSegmentId,
      sliceGeographyId,
      sliceGeographyText,
      coverageSliceId,
      sourceFamily,
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
    touchedCoverageSlices.add(coverageSliceId);
    strategyAttempts += 1;
  }

  for (const coverageSliceId of touchedCoverageSlices) rollUpCoverageSlice(coverageSliceId, now);
  const primaryCoverageSliceId = touchedCoverageSlices.values().next().value
    ?? (jobRow?.coverage_slice_id ? String(jobRow.coverage_slice_id) : null);
  if (primaryCoverageSliceId) rollUpCoverageSlice(primaryCoverageSliceId, now);

  const companyCount = Math.max(companies.length, matchingCompanyCountForJob(requestId));
  const storedStatus = jobStatus === "complete" && companyCount < Number(jobRow?.target_count ?? 0) ? "partial" : jobStatus;
  db.query(`
    UPDATE discovery_jobs
    SET status = ?1,
        company_count = ?2,
        source_count = ?3,
        summary = ?4,
        segment_id = COALESCE(segment_id, ?5),
        geography_id = COALESCE(geography_id, ?6),
        geography_text = CASE WHEN geography_text = '' THEN ?7 ELSE geography_text END,
        coverage_slice_id = COALESCE(coverage_slice_id, ?8),
        updated_at = ?9
    WHERE id = ?10
  `).run(
    storedStatus,
    companyCount,
    sourceRecords || companyCount,
    response || (storedStatus === "complete" ? "Scan complete" : "Scan batch written"),
    segmentId,
    geographyId,
    geographyText,
    primaryCoverageSliceId,
    now,
    requestId,
  );
  return { createdCompanies, updatedCompanies, returnedCompanies: companies.length, strategyAttempts, matchingCompanies: companyCount, status: storedStatus };
}

function findKindlingRun(requestId: string, roleKey: string, token: string) {
  return db.query(`
    SELECT * FROM kindling_pipeline_runs
    WHERE local_request_id = ?1 AND role_key = ?2 AND webhook_token = ?3
    ORDER BY created_at DESC
    LIMIT 1
  `).get(requestId, roleKey, token) as Record<string, unknown> | null;
}

function persistCompanyEnrichment(input: {
  company: Record<string, unknown> | undefined;
  response: string;
  requestId: string;
  runId: string;
  now?: number;
}) {
  const company = input.company;
  const now = input.now ?? Date.now();
  const sources = Array.isArray(company?.sources) ? company.sources as Record<string, unknown>[] : [];
  const signals = Array.isArray(company?.signals) ? company.signals as Record<string, unknown>[] : [];
  const structuredActivities = Array.isArray(company?.activities) ? company.activities as Record<string, unknown>[] : [];
  const companyId = String(company?.id ?? input.requestId);
  const existing = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
  const profilePatch = {
    ...objectRecord(company?.profilePatch),
    ...objectRecord(company?.profile),
  };
  const gaps = Array.isArray(company?.gaps)
    ? company.gaps.map(String)
    : Array.isArray(profilePatch.gaps)
      ? (profilePatch.gaps as unknown[]).map(String)
      : [];
  const profile: Record<string, unknown> = {
    ...jsonParse<Record<string, unknown>>(existing?.profile_json, {}),
    ...profilePatch,
    ...(gaps.length ? { gaps } : {}),
  };
  const companyConfidence = clampConfidence(company?.confidence, 0.75);
  db.query(`
    UPDATE companies
    SET website = COALESCE(NULLIF(?1, ''), website),
        data_ring = ?2,
        enrichment_status = ?3,
        confidence = ?4,
        profile_json = ?5,
        updated_at = ?6
    WHERE id = ?7
  `).run(
    String(company?.website ?? ""),
    normalizeCompanyDataRing(company?.dataRing ?? "enhanced"),
    normalizeCompanyExecutionStatus(company?.enrichmentStatus ?? "complete"),
    companyConfidence,
    JSON.stringify(profile),
    now,
    companyId,
  );

  completeEnrichmentQueueForRequest(input.requestId, companyId, input.response || "Enrichment complete", now);

  const rawSources = sources.length ? sources : [{
    sourceType: "pipeline_enrichment",
    url: String(company?.website ?? ""),
    title: "",
    summary: String(company?.sourceSummary ?? input.response ?? "Pipeline enrichment source"),
    confidence: companyConfidence,
  }];
  const sourceIds: string[] = [];
  const sourceByRawId = new Map<string, string>();
  const sourceByUrl = new Map<string, string>();
  for (const source of rawSources) {
    const sourceId = optionalText(source.id) ?? crypto.randomUUID();
    const sourceType = normalizeSourceType(source.sourceType ?? source.source_type);
    const url = String(source.url ?? source.sourceUrl ?? source.source_url ?? "").trim();
    const title = optionalText(source.title);
    const extractedData = objectRecord(source.extractedData ?? source.extracted_data ?? source.extractedDataJson);
    db.query(`
      INSERT OR REPLACE INTO sources(
        id, company_id, source_type, url, title, summary, extracted_data_json, confidence,
        last_checked_at, last_checked_by_run_id, terms_notes, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `).run(
      sourceId,
      companyId,
      sourceType,
      url,
      title,
      String(source.summary ?? source.description ?? source.title ?? "Pipeline enrichment source"),
      JSON.stringify(extractedData),
      clampConfidence(source.confidence, companyConfidence),
      optionalTimestamp(source.lastCheckedAt ?? source.last_checked_at),
      optionalText(source.lastCheckedByRunId ?? source.last_checked_by_run_id ?? input.runId),
      String(source.termsNotes ?? source.terms_notes ?? ""),
      now,
    );
    sourceIds.push(sourceId);
    const rawId = optionalText(source.id);
    if (rawId) sourceByRawId.set(rawId, sourceId);
    if (url) sourceByUrl.set(url, sourceId);
  }

  const signalIds: string[] = [];
  for (const signal of signals) {
    const sourceUrl = String(signal.sourceUrl ?? signal.source_url ?? "").trim();
    const requestedSourceId = optionalText(signal.sourceId ?? signal.source_id);
    const knownRequestedSource = requestedSourceId && !sourceByRawId.has(requestedSourceId)
      ? db.query("SELECT id FROM sources WHERE id = ?1 AND company_id = ?2").get(requestedSourceId, companyId) as Record<string, unknown> | null
      : null;
    const sourceId = requestedSourceId
      ? sourceByRawId.get(requestedSourceId) ?? requestedSourceId
      : sourceUrl
        ? sourceByUrl.get(sourceUrl) ?? null
        : null;
    const linkedSourceId = sourceId && (sourceByRawId.has(sourceId) || sourceIds.includes(sourceId) || knownRequestedSource) ? sourceId : null;
    const evidence = {
      ...objectRecord(signal.evidence),
      sourceIds: Array.isArray(signal.sourceIds) ? signal.sourceIds : linkedSourceId ? [linkedSourceId] : [],
      sourceUrl,
    };
    const hasEvidence = Boolean(linkedSourceId || sourceUrl || (Array.isArray(signal.evidence) && signal.evidence.length) || Object.keys(objectRecord(signal.evidence)).length);
    const inputConfidence = clampConfidence(signal.confidence, hasEvidence ? companyConfidence : 0.25);
    const confidence = hasEvidence ? inputConfidence : Math.min(inputConfidence, 0.4);
    const evidenceJson = hasEvidence
      ? evidence
      : { ...evidence, lowConfidenceReason: "No source evidence supplied by enrichment output" };
    const signalId = optionalText(signal.id) ?? crypto.randomUUID();
    db.query(`
      INSERT OR REPLACE INTO signals(
        id, company_id, signal_type, summary, source_id, source_url, observed_date, strength,
        confidence, adapt_relevance, evidence_json, created_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `).run(
      signalId,
      companyId,
      normalizeSourceType(signal.signalType ?? signal.signal_type ?? signal.type ?? "general"),
      String(signal.summary ?? signal.description ?? ""),
      linkedSourceId,
      sourceUrl,
      optionalText(signal.observedDate ?? signal.observed_date),
      normalizeSignalStrength(signal.strength, confidence),
      confidence,
      String(signal.adaptRelevance ?? signal.adapt_relevance ?? ""),
      JSON.stringify(evidenceJson),
      now,
    );
    signalIds.push(signalId);
  }

  const activityIds: string[] = [];
  for (const activity of structuredActivities) {
    activityIds.push(recordActivity(
      String(activity.targetType ?? activity.target_type ?? "company"),
      String(activity.targetId ?? activity.target_id ?? companyId),
      String(activity.actor ?? "pipeline"),
      String(activity.actionType ?? activity.action_type ?? "company_enhanced"),
      String(activity.summary ?? input.response ?? "Structured enrichment activity"),
      objectRecord(activity.payload ?? activity.payload_json),
    ));
  }
  activityIds.push(recordActivity("company", companyId, "pipeline", "company_enhanced", input.response || "Enrichment complete", {
    requestId: input.requestId,
    runId: input.runId,
    confidence: companyConfidence,
    sourceIds,
    signalIds,
    gaps,
    fieldsUpdated: Array.isArray(profile.fieldsUpdated) ? profile.fieldsUpdated : [],
  }));

  db.query(`
    UPDATE customer_profile_versions
    SET status = 'archived'
    WHERE company_id = ?1 AND status = 'active'
  `).run(companyId);
  const versionNumber = Number((db.query(`
    SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
    FROM customer_profile_versions
    WHERE company_id = ?1
  `).get(companyId) as Record<string, unknown> | null)?.version_number ?? 1);
  const profileVersionId = optionalText(objectRecord(company?.profileVersion).id) ?? crypto.randomUUID();
  db.query(`
    INSERT OR REPLACE INTO customer_profile_versions(
      id, company_id, version_number, status, profile_json, change_summary,
      source_ids_json, activity_ids_json, created_by, created_at
    )
    VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, 'pipeline', ?8)
  `).run(
    profileVersionId,
    companyId,
    versionNumber,
    JSON.stringify(objectRecord(company?.profileVersion).profile ?? profile),
    String(company?.changeSummary ?? objectRecord(company?.profileVersion).changeSummary ?? input.response ?? "Pipeline enrichment profile update"),
    JSON.stringify(sourceIds),
    JSON.stringify(activityIds),
    now,
  );

  return { companyId, sourceCount: sourceIds.length, signalCount: signalIds.length, profileVersionId, activityCount: activityIds.length };
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
  if (alreadyApplied) return { ok: true as const };
  let storedStatus = String(body.status ?? "complete");
  let storedError = "";
  const callbackFailed = isFailurePipelineStatus(storedStatus);

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
    replaceServiceOfferingsForMarketProfileVersion(versionId, objectRecord(versionRecord?.structured), now);
    recordActivity("market_profile", profileId, "pipeline", "profile_version_created", String(body.response ?? "Service offering updated"), { runId: run.id });
  }

  if (!alreadyApplied && roleKey === "scan_target_list") {
    if (callbackFailed) {
      storedStatus = "failed";
      storedError = String(body.error ?? body.response ?? "Target scan failed");
      markSchedulerAcquisitionFailed(requestId, storedError, {
        source: "final_webhook",
        webhookStatus: String(body.status ?? ""),
      });
    } else {
      const persisted = persistScanRecords(requestId, records, String(body.response ?? "Scan complete"), "complete");
      updateSchedulerRunForRequest({
        requestId,
        status: "complete",
        autopilotRunId: String(body.runId ?? "") || null,
        result: {
          terminalStatus: storedStatus,
          persisted,
          retryable: false,
          source: "final_webhook",
        },
        finish: true,
        releaseLock: true,
      });
    }
  }

  if (!alreadyApplied && roleKey === "enrich_company") {
    if (callbackFailed) {
      storedStatus = "failed";
      storedError = String(body.error ?? body.response ?? "Company enrichment failed");
      failEnrichmentQueueForRequest(requestId, storedError, now);
      updateSchedulerRunForRequest({
        requestId,
        roleKey: "enrich_company",
        status: "failed",
        error: storedError,
        finish: true,
        releaseLock: false,
      });
    } else {
      const company = records.company as Record<string, unknown> | undefined;
      persistCompanyEnrichment({
        company,
        response: String(body.response ?? "Enrichment complete"),
        requestId,
        runId: String(run.id),
        now,
      });
      updateSchedulerRunForRequest({
        requestId,
        roleKey: "enrich_company",
        status: "complete",
        autopilotRunId: String(body.runId ?? "") || null,
        result: {
          terminalStatus: storedStatus,
          source: "final_webhook",
        },
        finish: true,
        releaseLock: false,
      });
    }
  }

  if (!alreadyApplied && roleKey === "enrich_industry_segment") {
    const result = objectRecord(body.result);
    const finalized = finalizeIndustryEnrichmentBatch(
      run,
      callbackFailed ? "failed" : "complete",
      callbackFailed
        ? String(body.error ?? body.response ?? "Industry enrichment batch failed")
        : "Pipeline completed without writing enrichment for this company",
      now,
    );
    storedStatus = finalized.status;
    storedError = finalized.error;
    recordActivity(
      "industry",
      requestId,
      "pipeline",
      "industry_enrichment_batch_complete",
      String(body.response ?? `Industry enrichment batch complete for ${String(result.industry ?? "industry segment")}`),
      { requestId, runId: run.id },
    );
  }

  if (!alreadyApplied && roleKey === "score_company_service_fit") {
    if (callbackFailed) {
      storedStatus = "failed";
      storedError = String(body.error ?? body.response ?? "Service fit assessment failed");
      db.query(`
        UPDATE work_queue
        SET status = 'failed',
            error = ?1,
            updated_at = ?2
        WHERE id = ?3
          AND kind = 'service_fit_assessment'
      `).run(storedError, now, requestId);
      updateSchedulerRunForRequest({
        requestId,
        roleKey: "score_company_service_fit",
        status: "failed",
        error: storedError,
        finish: true,
        releaseLock: true,
      });
    } else {
      const assessment = records.serviceAssessment as Record<string, unknown> | undefined;
      if (assessment?.companyId || Array.isArray(objectRecord(body.result).assessments)) {
        const persisted = persistServiceFitAssessmentBatch({
          body: Array.isArray(objectRecord(body.result).assessments) ? body : { ...body, result: assessment },
          run,
          now,
        });
        if (!persisted.ok) {
          storedStatus = "failed";
          storedError = persisted.error;
          db.query(`
            UPDATE work_queue
            SET status = 'failed',
                error = ?1,
                updated_at = ?2
            WHERE id = ?3
              AND kind = 'service_fit_assessment'
          `).run(storedError, now, requestId);
          updateSchedulerRunForRequest({
            requestId,
            roleKey: "score_company_service_fit",
            status: "failed",
            error: storedError,
            finish: true,
            releaseLock: true,
          });
        } else {
          updateSchedulerRunForRequest({
            requestId,
            roleKey: "score_company_service_fit",
            status: "complete",
            autopilotRunId: String(body.runId ?? "") || null,
            result: {
              terminalStatus: storedStatus,
              assessmentCount: persisted.assessments.length,
              rebuiltTopTargets: true,
              source: "final_webhook",
            },
            finish: true,
            releaseLock: true,
          });
        }
      }
    }
  }

  if (!alreadyApplied && roleKey === "draft_outreach") {
    if (callbackFailed) {
      storedStatus = "failed";
      storedError = String(body.error ?? body.response ?? "Outreach drafting failed");
      updateSchedulerRunForRequest({
        requestId,
        roleKey: "draft_outreach",
        status: "failed",
        error: storedError,
        finish: true,
        releaseLock: false,
      });
    } else {
      const draft = records.outreachDraft as Record<string, unknown> | undefined;
      const companyId = String(draft?.companyId ?? requestId);
      db.query(`
        INSERT INTO outreach_drafts(id, company_id, pitch_text, status, source_run_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?5)
      `).run(crypto.randomUUID(), companyId, String(draft?.pitchText ?? body.response ?? ""), String(run.id), now);
      recordActivity("company", companyId, "pipeline", "outreach_drafted", String(body.response ?? "Outreach drafted"), { requestId });
      updateSchedulerRunForRequest({
        requestId,
        roleKey: "draft_outreach",
        status: "complete",
        autopilotRunId: String(body.runId ?? "") || null,
        result: {
          terminalStatus: storedStatus,
          companyId,
          source: "final_webhook",
        },
        finish: true,
        releaseLock: false,
      });
    }
  }

  db.query(`
    UPDATE kindling_pipeline_runs
    SET status = ?1,
        autopilot_run_id = COALESCE(?2, autopilot_run_id),
        result_payload_json = ?3,
        error = CASE WHEN ?4 = '' THEN error ELSE ?4 END,
        updated_at = ?5
    WHERE id = ?6
  `).run(storedStatus, String(body.runId ?? "") || null, JSON.stringify(body), storedError, now, String(run.id));
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

function firstForwardedHeaderValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function requestPublicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = firstForwardedHeaderValue(req.headers.get("x-forwarded-host"));
  const proto = firstForwardedHeaderValue(req.headers.get("x-forwarded-proto"));
  if (host) url.host = host;
  if (proto === "http" || proto === "https") url.protocol = `${proto}:`;
  return url.origin;
}

function webhookOrigin(req: Request): string {
  return PUBLIC_ORIGIN || requestPublicOrigin(req);
}

async function runAutomatedAcquisitionLoop() {
  const now = Date.now();
  const settings = getSchedulerSettings();
  if (!settings.enabled || !settings.acquisitionEnabled) return null;
  if (activeSchedulerLock(now, "acquisition")) return null;
  if (recentSchedulerLaunch("acquisition", "scan_target_list", Math.max(0, Number(settings.cooldowns.acquisitionMs ?? 0)), now)) {
    return null;
  }
  const concurrency = roleConcurrencyState("scan_target_list", settings);
  if (concurrency.blockedReason) return null;
  const acquisitionSelection = selectAcquisitionDryRun(settings, now, { preferExploration: true });
  if (!acquisitionSelection.item) {
    return null;
  }
  const decision = {
    dryRun: false,
    workAvailable: true,
    action: "acquisition" as const,
    roleKey: "scan_target_list",
    item: acquisitionSelection.item,
    reason: acquisitionSelection.reason,
    evaluatedRoles: [{
      action: "acquisition" as const,
      roleKey: "scan_target_list",
      status: "selected" as const,
      reason: acquisitionSelection.reason,
      activeCount: concurrency.activeCount,
      concurrencyLimit: concurrency.concurrencyLimit,
    }],
    activeLock: null,
  };

  const schedulerRun = createSchedulerRun({
    runType: "scheduled",
    status: "running",
    selectedAction: "acquisition",
    roleKey: "scan_target_list",
    lockKey: "acquisition",
    context: {
      dryRun: false,
      automated: true,
      evaluatedRoles: decision.evaluatedRoles,
      selectedAcquisitionWork: decision.item,
    },
    result: {
      dryRun: false,
      automated: true,
      decision,
    },
    startedAt: now,
    now,
  });
  const lock = acquireSchedulerLock({
    runId: schedulerRun.id,
    ownerId: "scheduler:auto-acquisition",
    lockKey: "acquisition",
    leaseMs: 60 * 1000,
    now,
  });
  if (!lock) {
    db.query(`
      UPDATE scheduler_runs
      SET status = 'skipped',
          skip_reason = 'scheduler lock acquisition could not be acquired',
          finished_at = ?1,
          updated_at = ?1
      WHERE id = ?2
    `).run(Date.now(), schedulerRun.id);
    return null;
  }

  const acquisitionJob = buildScheduledAcquisitionJob({
    item: decision.item,
    decision,
    schedulerRunId: schedulerRun.id,
    origin: scheduledKindlingOrigin(),
    automated: true,
    session: { pubkey: "scheduler", npub: "scheduler" },
  });
  try {
    const start = await startKindlingRun(acquisitionJob.kindlingRunId);
    releaseSchedulerLock("acquisition", schedulerRun.id);
    return {
      schedulerRunId: schedulerRun.id,
      runId: acquisitionJob.kindlingRunId,
      jobId: acquisitionJob.jobId,
      acquisition: {
        coverageSliceId: acquisitionJob.coverageSliceId,
        targetCount: acquisitionJob.targetCount,
        scanMode: acquisitionJob.scanMode,
        correlation: acquisitionJob.correlation,
      },
      start,
    };
  } catch {
    releaseSchedulerLock("acquisition", schedulerRun.id);
    return null;
  }
}

async function runAutomatedScoringLoop() {
  const now = Date.now();
  const settings = getSchedulerSettings();
  if (!settings.enabled || !settings.scoringEnabled) return null;
  if (recentSchedulerLaunch("scoring", "score_company_service_fit", Math.max(0, Number(settings.cooldowns.scoringMs ?? 0)), now)) {
    return null;
  }
  const topTargets = getOrBuildTopTargetDetail(settings.topTargetCount || 100);
  const rankedCount = Number(topTargets.run?.rankedCount ?? topTargets.items?.length ?? 0);
  if (rankedCount >= settings.topTargetCount) return null;

  const concurrency = roleConcurrencyState("score_company_service_fit", settings);
  if (concurrency.blockedReason) return null;
  const activeScoring = listActiveScoringOfferings();
  const marketProfileVersionId = activeScoring.profile?.currentVersionId ?? "";
  const offeringCount = activeScoring.offerings.length;
  if (!marketProfileVersionId || !offeringCount) return null;
  const availableSlots = Math.min(SCHEDULED_SCORING_BATCH_LIMIT, Math.max(0, concurrency.concurrencyLimit - concurrency.activeCount));
  const companies = selectScoringCandidateRows(marketProfileVersionId, offeringCount, availableSlots);
  if (!companies.length) {
    return null;
  }

  const startedRuns: Array<Record<string, unknown>> = [];
  for (const company of companies) {
    const item = { kind: "company", company: mapCompany(company) };
    const decision = {
      dryRun: false,
      workAvailable: true,
      action: "scoring",
      roleKey: "score_company_service_fit",
      item,
      reason: `company ${String(company.name ?? company.id)} is enriched and needs scoring against ${offeringCount} offering${offeringCount === 1 ? "" : "s"}`,
      evaluatedRoles: [{
        action: "scoring",
        roleKey: "score_company_service_fit",
        status: "selected",
        reason: "automated scoring batch selected company",
        activeCount: concurrency.activeCount + startedRuns.length,
        concurrencyLimit: concurrency.concurrencyLimit,
      }],
      activeLock: activeSchedulerLock(now),
    };
    const schedulerRun = createSchedulerRun({
      runType: "scheduled",
      status: "running",
      selectedAction: "scoring",
      roleKey: "score_company_service_fit",
      lockKey: "scoring",
      context: {
        dryRun: false,
        automated: true,
        scoringBatch: true,
        selectedScoringWork: item,
      },
      result: {
        dryRun: false,
        automated: true,
        scoringBatch: true,
        decision,
      },
      startedAt: now,
      now,
    });
    const scoringRun = createServiceFitScoringRun({
      company,
      origin: scheduledKindlingOrigin(),
      userPubkey: "scheduler",
      userNpub: "scheduler",
      reason: `Scheduled scoring: ${String(company.name ?? company.id)} against active Adapt service offerings`,
      now,
    });
    db.query(`
      UPDATE scheduler_runs
      SET local_request_id = ?1,
          result_json = ?2,
          updated_at = ?3
      WHERE id = ?4
    `).run(
      scoringRun.requestId,
      JSON.stringify({ dryRun: false, automated: true, scoringBatch: true, decision, scoringRun: { requestId: scoringRun.requestId, queueId: scoringRun.queueId, offeringCount: scoringRun.offeringCount } }),
      Date.now(),
      schedulerRun.id,
    );
    try {
      const start = await startKindlingRun(scoringRun.runId);
      db.query(`
        UPDATE work_queue
        SET status = 'running',
            attempts = attempts + 1,
            locked_by_run_id = ?1,
            updated_at = ?2
        WHERE id = ?3
      `).run(scoringRun.runId, Date.now(), scoringRun.queueId);
      startedRuns.push({ schedulerRunId: schedulerRun.id, runId: scoringRun.runId, requestId: scoringRun.requestId, queueId: scoringRun.queueId, start });
    } catch (error) {
      updateSchedulerRunForRequest({
        requestId: scoringRun.requestId,
        roleKey: "score_company_service_fit",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finish: true,
        releaseLock: false,
      });
    }
  }
  return startedRuns.length ? { count: startedRuns.length, runs: startedRuns } : null;
}

function ensureQueuedEnrichmentRequest(input: {
  queueId: string;
  companyId: string;
  requestKind: string;
  reason: string;
  now: number;
}) {
  const existing = db.query(`
    SELECT *
    FROM enrichment_requests
    WHERE COALESCE(NULLIF(work_queue_id, ''), id) = ?1
    ORDER BY created_at DESC
    LIMIT 1
  `).get(input.queueId) as Record<string, unknown> | null;
  if (existing) {
    db.query(`
      UPDATE enrichment_requests
      SET status = 'queued',
          summary = ?1,
          updated_at = ?2
      WHERE id = ?3
    `).run(input.reason, input.now, String(existing.id));
    return String(existing.id);
  }
  db.query(`
    INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at)
    VALUES (?1, ?2, ?1, 'queued', ?3, ?4, ?5, ?5)
  `).run(input.queueId, input.companyId, input.requestKind, input.reason, input.now);
  return input.queueId;
}

async function runAutomatedEnrichmentLoop() {
  const now = Date.now();
  const settings = getSchedulerSettings();
  if (!settings.enabled || !settings.enrichmentEnabled) return null;
  if (recentSchedulerLaunch("enrichment", "enrich_company", Math.max(0, Number(settings.cooldowns.enrichmentMs ?? 0)), now)) {
    return null;
  }
  const concurrency = roleConcurrencyState("enrich_company", settings);
  if (concurrency.blockedReason) return null;
  const selection = selectEnrichmentDryRun(settings);
  if (!selection.item) return null;
  const item = selection.item;
  const decision = {
    dryRun: false,
    workAvailable: true,
    action: "enrichment",
    roleKey: "enrich_company",
    item,
    reason: selection.reason,
  };
  const company = objectRecord(item.company);
  const companyId = String(company.id ?? "");
  if (!companyId) return null;
  const queueItem = objectRecord(item.queueItem);
  const queueId = queueItem.id
    ? String(queueItem.id)
    : createCompanyEnrichmentQueueItem({
      companyId,
      requestKind: "scheduled",
      reason: `Scheduled enrichment requested for ${String(company.name ?? companyId)}`,
      priority: 20,
      context: { source: "automated_enrichment_loop" },
      now,
    });
  const requestId = ensureQueuedEnrichmentRequest({
    queueId,
    companyId,
    requestKind: "scheduled",
    reason: `Scheduled enrichment requested for ${String(company.name ?? companyId)}`,
    now,
  });
  db.query(`
    UPDATE work_queue
    SET status = 'queued',
        error = '',
        next_run_after_at = NULL,
        locked_by_run_id = NULL,
        updated_at = ?1
    WHERE id = ?2
      AND kind = 'company_enrichment'
  `).run(now, queueId);
  db.query("UPDATE companies SET enrichment_status = 'queued', updated_at = ?1 WHERE id = ?2 AND enrichment_status IN ('not_started', 'failed')")
    .run(now, companyId);

  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const origin = scheduledKindlingOrigin();
  const triggerRequest = buildKindlingTriggerRequest({
    roleKey: "enrich_company",
    localRequestId: requestId,
    message: `Enrich ${String(company.name ?? companyId)}`,
    context: {
      companyId,
      companyName: String(company.name ?? ""),
      website: String(company.website ?? ""),
      industry: String(company.industry ?? ""),
      location: String(company.location ?? ""),
      scheduler: { action: "enrichment", roleKey: "enrich_company" },
    },
    webhookUrl: `${origin}/api/kindling/pipeline-webhook`,
    webhookToken,
    userPubkey: "scheduler",
    userNpub: "scheduler",
  });
  const runId = createKindlingRun({ roleKey: "enrich_company", localRequestId: requestId, triggerRequest, status: "queued" });
  attachEnrichmentQueueToRun([queueId], runId, now);
  const schedulerRun = createSchedulerRun({
    runType: "scheduled",
    status: "running",
    selectedAction: "enrichment",
    roleKey: "enrich_company",
    localRequestId: requestId,
    lockKey: "enrichment",
    context: {
      dryRun: false,
      automated: true,
      selectedEnrichmentWork: item,
    },
    result: {
      dryRun: false,
      automated: true,
      decision,
      enrichmentRun: { requestId, queueId },
    },
    startedAt: now,
    now,
  });

  try {
    const start = await startKindlingRun(runId);
    return { schedulerRunId: schedulerRun.id, runId, requestId, queueId, companyId, start };
  } catch (error) {
    updateSchedulerRunForRequest({
      requestId,
      roleKey: "enrich_company",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finish: true,
      releaseLock: false,
    });
    return null;
  }
}

async function runAutomatedOutreachLoop() {
  const now = Date.now();
  const settings = getSchedulerSettings();
  if (!settings.enabled || !settings.outreachEnabled) return null;
  if (recentSchedulerLaunch("outreach", "draft_outreach", Math.max(0, Number(settings.cooldowns.outreachMs ?? 0)), now)) {
    return null;
  }
  const concurrency = roleConcurrencyState("draft_outreach", settings);
  if (concurrency.blockedReason) return null;
  const selection = selectOutreachDryRun(settings);
  if (!selection.item) return null;
  const company = objectRecord(objectRecord(selection.item).company);
  const companyId = String(company.id ?? "");
  if (!companyId) return null;

  const requestId = crypto.randomUUID();
  const webhookToken = crypto.randomUUID().replaceAll("-", "");
  const origin = scheduledKindlingOrigin();
  const triggerRequest = buildKindlingTriggerRequest({
    roleKey: "draft_outreach",
    localRequestId: requestId,
    message: `Draft outreach for ${String(company.name ?? companyId)}`,
    context: {
      companyId,
      companyName: String(company.name ?? ""),
      company,
      activeProfileVersion: getCurrentMarketProfile()?.version ?? null,
      profile: getCurrentMarketProfile(),
      scheduler: { action: "outreach", roleKey: "draft_outreach" },
    },
    webhookUrl: `${origin}/api/kindling/pipeline-webhook`,
    webhookToken,
    userPubkey: "scheduler",
    userNpub: "scheduler",
  });
  const runId = createKindlingRun({ roleKey: "draft_outreach", localRequestId: requestId, triggerRequest, status: "queued" });
  const schedulerRun = createSchedulerRun({
    runType: "scheduled",
    status: "running",
    selectedAction: "outreach",
    roleKey: "draft_outreach",
    localRequestId: requestId,
    lockKey: "outreach",
    context: {
      dryRun: false,
      automated: true,
      selectedOutreachWork: selection.item,
    },
    result: {
      dryRun: false,
      automated: true,
      decision: {
        dryRun: false,
        workAvailable: true,
        action: "outreach",
        roleKey: "draft_outreach",
        item: selection.item,
        reason: selection.reason,
      },
    },
    startedAt: now,
    now,
  });

  try {
    const start = await startKindlingRun(runId);
    return { schedulerRunId: schedulerRun.id, runId, requestId, companyId, start };
  } catch (error) {
    updateSchedulerRunForRequest({
      requestId,
      roleKey: "draft_outreach",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      finish: true,
      releaseLock: false,
    });
    return null;
  }
}

export async function runAutomatedProspectingLoop() {
  await reconcileActiveKindlingRuns();
  reconcileSchedulerState();
  const results: Array<Record<string, unknown>> = [];
  const acquisition = await runAutomatedAcquisitionLoop();
  if (acquisition) results.push({ action: "acquisition", ...acquisition });
  const enrichment = await runAutomatedEnrichmentLoop();
  if (enrichment) results.push({ action: "enrichment", ...enrichment });
  const scoring = await runAutomatedScoringLoop();
  if (scoring) results.push({ action: "scoring", ...scoring });
  const outreach = await runAutomatedOutreachLoop();
  if (outreach) results.push({ action: "outreach", ...outreach });
  if (!results.length) return null;
  if (results.length === 1) return results[0];
  return { action: "multi", count: results.length, results };
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
    const compact = url.searchParams.get("compact") === "1" || url.searchParams.get("compact") === "true";
    if (!compact) await reconcileActiveKindlingRuns();
    const companies = compact ? [] : listCompanies(null, { limit: COMPANY_LIST_LIMIT, offset: 0 });
    const recentRuns = (db.query("SELECT * FROM kindling_pipeline_runs ORDER BY updated_at DESC LIMIT 12").all() as Record<string, unknown>[]).map(mapRun);
    const discoveryJobs = (db.query("SELECT * FROM discovery_jobs ORDER BY updated_at DESC LIMIT 8").all() as Record<string, unknown>[]).map(mapDiscoveryJob);
    const coverage = compact ? buildLightCoverageSummary(25) : buildCoverageSummary();
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
      coverage,
      counts: {
        companies: countCompanies(),
        enriched: countEnrichedCompanies(),
        scored: countScoredCompanies(),
        serviceFitAssessments: countServiceFitAssessments(),
        outreachReady: countOutreachReadyCompanies(),
        workQueue: workQueueCounts(),
        activeRuns: recentRuns.filter((run) => ["queued", "running", "mock"].includes(run.status)).length,
        coverage: coverage.totals,
        coverageExecutedAttempts: coverage.attempts.executed,
        coverageRecommendedStrategies: coverage.attempts.recommended,
      },
      companyList: {
        returned: companies.length,
        total: countCompanies(),
        limit: COMPANY_LIST_LIMIT,
      },
      compact,
    });
  }

  if (pathname === "/api/kindling/enrichment-industries" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const industryPage = listEnrichmentIndustries(url.searchParams);
    return json({
      ...industryPage,
      batchLimit: INDUSTRY_ENRICHMENT_BATCH_LIMIT,
      strategies: INDUSTRY_ENRICHMENT_STRATEGIES,
    });
  }

  if (pathname === "/api/kindling/work-queue" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json(listWorkQueueItems(url.searchParams));
  }

  if (pathname === "/api/kindling/work-queue/clear-failed" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const kind = typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : undefined;
    const result = clearFailedWorkQueueItems({ kind });
    recordActivity("work_queue", kind ?? "all", "user", "work_queue_failed_cleared", `Cleared ${result.cleared} failed queue item${result.cleared === 1 ? "" : "s"}`, {
      pubkey: session.pubkey,
      kind: kind ?? null,
      byKind: result.byKind,
    });
    return json({ ...result, counts: workQueueCounts() });
  }

  const retryQueueMatch = pathname.match(/^\/api\/kindling\/work-queue\/([^/]+)\/retry$/);
  if (retryQueueMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const id = decodeURIComponent(retryQueueMatch[1]!);
    const retried = retryWorkQueueItem(id);
    if (retried === null) return json({ error: "queue item not found" }, 404);
    if (retried === false) return json({ error: "only failed or cancelled queue items can be retried" }, 409);
    recordActivity("work_queue", id, "user", "work_queue_retry", "Enrichment queue item retried", { pubkey: session.pubkey });
    return json({ item: mapWorkQueueItem(retried) });
  }

  const enrichIndustryMatch = pathname.match(/^\/api\/kindling\/enrichment-industries\/([^/]+)\/enrich$/);
  if (enrichIndustryMatch && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const industry = decodeURIComponent(enrichIndustryMatch[1]!).trim();
    if (!industry) return json({ error: "industry is required" }, 400);
    const limit = normaliseIndustryBatchLimit(body.limit);
    const companies = listCompaniesForIndustryEnrichment(industry, limit);
    if (!companies.length) return json({ error: "no unprocessed companies for this industry" }, 409);

    const now = Date.now();
    const batchId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const companyIds = companies.map((company) => company.id);
    const queueIds: string[] = [];
    for (const company of companies) {
      const requestId = crypto.randomUUID();
      const summary = `Queued by industry batch ${batchId}`;
      const queueId = createCompanyEnrichmentQueueItem({
        id: requestId,
        companyId: company.id,
        requestKind: "industry_batch",
        reason: summary,
        priority: 50,
        context: { batchId, industry, source: "industry_enrichment_endpoint" },
        now,
      });
      queueIds.push(queueId);
      db.query("INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, summary, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', 'industry_batch', ?4, ?5, ?5)")
        .run(requestId, company.id, queueId, summary, now);
    }
    const placeholders = companyIds.map((_, index) => `?${index + 2}`).join(", ");
    db.query(`UPDATE companies SET enrichment_status = 'queued', updated_at = ?1 WHERE id IN (${placeholders})`)
      .run(now, ...companyIds);

    const batchCompanies = companies.map((company) => ({
      ...company,
      knownSources: knownSourcesForCompany(company.id),
    }));
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "enrich_industry_segment",
      localRequestId: batchId,
      message: `Enrich up to ${companies.length} ${industry} companies`,
      context: {
        batchId,
        industry,
        batchSize: companies.length,
        batchLimit: INDUSTRY_ENRICHMENT_BATCH_LIMIT,
        companies: batchCompanies,
        enrichmentStrategies: INDUSTRY_ENRICHMENT_STRATEGIES,
        activeProfileVersion: getCurrentMarketProfile()?.version ?? null,
        writeApi: {
          url: `${webhookOrigin(req)}/api/kindling/pipeline-write/enrichment-company`,
          token: webhookToken,
          authHeader: "x-kindling-pipeline-token",
          batchRequestId: batchId,
        },
      },
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "enrich_industry_segment", localRequestId: batchId, triggerRequest, status: "queued" });
    attachEnrichmentQueueToRun(queueIds, runId, now);
    if (shouldDeferKindlingAutopilotAuth(body, "enrich_industry_segment")) {
      return json({ requiresAutopilotAuth: true, runId, batchId, industry, batchSize: companies.length, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    return json({ runId, batchId, industry, batchSize: companies.length, triggerRequest }, 201);
  }

  const discoveryJobMatch = pathname.match(/^\/api\/kindling\/discovery-jobs\/([^/]+)$/);
  if (discoveryJobMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    await reconcileActiveKindlingRuns();
    const detail = getDiscoveryJobDetail(decodeURIComponent(discoveryJobMatch[1]!));
    if (!detail) return json({ error: "discovery job not found" }, 404);
    return json(detail);
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

  if (pathname === "/api/kindling/scheduler-settings" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({
      settings: getSchedulerSettings(),
      recentRuns: listSchedulerRuns(20),
      activeLock: getSchedulerLock("prospecting"),
    });
  }

  if (pathname === "/api/kindling/scheduler/preview" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    return json({
      decision: computeProspectingLoopDecision(Date.now()),
      settings: getSchedulerSettings(),
      activeLock: getSchedulerLock("prospecting"),
    });
  }

  if (pathname === "/api/kindling/scheduler-settings" && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const settings = updateSchedulerSettings(schedulerSettingsPatchFromBody(body));
    recordActivity("scheduler", "default", "user", "scheduler_settings_updated", "Scheduler settings updated", { pubkey: session.pubkey });
    return json({
      settings,
      recentRuns: listSchedulerRuns(20),
      activeLock: getSchedulerLock("prospecting"),
    });
  }

  if (pathname === "/api/kindling/scheduler/run-once" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const dryRun = url.searchParams.get("dryRun") === "true";
    const now = Date.now();
    const decision = dryRun ? computeSchedulerDryRunDecision(now) : computeProspectingLoopDecision(now);
    if (!dryRun) {
      const body = await readJson(req);
      if (decision.workAvailable && decision.action === "scoring" && decision.roleKey === "score_company_service_fit" && decision.item) {
        const schedulerRun = createSchedulerRun({
          runType: "scheduled",
          status: "running",
          selectedAction: "scoring",
          roleKey: "score_company_service_fit",
          context: {
            dryRun: false,
            userPubkey: session.pubkey,
            evaluatedRoles: decision.evaluatedRoles,
            selectedScoringWork: decision.item,
          },
          result: {
            dryRun: false,
            decision,
          },
          startedAt: now,
          now,
        });
        const lock = acquireSchedulerLock({
          runId: schedulerRun.id,
          ownerId: `scheduler:${session.pubkey.slice(0, 16)}`,
          leaseMs: Math.max(10 * 60 * 1000, Number(getSchedulerSettings().cooldowns.scoringMs ?? 0)),
          now,
        });
        if (!lock) {
          const reason = "scheduler lock prospecting could not be acquired";
          db.query(`
            UPDATE scheduler_runs
            SET status = 'skipped',
                skip_reason = ?1,
                result_json = ?2,
                finished_at = ?3,
                updated_at = ?3
            WHERE id = ?4
          `).run(reason, JSON.stringify({ dryRun: false, decision, lockAcquired: false }), Date.now(), schedulerRun.id);
          return json({
            dryRun: false,
            decision: { ...decision, dryRun: false, workAvailable: false, reason },
            run: listSchedulerRuns(1)[0],
            settings: getSchedulerSettings(),
            recentRuns: listSchedulerRuns(20),
            activeLock: activeSchedulerLock(Date.now()),
          }, 409);
        }
        const item = objectRecord(decision.item);
        const company = objectRecord(item.company);
        const scoringRun = createServiceFitScoringRun({
          company,
          origin: webhookOrigin(req),
          userPubkey: session.pubkey,
          userNpub: pubkeyToNpub(session.pubkey),
          reason: `Scheduled scoring: ${String(company.name ?? company.id)} against active Adapt service offerings`,
          now,
        });
        db.query(`
          UPDATE scheduler_runs
          SET local_request_id = ?1,
              result_json = ?2,
              updated_at = ?3
          WHERE id = ?4
        `).run(
          scoringRun.requestId,
          JSON.stringify({ dryRun: false, decision, scoringRun: { requestId: scoringRun.requestId, queueId: scoringRun.queueId, offeringCount: scoringRun.offeringCount } }),
          Date.now(),
          schedulerRun.id,
        );
        if (shouldDeferKindlingAutopilotAuth(body, "score_company_service_fit")) {
          return json({
            dryRun: false,
            decision: { ...decision, dryRun: false },
            run: listSchedulerRuns(1)[0],
            lock,
            requiresAutopilotAuth: true,
            runId: scoringRun.runId,
            requestId: scoringRun.requestId,
            queueId: scoringRun.queueId,
            offeringCount: scoringRun.offeringCount,
            triggerRequest: scoringRun.triggerRequest,
            settings: getSchedulerSettings(),
            recentRuns: listSchedulerRuns(20),
            activeLock: activeSchedulerLock(Date.now()),
          }, 202);
        }
        try {
          const start = await startKindlingRun(
            scoringRun.runId,
            typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "",
          );
          db.query(`
            UPDATE work_queue
            SET status = 'running',
                attempts = attempts + 1,
                locked_by_run_id = ?1,
                updated_at = ?2
            WHERE id = ?3
          `).run(scoringRun.runId, Date.now(), scoringRun.queueId);
          return json({
            dryRun: false,
            decision: { ...decision, dryRun: false },
            run: listSchedulerRuns(1)[0],
            lock,
            start,
            runId: scoringRun.runId,
            requestId: scoringRun.requestId,
            queueId: scoringRun.queueId,
            offeringCount: scoringRun.offeringCount,
            triggerRequest: scoringRun.triggerRequest,
            settings: getSchedulerSettings(),
            recentRuns: listSchedulerRuns(20),
            activeLock: activeSchedulerLock(Date.now()),
          }, 201);
        } catch (error) {
          updateSchedulerRunForRequest({
            requestId: scoringRun.requestId,
            roleKey: "score_company_service_fit",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            finish: true,
            releaseLock: true,
          });
          return json({
            error: error instanceof Error ? error.message : String(error),
            dryRun: false,
            decision: { ...decision, dryRun: false },
            run: listSchedulerRuns(1)[0],
            runId: scoringRun.runId,
            requestId: scoringRun.requestId,
            settings: getSchedulerSettings(),
            recentRuns: listSchedulerRuns(20),
            activeLock: activeSchedulerLock(Date.now()),
          }, 502);
        }
      }
      if (!decision.workAvailable || decision.action !== "acquisition" || decision.roleKey !== "scan_target_list" || !decision.item) {
        const skippedRun = createSchedulerRun({
          runType: "scheduled",
          status: "skipped",
          selectedAction: decision.workAvailable ? decision.action : "",
          skipReason: decision.workAvailable
            ? `scheduler selected ${decision.action}, but only acquisition execution is implemented`
            : decision.reason,
          roleKey: decision.roleKey,
          context: {
            dryRun: false,
            userPubkey: session.pubkey,
            evaluatedRoles: decision.evaluatedRoles,
          },
          result: {
            dryRun: false,
            decision,
          },
          startedAt: now,
          finishedAt: now,
          now,
        });
        return json({
          dryRun: false,
          decision: {
            ...decision,
            dryRun: false,
            workAvailable: false,
            reason: skippedRun.skipReason,
          },
          run: skippedRun,
          settings: getSchedulerSettings(),
          recentRuns: listSchedulerRuns(20),
          activeLock: activeSchedulerLock(now),
        });
      }

      const schedulerRun = createSchedulerRun({
        runType: "scheduled",
        status: "running",
        selectedAction: "acquisition",
        roleKey: "scan_target_list",
        context: {
          dryRun: false,
          userPubkey: session.pubkey,
          evaluatedRoles: decision.evaluatedRoles,
          selectedAcquisitionWork: decision.item,
        },
        result: {
          dryRun: false,
          decision,
        },
        startedAt: now,
        now,
      });
      const lock = acquireSchedulerLock({
        runId: schedulerRun.id,
        ownerId: `scheduler:${session.pubkey.slice(0, 16)}`,
        leaseMs: Math.max(10 * 60 * 1000, Number(getSchedulerSettings().cooldowns.acquisitionMs ?? 0)),
        now,
      });
      if (!lock) {
        const reason = "scheduler lock prospecting could not be acquired";
        db.query(`
          UPDATE scheduler_runs
          SET status = 'skipped',
              skip_reason = ?1,
              result_json = ?2,
              finished_at = ?3,
              updated_at = ?3
          WHERE id = ?4
        `).run(reason, JSON.stringify({ dryRun: false, decision, lockAcquired: false }), Date.now(), schedulerRun.id);
        return json({
          dryRun: false,
          decision: {
            ...decision,
            dryRun: false,
            workAvailable: false,
            reason,
          },
          run: listSchedulerRuns(1)[0],
          settings: getSchedulerSettings(),
          recentRuns: listSchedulerRuns(20),
          activeLock: activeSchedulerLock(Date.now()),
        }, 409);
      }

      const acquisitionJob = buildScheduledAcquisitionJob({
        item: decision.item,
        decision,
        schedulerRunId: schedulerRun.id,
        req,
        session,
      });
      if (shouldDeferKindlingAutopilotAuth(body, "scan_target_list")) {
        return json({
          dryRun: false,
          decision: { ...decision, dryRun: false },
          run: listSchedulerRuns(1)[0],
          lock,
          requiresAutopilotAuth: true,
          runId: acquisitionJob.kindlingRunId,
          jobId: acquisitionJob.jobId,
          triggerRequest: acquisitionJob.triggerRequest,
          acquisition: {
            coverageSliceId: acquisitionJob.coverageSliceId,
            targetCount: acquisitionJob.targetCount,
            scanMode: acquisitionJob.scanMode,
            correlation: acquisitionJob.correlation,
          },
          settings: getSchedulerSettings(),
          recentRuns: listSchedulerRuns(20),
          activeLock: activeSchedulerLock(Date.now()),
        }, 202);
      }

      try {
        const start = await startKindlingRun(
          acquisitionJob.kindlingRunId,
          typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "",
        );
        return json({
          dryRun: false,
          decision: { ...decision, dryRun: false },
          run: listSchedulerRuns(1)[0],
          lock,
          start,
          runId: acquisitionJob.kindlingRunId,
          jobId: acquisitionJob.jobId,
          triggerRequest: acquisitionJob.triggerRequest,
          acquisition: {
            coverageSliceId: acquisitionJob.coverageSliceId,
            targetCount: acquisitionJob.targetCount,
            scanMode: acquisitionJob.scanMode,
            correlation: acquisitionJob.correlation,
          },
          settings: getSchedulerSettings(),
          recentRuns: listSchedulerRuns(20),
          activeLock: activeSchedulerLock(Date.now()),
        }, 201);
      } catch (error) {
        return json({
          error: error instanceof Error ? error.message : String(error),
          dryRun: false,
          decision: { ...decision, dryRun: false },
          run: listSchedulerRuns(1)[0],
          runId: acquisitionJob.kindlingRunId,
          jobId: acquisitionJob.jobId,
          acquisition: {
            coverageSliceId: acquisitionJob.coverageSliceId,
            targetCount: acquisitionJob.targetCount,
            scanMode: acquisitionJob.scanMode,
            correlation: acquisitionJob.correlation,
          },
          settings: getSchedulerSettings(),
          recentRuns: listSchedulerRuns(20),
          activeLock: activeSchedulerLock(Date.now()),
        }, 502);
      }
    }
    const auditRun = createSchedulerRun({
      runType: "dry_run",
      status: decision.workAvailable ? "complete" : "skipped",
      selectedAction: decision.workAvailable ? decision.action : "",
      skipReason: decision.workAvailable ? "" : decision.reason,
      roleKey: decision.roleKey,
      context: {
        dryRun: true,
        userPubkey: session.pubkey,
        evaluatedRoles: decision.evaluatedRoles,
        selectedAcquisitionWork: decision.action === "acquisition" ? decision.item : null,
      },
      result: {
        dryRun: true,
        decision,
      },
      startedAt: now,
      finishedAt: now,
      now,
    });
    return json({
      dryRun: true,
      decision,
      run: auditRun,
      settings: getSchedulerSettings(),
      recentRuns: listSchedulerRuns(20),
      activeLock: activeSchedulerLock(now),
    });
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

  if (pathname === "/api/kindling/scoring/offerings" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "authentication required" }, 401);
    const { profile, offerings } = listActiveScoringOfferings();
    return json({
      profile,
      marketProfileVersionId: profile?.currentVersionId ?? null,
      offerings,
    });
  }

  if (pathname === "/api/kindling/service-assessments" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const companyId = String(body.companyId ?? "").trim();
    const serviceOfferingId = String(body.serviceOfferingId ?? "").trim();
    if (!companyId) return json({ error: "companyId is required" }, 400);
    const company = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!company) return json({ error: "company not found" }, 404);
    const activeScoring = listActiveScoringOfferings();
    const offeringRows = serviceOfferingId
      ? [db.query("SELECT * FROM service_offerings WHERE id = ?1").get(serviceOfferingId) as Record<string, unknown> | null].filter(Boolean) as Record<string, unknown>[]
      : (activeScoring.offerings || []).map((offering) => db.query("SELECT * FROM service_offerings WHERE id = ?1").get(String(offering.id)) as Record<string, unknown>).filter(Boolean);
    if (!offeringRows.length) return json({ error: serviceOfferingId ? "service offering not found" : "no active service offerings to score against" }, 404);
    const marketProfileVersionId = String(body.marketProfileVersionId ?? offeringRows[0]?.market_profile_version_id ?? activeScoring.profile?.currentVersionId ?? "").trim();
    if (offeringRows.some((offering) => marketProfileVersionId !== String(offering.market_profile_version_id))) {
      return json({ error: "service offering does not belong to marketProfileVersionId" }, 400);
    }

    const now = Date.now();
    const requestId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const reason = String(body.reason ?? (
      serviceOfferingId
        ? `Score ${String(company.name)} against ${String(offeringRows[0]?.name)}`
        : `Score ${String(company.name)} against all active Adapt service offerings`
    )).trim();
    const context = buildServiceFitScoringContext(company, offeringRows, webhookOrigin(req), webhookToken);
    const queueId = createServiceFitAssessmentQueueItem({
      id: requestId,
      companyId,
      serviceOfferingId: serviceOfferingId || "all",
      marketProfileVersionId,
      reason,
      priority: Number(body.priority ?? 40),
      context,
      now,
    });
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "score_company_service_fit",
      localRequestId: requestId,
      message: reason,
      context,
      webhookUrl: `${webhookOrigin(req)}/api/kindling/pipeline-webhook`,
      webhookToken,
      userPubkey: session.pubkey,
      userNpub: pubkeyToNpub(session.pubkey),
    });
    const runId = createKindlingRun({ roleKey: "score_company_service_fit", localRequestId: requestId, triggerRequest, status: "queued" });
    if (shouldDeferKindlingAutopilotAuth(body, "score_company_service_fit")) {
      return json({ requiresAutopilotAuth: true, runId, requestId, queueId, offeringCount: offeringRows.length, triggerRequest }, 202);
    }
    await startKindlingRun(runId, typeof body.autopilotAuthorization === "string" ? body.autopilotAuthorization.trim() : "");
    db.query(`
      UPDATE work_queue
      SET status = 'running',
          attempts = attempts + 1,
          locked_by_run_id = ?1,
          updated_at = ?2
      WHERE id = ?3
    `).run(runId, Date.now(), queueId);
    return json({ runId, requestId, queueId, offeringCount: offeringRows.length, triggerRequest }, 201);
  }

  if (pathname === "/api/kindling/target-segments" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const segments = listTargetSegments();
    return json({ segments, tree: buildTargetSegmentTree(segments) });
  }

  if (pathname === "/api/kindling/target-segments" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const label = String(body.label ?? "").trim();
    if (!label) return json({ error: "label is required" }, 400);
    const id = String(body.id ?? crypto.randomUUID()).trim();
    if (!id) return json({ error: "id is required" }, 400);
    const existing = getTargetSegment(id);
    if (existing) return json({ error: "segment already exists" }, 409);
    const parentId = body.parentId === null || body.parent_id === null
      ? null
      : String(body.parentId ?? body.parent_id ?? "").trim() || null;
    const parent = parentId ? getTargetSegment(parentId) : null;
    if (parentId && !parent) return json({ error: "parent segment not found" }, 400);
    if (hasTargetSegmentParentLoop(id, parentId)) return json({ error: "parent would create a segment loop" }, 400);
    const status = normalizeSegmentStatus(body.status);
    if (!status) return json({ error: "status must be active or parked" }, 400);
    const tier = Math.min(5, Math.max(1, normalizePositiveInteger(body.tier, parent?.tier ?? 1)));
    const priority = normalizePositiveInteger(body.priority, 100);
    const defaultTargetCount = normalizePositiveInteger(body.defaultTargetCount ?? body.default_target_count, 100);
    const defaultBatchSize = normalizePositiveInteger(body.defaultBatchSize ?? body.default_batch_size, Math.min(25, defaultTargetCount));
    const coverageTargets = parseJsonObjectField(body.coverageTargets ?? body.targets ?? body.coverage_targets_json, {});
    const scanPrompts = parseJsonObjectField(body.scanPrompts ?? body.prompts ?? body.scan_prompts_json, {});
    const now = Date.now();
    db.query(`
      INSERT INTO target_segments(
        id, parent_id, label, tier, priority, status, default_geo, default_target_count, default_batch_size,
        coverage_targets_json, scan_prompts_json, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    `).run(
      id,
      parentId,
      label,
      tier,
      priority,
      status,
      String(body.defaultGeo ?? body.default_geo ?? "Perth, WA").trim() || "Perth, WA",
      defaultTargetCount,
      defaultBatchSize,
      JSON.stringify(coverageTargets),
      JSON.stringify(scanPrompts),
      now,
    );
    recordActivity("target_segment", id, "user", "target_segment_created", "Target segment created", { pubkey: session.pubkey });
    return json({ segment: getTargetSegment(id), segments: listTargetSegments() }, 201);
  }

  const targetSegmentMatch = pathname.match(/^\/api\/kindling\/target-segments\/([^/]+)$/);
  if (targetSegmentMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const segmentId = decodeURIComponent(targetSegmentMatch[1]!);
    const existing = db.query("SELECT * FROM target_segments WHERE id = ?1").get(segmentId) as Record<string, unknown> | null;
    if (!existing) return json({ error: "segment not found" }, 404);
    const body = await readJson(req);
    const parentId = body.parentId === null || body.parent_id === null
      ? null
      : String(body.parentId ?? body.parent_id ?? existing.parent_id ?? "").trim() || null;
    const parent = parentId ? getTargetSegment(parentId) : null;
    if (parentId && !parent) return json({ error: "parent segment not found" }, 400);
    if (hasTargetSegmentParentLoop(segmentId, parentId)) return json({ error: "parent would create a segment loop" }, 400);
    const status = normalizeSegmentStatus(body.status, String(existing.status));
    if (!status) return json({ error: "status must be active or parked" }, 400);
    const label = String(body.label ?? existing.label).trim();
    if (!label) return json({ error: "label is required" }, 400);
    const tier = Math.min(5, Math.max(1, normalizePositiveInteger(body.tier, Number(existing.tier))));
    const priority = normalizePositiveInteger(body.priority, Number(existing.priority));
    const defaultTargetCount = normalizePositiveInteger(body.defaultTargetCount ?? body.default_target_count, Number(existing.default_target_count));
    const defaultBatchSize = normalizePositiveInteger(body.defaultBatchSize ?? body.default_batch_size, Number(existing.default_batch_size));
    const coverageTargets = parseJsonObjectField(body.coverageTargets ?? body.targets ?? body.coverage_targets_json, jsonParse<Record<string, unknown>>(existing.coverage_targets_json, {}));
    const scanPrompts = parseJsonObjectField(body.scanPrompts ?? body.prompts ?? body.scan_prompts_json, jsonParse<Record<string, unknown>>(existing.scan_prompts_json, {}));
    const now = Date.now();
    db.query(`
      UPDATE target_segments
      SET parent_id = ?1,
          label = ?2,
          tier = ?3,
          priority = ?4,
          status = ?5,
          default_geo = ?6,
          default_target_count = ?7,
          default_batch_size = ?8,
          coverage_targets_json = ?9,
          scan_prompts_json = ?10,
          updated_at = ?11
      WHERE id = ?12
    `).run(
      parentId,
      label,
      tier,
      priority,
      status,
      String(body.defaultGeo ?? body.default_geo ?? existing.default_geo ?? "Perth, WA").trim() || "Perth, WA",
      defaultTargetCount,
      defaultBatchSize,
      JSON.stringify(coverageTargets),
      JSON.stringify(scanPrompts),
      now,
      segmentId,
    );
    recordActivity("target_segment", segmentId, "user", "target_segment_updated", "Target segment updated", { pubkey: session.pubkey });
    return json({ segment: getTargetSegment(segmentId), segments: listTargetSegments() });
  }

  if (pathname === "/api/kindling/coverage-slices" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const coverage = buildCoverageSummary();
    return json(coverage);
  }

  const coverageSliceMatch = pathname.match(/^\/api\/kindling\/coverage-slices\/([^/]+)$/);
  if (coverageSliceMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const coverageSliceId = decodeURIComponent(coverageSliceMatch[1]!);
    const existing = db.query("SELECT * FROM coverage_slices WHERE id = ?1").get(coverageSliceId) as Record<string, unknown> | null;
    if (!existing) return json({ error: "coverage slice not found" }, 404);
    const body = await readJson(req);
    const status = normalizeCoverageStatus(body.status, String(existing.status));
    if (!status) return json({ error: "status must be active, paused, or stalled" }, 400);
    const targetCounts = parseJsonObjectField(body.targetCounts ?? body.target_counts_json, jsonParse<Record<string, unknown>>(existing.target_counts_json, {}));
    const nextRunAfterAt = body.nextRunAfterAt === null || body.next_run_after_at === null
      ? null
      : body.nextRunAfterAt === undefined && body.next_run_after_at === undefined
        ? existing.next_run_after_at ? Number(existing.next_run_after_at) : null
        : Number(body.nextRunAfterAt ?? body.next_run_after_at);
    if (nextRunAfterAt !== null && !Number.isFinite(nextRunAfterAt)) {
      return json({ error: "nextRunAfterAt must be a timestamp or null" }, 400);
    }
    const stalledReason = String(body.stalledReason ?? body.stalled_reason ?? existing.stalled_reason ?? "").trim();
    const now = Date.now();
    db.query(`
      UPDATE coverage_slices
      SET status = ?1,
          target_counts_json = ?2,
          next_run_after_at = ?3,
          stalled_reason = ?4,
          updated_at = ?5
      WHERE id = ?6
    `).run(status, JSON.stringify(targetCounts), nextRunAfterAt, stalledReason, now, coverageSliceId);
    recordActivity("coverage_slice", coverageSliceId, "user", "coverage_slice_updated", "Coverage slice updated", { pubkey: session.pubkey });
    const recommendations = recommendedScanStrategies(100);
    const row = db.query(`
      SELECT cs.*, ts.label AS segment_label, tg.label AS geography_label
      FROM coverage_slices cs
      LEFT JOIN target_segments ts ON ts.id = cs.segment_id
      LEFT JOIN target_geographies tg ON tg.id = cs.geography_id
      WHERE cs.id = ?1
    `).get(coverageSliceId) as Record<string, unknown>;
    return json({ slice: mapCoverageSlice(row, recommendations), coverage: buildCoverageSummary() });
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
    const explicitSegment = body.segmentId ?? body.targetSegmentId;
    const segmentId = explicitSegment === undefined ? findTargetSegmentIdForScan(industry) : findTargetSegmentIdForScan(explicitSegment);
    if (explicitSegment !== undefined && !segmentId) return json({ error: "segment not found" }, 400);
    const now = Date.now();
    const jobId = crypto.randomUUID();
    const geographyId = getOrCreateTargetGeography(String(body.geographyText ?? location), now);
    const geographyText = String(body.geographyText ?? location).trim();
    const sourceFamily = normalizeSourceFamily(body.sourceFamily, "scan_target_list");
    const coverageSliceId = getOrCreateCoverageSlice({
      segmentId,
      geographyId,
      geographyText,
      sourceFamily,
      strategyType: String(body.strategyType ?? "scan_target_list"),
      targetCounts: targetCountsForCoverage(segmentId, targetCount),
      now,
    });
    db.query(`
      INSERT INTO discovery_jobs(
        id, industry, location, segment_id, geography_id, geography_text, coverage_slice_id,
        target_count, scan_mode, status, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'queued', ?10, ?10)
    `).run(jobId, industry, location, segmentId, geographyId, geographyText, coverageSliceId, targetCount, scanMode, now);
    const webhookToken = crypto.randomUUID().replaceAll("-", "");
    const scanContext = buildScanContext(industry, location, targetCount);
    const triggerRequest = buildKindlingTriggerRequest({
      roleKey: "scan_target_list",
      localRequestId: jobId,
      message: `Find up to ${targetCount} target companies for ${industry} in ${location}`,
      context: {
        industry,
        location,
        segmentId,
        geography: {
          id: geographyId,
          text: geographyText,
        },
        coverageSlice: {
          id: coverageSliceId,
          sourceFamily,
          strategyType: String(body.strategyType ?? "scan_target_list"),
        },
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
    const { limit, offset } = pagingFromParams(url.searchParams);
    const companies = listCompanies(url.searchParams, { limit, offset, compact: true });
    return json({
      companies,
      total: countCompanies(url.searchParams),
      returned: companies.length,
      limit,
      offset,
    });
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
      normalizeCompanyDataRing(body.dataRing ?? "found"),
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
    const sources = (db.query("SELECT * FROM sources WHERE company_id = ?1 ORDER BY created_at DESC").all(companyId) as Record<string, unknown>[]).map(mapSource);
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const signals = (db.query("SELECT * FROM signals WHERE company_id = ?1 ORDER BY created_at DESC").all(companyId) as Record<string, unknown>[])
      .map(mapSignal)
      .map((signal) => ({
        ...signal,
        source: signal.sourceId ? sourceById.get(signal.sourceId) ?? null : null,
        lowConfidence: !signal.sourceId && !signal.sourceUrl && signal.confidence <= 0.4,
      }));
    const customerProfileVersions = (db.query(`
      SELECT *
      FROM customer_profile_versions
      WHERE company_id = ?1
      ORDER BY version_number DESC, created_at DESC
    `).all(companyId) as Record<string, unknown>[]).map(mapCustomerProfileVersion);
    const activities = (db.query("SELECT * FROM activities WHERE target_type = 'company' AND target_id = ?1 ORDER BY created_at DESC LIMIT 50").all(companyId) as Record<string, unknown>[]).map(rowJson);
    const drafts = (db.query("SELECT * FROM outreach_drafts WHERE company_id = ?1 ORDER BY updated_at DESC").all(companyId) as Record<string, unknown>[]).map(rowJson);
    const serviceFitAssessments = listServiceFitAssessmentsForCompany(companyId);
    const segments = listCompanySegments(companyId);
    const companyProfile = jsonParse<Record<string, unknown>>(row.profile_json, {});
    const people = Array.isArray(companyProfile.decisionMakers) ? companyProfile.decisionMakers : [];
    return json({
      company: mapCompany(row),
      sources,
      signals,
      customerProfileVersions,
      evidence: { sources, signals },
      people,
      activities,
      serviceFitAssessments,
      drafts,
      outreachDrafts: drafts,
      segments,
    });
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
      normalizeCompanyDataRing(body.dataRing ?? existing.data_ring),
      String(body.duplicateStatus ?? existing.duplicate_status),
      normalizeCompanyExecutionStatus(body.enrichmentStatus ?? existing.enrichment_status),
      Number(body.confidence ?? existing.confidence ?? 0),
      JSON.stringify(profile),
      now,
      companyId,
    );
    recordActivity("company", companyId, "user", "company_updated", "Company profile edited", { pubkey: session.pubkey });
    const row = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown>;
    return json({ company: mapCompany(row) });
  }

  const companySegmentsMatch = pathname.match(/^\/api\/kindling\/companies\/([^/]+)\/segments$/);
  if (companySegmentsMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const companyId = decodeURIComponent(companySegmentsMatch[1]!);
    const company = db.query("SELECT id FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!company) return json({ error: "company not found" }, 404);
    return json({ companyId, segments: listCompanySegments(companyId) });
  }

  if (companySegmentsMatch && req.method === "PATCH") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const companyId = decodeURIComponent(companySegmentsMatch[1]!);
    const company = db.query("SELECT id FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown> | null;
    if (!company) return json({ error: "company not found" }, 404);
    const body = await readJson(req);
    const rawSegments = Array.isArray(body.segments) ? body.segments as Record<string, unknown>[] : [];
    const removeSegmentIds = Array.isArray(body.removeSegmentIds) ? body.removeSegmentIds.map(String) : [];
    if (!rawSegments.length && !removeSegmentIds.length && body.replace !== true) {
      return json({ error: "segments or removeSegmentIds are required" }, 400);
    }

    const memberships = rawSegments.map((entry) => ({
      segmentId: String(entry.segmentId ?? entry.segment_id ?? "").trim(),
      confidence: Math.max(0, Math.min(1, Number(entry.confidence ?? 0))),
      source: String(entry.source ?? "manual").trim() || "manual",
    }));
    for (const membership of memberships) {
      if (!membership.segmentId) return json({ error: "segmentId is required" }, 400);
      if (!Number.isFinite(membership.confidence)) return json({ error: "confidence must be a number between 0 and 1" }, 400);
      if (!getTargetSegment(membership.segmentId)) return json({ error: `segment not found: ${membership.segmentId}` }, 400);
    }
    for (const segmentId of removeSegmentIds) {
      if (!getTargetSegment(segmentId)) return json({ error: `segment not found: ${segmentId}` }, 400);
    }

    const now = Date.now();
    const transaction = db.transaction(() => {
      if (body.replace === true) {
        db.query("DELETE FROM company_segments WHERE company_id = ?1").run(companyId);
      } else {
        for (const segmentId of removeSegmentIds) {
          db.query("DELETE FROM company_segments WHERE company_id = ?1 AND segment_id = ?2").run(companyId, segmentId);
        }
      }
      const upsert = db.query(`
        INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(company_id, segment_id) DO UPDATE SET
          confidence = excluded.confidence,
          source = excluded.source
      `);
      for (const membership of memberships) {
        upsert.run(companyId, membership.segmentId, membership.confidence, membership.source, now);
      }
      db.query("UPDATE companies SET updated_at = ?1 WHERE id = ?2").run(now, companyId);
    });
    transaction();
    recordActivity("company", companyId, "user", "company_segments_updated", "Company segment membership updated", {
      pubkey: session.pubkey,
      segmentIds: memberships.map((membership) => membership.segmentId),
      removedSegmentIds: removeSegmentIds,
      replace: body.replace === true,
    });
    return json({ companyId, segments: listCompanySegments(companyId) });
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
    const requestKind = String(body.requestKind ?? "standard");
    const queueId = createCompanyEnrichmentQueueItem({
      id: requestId,
      companyId,
      requestKind,
      reason: String(body.reason ?? `Manual enrichment requested for ${String(company.name)}`),
      priority: Number(body.priority ?? 10),
      context: { source: "manual_enrichment_endpoint" },
      now,
    });
    db.query("INSERT INTO enrichment_requests(id, company_id, work_queue_id, status, request_kind, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5)")
      .run(requestId, companyId, queueId, requestKind, now);
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
    attachEnrichmentQueueToRun([queueId], runId, now);
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

  if (pathname === "/api/kindling/initial-ranking/runs" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return json({ runs: listRankingRuns(Number.isFinite(limit) ? limit : 20) });
  }

  if (pathname === "/api/kindling/initial-ranking/run" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const limit = body.limit === undefined || body.limit === null || body.limit === ""
      ? null
      : Math.max(1, Math.min(5000, Math.floor(Number(body.limit))));
    if (limit !== null && !Number.isFinite(limit)) return json({ error: "limit must be a positive number" }, 400);
    const detail = runInitialRanking({
      reason: String(body.reason ?? "Manual initial ranking rebuild"),
      limit,
      createdBy: `user:${session.pubkey.slice(0, 16)}`,
    });
    return json(detail, 201);
  }

  const initialRankingRunMatch = pathname.match(/^\/api\/kindling\/initial-ranking\/runs\/([^/]+)$/);
  if (initialRankingRunMatch && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const detail = getRankingRunDetail(decodeURIComponent(initialRankingRunMatch[1]!));
    if (!detail) return json({ error: "ranking run not found" }, 404);
    return json(detail);
  }

  if (pathname === "/api/kindling/top-targets" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const { limit, offset } = pagingFromParams(url.searchParams);
    const hasOutreachDraft = ["1", "true", "yes"].includes(String(url.searchParams.get("hasOutreachDraft") || "").toLowerCase());
    const bandParam = String(url.searchParams.get("band") || "").toLowerCase();
    const band = ["high", "medium", "low"].includes(bandParam) ? bandParam : "";
    const baseDetail = getOrBuildTopTargetDetail(limit, 0);
    const rebuilt = Boolean(baseDetail.rebuilt);
    const detail = getTopTargetRunDetail(baseDetail.run.id, limit, offset, { hasOutreachDraft, band })!;
    return json({
      targetListRunId: detail.run.id,
      source: "top_targets",
      rebuilt,
      run: detail.run,
      targets: detail.items,
      total: detail.total ?? detail.run.rankedCount,
      returned: detail.items.length,
      limit: detail.limit ?? limit,
      offset: detail.offset ?? offset,
      band,
      bandCounts: detail.bandCounts,
    });
  }

  if (pathname === "/api/kindling/top-targets/rebuild" && req.method === "POST") {
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const limit = body.limit === undefined || body.limit === null || body.limit === ""
      ? null
      : Math.max(1, Math.min(10000, Math.floor(Number(body.limit))));
    if (limit !== null && !Number.isFinite(limit)) return json({ error: "limit must be a positive number" }, 400);
    const detail = runTopTargetAggregation({
      reason: String(body.reason ?? "Manual top-target rebuild"),
      limit,
      createdBy: `user:${session.pubkey.slice(0, 16)}`,
    });
    return json({
      targetListRunId: detail.run.id,
      source: "top_targets",
      rebuilt: true,
      run: detail.run,
      targets: detail.items,
    }, 201);
  }

  if (pathname === "/api/kindling/todays-targets" && req.method === "GET") {
    const session = requireSession(req);
    if (!session) return json({ error: "unauthorized" }, 401);
    const latestTopTargetRun = db.query(`
      SELECT id
      FROM target_list_runs
      WHERE status = 'complete' AND ranked_count > 0
      ORDER BY completed_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get() as Record<string, unknown> | null;
    if (latestTopTargetRun) {
      const detail = getTopTargetRunDetail(String(latestTopTargetRun.id), 30);
      return json({
        targets: detail?.items ?? [],
        targetListRunId: String(latestTopTargetRun.id),
        rankingRunId: null,
        source: "top_targets",
      });
    }
    const latestRun = db.query(`
      SELECT id
      FROM ranking_runs
      WHERE ranking_type = 'initial' AND status = 'complete'
      ORDER BY completed_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get() as Record<string, unknown> | null;
    if (latestRun) {
      const rows = db.query(`
        SELECT
          ri.id,
          ri.company_id,
          ri.rank,
          ri.reason,
          ri.score_json,
          ri.created_at,
          ri.ranking_run_id,
          ri.score,
          c.name,
          c.location,
          c.industry,
          c.website,
          c.enrichment_status
        FROM ranking_items ri
        JOIN companies c ON c.id = ri.company_id
        WHERE ri.ranking_run_id = ?1
        ORDER BY ri.rank ASC
        LIMIT 30
      `).all(String(latestRun.id)) as Record<string, unknown>[];
      return json({ targets: rows.map(rowJson), rankingRunId: String(latestRun.id), source: "initial_ranking" });
    }
    return json({ targets: [], rankingRunId: null, source: "none" });
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
    updateSchedulerRunForRequest({
      requestId,
      status: "running",
      result: {
        lastPartialWrite: {
          persisted,
          updatedAt: Date.now(),
        },
      },
    });
    return json({ ok: true, persisted });
  }

  if (pathname === "/api/kindling/pipeline-write/enrichment-company" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-kindling-pipeline-token") || String(body.token ?? "");
    const batchRequestId = String(body.batchRequestId ?? body.requestId ?? "").trim();
    const run = batchRequestId && token ? findKindlingRun(batchRequestId, "enrich_industry_segment", token) : null;
    if (!run) return json({ error: "webhook target not found" }, 400);
    const records = normalizeKindlingCallbackRecords("enrich_company", {
      ...body,
      role: "enrich_company",
    });
    const company = objectRecord(records.company ?? body.company);
    const companyId = String(company?.id ?? body.companyId ?? "").trim();
    if (!companyId) return json({ error: "company id is required" }, 400);
    const requestRow = db.query(`
      SELECT id
      FROM enrichment_requests
      WHERE company_id = ?1
        AND request_kind = 'industry_batch'
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(companyId) as Record<string, unknown> | null;
    const persisted = persistCompanyEnrichment({
      company: {
        ...company,
        id: companyId,
        sources: Array.isArray(company.sources) ? company.sources : Array.isArray(body.sources) ? body.sources : [],
        signals: Array.isArray(company.signals) ? company.signals : Array.isArray(body.signals) ? body.signals : [],
        gaps: Array.isArray(company.gaps) ? company.gaps : Array.isArray(body.gaps) ? body.gaps : [],
      },
      response: String(body.response ?? `Enriched ${companyId}`),
      requestId: requestRow ? String(requestRow.id) : batchRequestId,
      runId: String(run.id),
    });
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', updated_at = ?1 WHERE id = ?2")
      .run(Date.now(), String(run.id));
    return json({ ok: true, persisted });
  }

  if (pathname === "/api/kindling/pipeline-write/service-assessment" && req.method === "POST") {
    const body = await readJson(req);
    const token = req.headers.get("x-kindling-pipeline-token") || String(body.token ?? "");
    const requestId = String(body.requestId ?? "").trim();
    const run = requestId && token ? findKindlingRun(requestId, "score_company_service_fit", token) : null;
    if (!run) return json({ error: "webhook target not found" }, 400);
    const persisted = persistServiceFitAssessmentBatch({
      body: {
        ...body,
        role: "score_company_service_fit",
      },
      run,
    });
    if (!persisted.ok) return json({ error: persisted.error }, 400);
    db.query("UPDATE kindling_pipeline_runs SET status = 'running', updated_at = ?1 WHERE id = ?2")
      .run(Date.now(), String(run.id));
    return json({
      ok: true,
      persisted: persisted.assessments.length === 1 ? persisted.assessment : persisted.assessments,
      assessments: persisted.assessments,
    });
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
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
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
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
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
    const session = requireEditSession(req);
    if (!session) return json({ error: "edit access required" }, 403);
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

  if (pathname === "/api/nip98/kindling/import" && req.method === "POST") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "edit")) return json({ error: "edit access required" }, 403);
    const body = await readJson(req);
    const counts = importKindlingData(body);
    return json({ ok: true, counts });
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
    updateSchedulerRunForRequest({
      requestId,
      status: final ? "complete" : "running",
      result: final
        ? { terminalStatus: "complete", persisted, retryable: false, source: "nip98_scan_results" }
        : { lastPartialWrite: { persisted, updatedAt: Date.now(), source: "nip98_scan_results" } },
      finish: final,
      releaseLock: final,
    });
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
      companies: listCompanies(null, { limit: COMPANY_LIST_LIMIT, offset: 0, compact: true }),
    });
  }

  if (pathname === "/api/nip98/companies" && req.method === "GET") {
    const verified = await verifyNip98Request(req, url);
    if (!verified.ok) return json({ error: verified.error }, 401);
    if (!hasAccess(verified.pubkey, "read")) return json({ error: "read access required" }, 403);
    const { limit, offset } = pagingFromParams(url.searchParams, { limit: COMPANY_LIST_LIMIT, max: COMPANY_LIST_LIMIT });
    const companies = listCompanies(url.searchParams, { limit, offset, compact: true });
    return json({ companies, total: countCompanies(url.searchParams), returned: companies.length, limit, offset });
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
      normalizeCompanyDataRing(body.dataRing ?? "enhanced"),
      String(body.duplicateStatus ?? "unknown"),
      normalizeCompanyExecutionStatus(body.enrichmentStatus ?? "not_started"),
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
      normalizeCompanyDataRing(body.dataRing ?? existing.data_ring),
      String(body.duplicateStatus ?? existing.duplicate_status),
      normalizeCompanyExecutionStatus(body.enrichmentStatus ?? existing.enrichment_status),
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
  setTimeout(() => {
    void runAutomatedProspectingLoop().catch((error) => {
      console.error("automated prospecting startup pass failed", error);
    });
  }, 1000);
  setInterval(() => {
    void runAutomatedProspectingLoop().catch((error) => {
      console.error("automated prospecting loop failed", error);
    });
  }, PROSPECTING_LOOP_INTERVAL_MS);

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
