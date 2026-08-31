import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { KINDLING_API_URL, KINDLING_CACHE_MAX_AGE_MS, KINDLING_COMPANY_SOURCE } from "./config.ts";
import { db, getSetting, setSetting } from "./db.ts";

export type CanonicalTarget = {
  id: string;
  displayName: string;
  canonicalName?: string;
  websiteUrl?: string | null;
  domain?: string | null;
  location?: { countryCode?: string | null; country?: string | null; state?: string | null; city?: string | null; text?: string | null };
  industry?: {
    level1?: { id: string; label: string } | null;
    level2?: { id: string; label: string } | null;
    confidence?: number;
  };
  targetSegments?: Array<{ id: string; label: string }>;
  enrichmentStatus?: string;
  confidence?: number;
  updatedAt?: string;
  createdAt?: string;
  changeSeq?: number;
  [key: string]: unknown;
};

export type CanonicalPreparedRequest = {
  url: string;
  method: "GET";
};

export type CanonicalSyncStep = {
  source: "canonical-api" | "local";
  syncId?: string;
  mode: "bootstrap" | "changes" | "compatibility";
  stage?: "bootstrap" | "snapshot" | "changes";
  applied: number;
  cursor: string | null;
  complete: boolean;
  requiresCanonicalAuth: boolean;
  canonicalRequest?: CanonicalPreparedRequest;
  canonicalApi: ReturnType<typeof canonicalApiStatus>;
};

type FetchLike = typeof fetch;
type CanonicalSyncSession = {
  id: string;
  actorPubkey: string;
  mode: "bootstrap" | "changes";
  stage: "bootstrap" | "snapshot" | "changes";
  request: CanonicalPreparedRequest;
  cursor: string | null;
  bootstrapCursor: string | null;
  applied: number;
  touchedAt: number;
};

const CURSOR_SETTING = "canonicalApiSyncCursor";
const LAST_SYNC_SETTING = "canonicalApiLastSyncAt";
const LAST_API_ATTEMPT_SETTING = "canonicalApiLastAttemptAt";
const API_REACHABLE_SETTING = "canonicalApiReachable";
const AUTHORIZATION_STATE_SETTING = "canonicalApiAuthorizationState";
const LAST_AUTHORIZED_SETTING = "canonicalApiLastAuthorizedAt";
const LAST_ERROR_SETTING = "canonicalApiLastError";
const SYNC_SESSION_TTL_MS = 5 * 60 * 1000;
const NIP98_MAX_AGE_SECONDS = 5 * 60;

let activeSyncSession: CanonicalSyncSession | null = null;

export class CanonicalApiError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "CanonicalApiError";
    this.status = status;
  }
}

export class CanonicalSyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSyncConflictError";
  }
}

export function canonicalApiBaseUrl(value = KINDLING_API_URL): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("KINDLING_API_URL must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function canonicalRequest(path: string): CanonicalPreparedRequest {
  return { url: new URL(path, `${canonicalApiBaseUrl()}/`).toString(), method: "GET" };
}

function snapshotRequest(pageCursor: string | null, pageSize: number): CanonicalPreparedRequest {
  const query = new URLSearchParams({ limit: String(Math.min(499, Math.max(1, pageSize))) });
  if (pageCursor) query.set("cursor", pageCursor);
  return canonicalRequest(`api/v1/targets?${query}`);
}

function changesRequest(cursor: string): CanonicalPreparedRequest {
  return canonicalRequest(`api/v1/targets/changes?since=${encodeURIComponent(cursor)}&limit=499&include=summary`);
}

function settingBoolean(key: string): boolean | null {
  const value = getSetting(key);
  return value === "true" ? true : value === "false" ? false : null;
}

function setCanonicalRemoteState(input: {
  reachable: boolean;
  authorization: "authorized" | "denied" | "unknown";
  error?: string;
}) {
  const now = new Date().toISOString();
  setSetting(LAST_API_ATTEMPT_SETTING, now);
  setSetting(API_REACHABLE_SETTING, String(input.reachable));
  setSetting(AUTHORIZATION_STATE_SETTING, input.authorization);
  if (input.authorization === "authorized") setSetting(LAST_AUTHORIZED_SETTING, now);
  setSetting(LAST_ERROR_SETTING, input.error || "");
}

function clearExpiredSyncSession(now = Date.now()) {
  if (activeSyncSession && now - activeSyncSession.touchedAt > SYNC_SESSION_TTL_MS) activeSyncSession = null;
}

function decodeAuthorization(authorization: string): NostrEvent | null {
  const match = authorization.trim().match(/^Nostr\s+(.+)$/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as NostrEvent;
  } catch {
    return null;
  }
}

export function verifyCanonicalAuthorization(
  authorization: string,
  request: CanonicalPreparedRequest,
  expectedPubkey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; error: string } {
  const event = decodeAuthorization(authorization);
  if (!event) return { ok: false, error: "A browser-signed NIP-98 authorization is required" };
  if (event.kind !== 27235) return { ok: false, error: "Invalid canonical NIP-98 event kind" };
  if (!verifyEvent(event)) return { ok: false, error: "Invalid canonical NIP-98 signature" };
  if (event.pubkey !== expectedPubkey) return { ok: false, error: "Canonical API authorization must use the signed-in user's identity" };
  const eventUrl = event.tags.find((tag) => tag[0] === "u")?.[1];
  const eventMethod = event.tags.find((tag) => tag[0] === "method")?.[1];
  let normalizedEventUrl = "";
  try {
    normalizedEventUrl = eventUrl ? new URL(eventUrl).toString() : "";
  } catch {
    normalizedEventUrl = "";
  }
  if (!normalizedEventUrl || normalizedEventUrl !== new URL(request.url).toString()) {
    return { ok: false, error: "Canonical NIP-98 URL mismatch" };
  }
  if (!eventMethod || eventMethod.toUpperCase() !== request.method) {
    return { ok: false, error: "Canonical NIP-98 method mismatch" };
  }
  if (Math.abs(nowSeconds - Number(event.created_at)) > NIP98_MAX_AGE_SECONDS) {
    return { ok: false, error: "Canonical NIP-98 authorization expired; sign the request again" };
  }
  return { ok: true };
}

async function forwardCanonicalRequest<T>(
  request: CanonicalPreparedRequest,
  authorization: string,
  expectedPubkey: string,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const verified = verifyCanonicalAuthorization(authorization, request, expectedPubkey);
  if (!verified.ok) throw new CanonicalApiError(verified.error, 400);

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: { accept: "application/json", authorization },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCanonicalRemoteState({ reachable: false, authorization: "unknown", error: `Kindling API unreachable: ${message}` });
    throw new CanonicalApiError(`Kindling API unreachable: ${message}`, 502);
  }

  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 500) };
  }

  if (!response.ok) {
    const authorizationState = response.status === 401 || response.status === 403 ? "denied" : "authorized";
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : String(payload);
    const message = `Kindling API ${request.method} ${new URL(request.url).pathname} failed (${response.status}): ${detail}`;
    setCanonicalRemoteState({ reachable: true, authorization: authorizationState, error: message });
    throw new CanonicalApiError(message, response.status === 401 || response.status === 403 ? 424 : 502);
  }

  setCanonicalRemoteState({ reachable: true, authorization: "authorized" });
  return payload as T;
}

export function mapCanonicalTarget(target: CanonicalTarget) {
  const timestamp = Date.parse(target.updatedAt || "");
  const createdTimestamp = Date.parse(target.createdAt || "");
  return {
    id: String(target.id),
    name: String(target.displayName || target.canonicalName || target.id),
    location: String(target.location?.text || [target.location?.city, target.location?.state, target.location?.country].filter(Boolean).join(", ")),
    industry: String(target.industry?.level2?.label || target.industry?.level1?.label || ""),
    website: String(target.websiteUrl || ""),
    enrichmentStatus: String(target.enrichmentStatus || "not_started"),
    confidence: Number(target.confidence || 0),
    createdAt: Number.isFinite(createdTimestamp) ? createdTimestamp : Date.now(),
    updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
    changeSeq: Number(target.changeSeq || 0),
    canonical: target,
  };
}

export function upsertCanonicalTarget(target: CanonicalTarget): void {
  const mapped = mapCanonicalTarget(target);
  const existing = db.query("SELECT profile_json, created_at FROM companies WHERE id = ?1").get(mapped.id) as
    | { profile_json: string; created_at: number }
    | null;
  let profile: Record<string, unknown> = {};
  try {
    profile = existing?.profile_json ? JSON.parse(existing.profile_json) as Record<string, unknown> : {};
  } catch {
    profile = {};
  }
  profile.canonicalApi = target;

  db.transaction(() => {
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status,
        enrichment_status, confidence, profile_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'found', 'unknown', ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        location = excluded.location,
        industry = excluded.industry,
        website = excluded.website,
        enrichment_status = excluded.enrichment_status,
        confidence = excluded.confidence,
        profile_json = excluded.profile_json,
        updated_at = excluded.updated_at
    `).run(
      mapped.id,
      mapped.name,
      mapped.location,
      mapped.industry,
      mapped.website,
      mapped.enrichmentStatus,
      mapped.confidence,
      JSON.stringify(profile),
      existing?.created_at ?? mapped.createdAt,
      mapped.updatedAt,
    );
    db.query(`
      INSERT INTO canonical_company_cache(company_id, payload_json, change_seq, synced_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(company_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        change_seq = excluded.change_seq,
        synced_at = excluded.synced_at
    `).run(mapped.id, JSON.stringify(target), mapped.changeSeq, Date.now());
  })();
}

export function removeCanonicalTarget(companyId: string): void {
  db.query("DELETE FROM canonical_company_cache WHERE company_id = ?1").run(companyId);
}

export function cachedCanonicalTarget(companyId: string): CanonicalTarget | null {
  const row = db.query("SELECT payload_json FROM canonical_company_cache WHERE company_id = ?1").get(companyId) as
    | { payload_json: string }
    | null;
  if (!row?.payload_json) return null;
  try {
    return JSON.parse(row.payload_json) as CanonicalTarget;
  } catch {
    return null;
  }
}

function syncStep(session: CanonicalSyncSession): CanonicalSyncStep {
  return {
    source: "canonical-api",
    syncId: session.id,
    mode: session.mode,
    stage: session.stage,
    applied: session.applied,
    cursor: session.cursor,
    complete: false,
    requiresCanonicalAuth: true,
    canonicalRequest: session.request,
    canonicalApi: canonicalApiStatus(),
  };
}

export function prepareCanonicalSync(
  actorPubkey: string,
  sourceMode: "canonical-api" | "local" = KINDLING_COMPANY_SOURCE,
): CanonicalSyncStep {
  if (sourceMode === "local") {
    return {
      source: "local",
      mode: "compatibility",
      applied: 0,
      cursor: null,
      complete: true,
      requiresCanonicalAuth: false,
      canonicalApi: canonicalApiStatus(),
    };
  }

  clearExpiredSyncSession();
  if (activeSyncSession) {
    if (activeSyncSession.actorPubkey !== actorPubkey) {
      throw new CanonicalSyncConflictError("Another user is already authorizing canonical sync; retry shortly");
    }
    activeSyncSession.touchedAt = Date.now();
    return syncStep(activeSyncSession);
  }

  const cursor = getSetting(CURSOR_SETTING) || null;
  activeSyncSession = {
    id: crypto.randomUUID(),
    actorPubkey,
    mode: cursor ? "changes" : "bootstrap",
    stage: cursor ? "changes" : "bootstrap",
    request: cursor ? changesRequest(cursor) : canonicalRequest("api/v1/bootstrap"),
    cursor,
    bootstrapCursor: null,
    applied: 0,
    touchedAt: Date.now(),
  };
  return syncStep(activeSyncSession);
}

export async function continueCanonicalSync(input: {
  syncId: string;
  actorPubkey: string;
  authorization: string;
  fetchImpl?: FetchLike;
}): Promise<CanonicalSyncStep> {
  clearExpiredSyncSession();
  const session = activeSyncSession;
  if (!session || session.id !== input.syncId || session.actorPubkey !== input.actorPubkey) {
    throw new CanonicalSyncConflictError("Canonical sync session expired; start sync again");
  }
  session.touchedAt = Date.now();

  if (session.stage === "bootstrap") {
    const payload = await forwardCanonicalRequest<{
      sync?: { currentCursor?: string };
      snapshot?: { currentSeq?: number; recommendedPageSize?: number };
    }>(session.request, input.authorization, input.actorPubkey, input.fetchImpl);
    const bootstrapCursor = String(payload.sync?.currentCursor ?? payload.snapshot?.currentSeq ?? "").trim();
    if (!bootstrapCursor) throw new CanonicalApiError("Kindling API bootstrap response did not include a current cursor");
    session.bootstrapCursor = bootstrapCursor;
    session.stage = "snapshot";
    session.request = snapshotRequest(null, Number(payload.snapshot?.recommendedPageSize || 499));
    session.touchedAt = Date.now();
    return syncStep(session);
  }

  if (session.stage === "snapshot") {
    const payload = await forwardCanonicalRequest<{
      items?: CanonicalTarget[];
      page?: { nextCursor?: string | null; hasMore?: boolean };
    }>(session.request, input.authorization, input.actorPubkey, input.fetchImpl);
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const target of items) upsertCanonicalTarget(target);
    session.applied += items.length;
    if (payload.page?.hasMore) {
      if (!payload.page.nextCursor) throw new CanonicalApiError("Kindling API snapshot page omitted its next cursor");
      session.request = snapshotRequest(payload.page.nextCursor, 499);
      session.touchedAt = Date.now();
      return syncStep(session);
    }
    if (!session.bootstrapCursor) throw new CanonicalApiError("Canonical bootstrap cursor was lost; restart sync");
    setSetting(CURSOR_SETTING, session.bootstrapCursor);
    setSetting(LAST_SYNC_SETTING, new Date().toISOString());
    setSetting(LAST_ERROR_SETTING, "");
    const applied = session.applied;
    const cursor = session.bootstrapCursor;
    activeSyncSession = null;
    const result: CanonicalSyncStep = {
      source: "canonical-api",
      mode: "bootstrap",
      applied,
      cursor,
      complete: true,
      requiresCanonicalAuth: false,
      canonicalApi: canonicalApiStatus(),
    };
    return result;
  }

  if (!session.cursor || getSetting(CURSOR_SETTING) !== session.cursor) {
    activeSyncSession = null;
    throw new CanonicalSyncConflictError("Canonical sync cursor changed; restart sync from the latest committed cursor");
  }
  const payload = await forwardCanonicalRequest<{
    changes?: Array<{ operation: string; companyId: string; target: CanonicalTarget | null }>;
    sync?: { nextCursor?: string; hasMore?: boolean };
  }>(session.request, input.authorization, input.actorPubkey, input.fetchImpl);
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const nextCursor = String(payload.sync?.nextCursor ?? "").trim();
  if (!nextCursor) throw new CanonicalApiError("Kindling API change page omitted its next cursor");
  for (const change of changes) {
    if (change.operation === "delete" || !change.target) removeCanonicalTarget(String(change.companyId));
    else upsertCanonicalTarget(change.target);
  }
  session.applied += changes.length;
  session.cursor = nextCursor;
  setSetting(CURSOR_SETTING, nextCursor);
  if (payload.sync?.hasMore) {
    session.request = changesRequest(nextCursor);
    session.touchedAt = Date.now();
    return syncStep(session);
  }

  setSetting(LAST_SYNC_SETTING, new Date().toISOString());
  setSetting(LAST_ERROR_SETTING, "");
  const applied = session.applied;
  activeSyncSession = null;
  const result: CanonicalSyncStep = {
    source: "canonical-api",
    mode: "changes",
    applied,
    cursor: nextCursor,
    complete: true,
    requiresCanonicalAuth: false,
    canonicalApi: canonicalApiStatus(),
  };
  return result;
}

export function prepareCanonicalTargetRequest(companyId: string): CanonicalPreparedRequest {
  const id = companyId.trim();
  if (!id) throw new CanonicalApiError("companyId is required", 400);
  return canonicalRequest(`api/v1/targets/${encodeURIComponent(id)}`);
}

export async function refreshCanonicalTarget(input: {
  companyId: string;
  actorPubkey: string;
  authorization: string;
  fetchImpl?: FetchLike;
}): Promise<CanonicalTarget> {
  const request = prepareCanonicalTargetRequest(input.companyId);
  const payload = await forwardCanonicalRequest<{ item?: CanonicalTarget }>(
    request,
    input.authorization,
    input.actorPubkey,
    input.fetchImpl,
  );
  if (!payload.item?.id) throw new CanonicalApiError("Kindling API target response did not include an item");
  upsertCanonicalTarget(payload.item);
  return payload.item;
}

export function canonicalApiStatus() {
  clearExpiredSyncSession();
  const cache = db.query("SELECT COUNT(*) AS count, MAX(change_seq) AS max_seq FROM canonical_company_cache").get() as
    | { count: number; max_seq: number | null }
    | null;
  const lastSyncAt = getSetting(LAST_SYNC_SETTING) || null;
  const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
  const cacheAgeMs = Number.isFinite(lastSyncMs) ? Math.max(0, Date.now() - lastSyncMs) : null;
  const apiReachable = settingBoolean(API_REACHABLE_SETTING);
  const authorizationState = getSetting(AUTHORIZATION_STATE_SETTING) || "required";
  const syncAuthorized = authorizationState === "authorized" ? true : authorizationState === "denied" ? false : null;
  const cachedCompanies = Number(cache?.count || 0);
  const cacheFresh = KINDLING_COMPANY_SOURCE === "local" || (cacheAgeMs !== null && cacheAgeMs <= KINDLING_CACHE_MAX_AGE_MS);
  const current = KINDLING_COMPANY_SOURCE === "local" || (cachedCompanies > 0 && cacheFresh && apiReachable === true && syncAuthorized === true);
  const cacheState = KINDLING_COMPANY_SOURCE === "local"
    ? "local"
    : cachedCompanies === 0
      ? "empty"
      : current
        ? "current"
        : "stale";
  return {
    companySource: KINDLING_COMPANY_SOURCE,
    apiBaseUrl: canonicalApiBaseUrl(),
    authorizationMode: "browser-nip98-forward",
    authorizationState,
    syncAuthorized,
    lastAuthorizedAt: getSetting(LAST_AUTHORIZED_SETTING) || null,
    apiReachable,
    lastApiAttemptAt: getSetting(LAST_API_ATTEMPT_SETTING) || null,
    syncCursor: getSetting(CURSOR_SETTING) || null,
    lastSyncAt,
    cacheAgeMs,
    cacheMaxAgeMs: KINDLING_CACHE_MAX_AGE_MS,
    cacheFresh,
    current,
    cacheState,
    cachedCompanies,
    maxCachedChangeSeq: cache?.max_seq == null ? null : Number(cache.max_seq),
    syncInProgress: Boolean(activeSyncSession),
    lastError: getSetting(LAST_ERROR_SETTING) || null,
  };
}

export function resetCanonicalSyncStateForTests(): void {
  db.query(`
    DELETE FROM app_settings
    WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run(
    CURSOR_SETTING,
    LAST_SYNC_SETTING,
    LAST_API_ATTEMPT_SETTING,
    API_REACHABLE_SETTING,
    AUTHORIZATION_STATE_SETTING,
    LAST_AUTHORIZED_SETTING,
    LAST_ERROR_SETTING,
  );
  db.query("DELETE FROM canonical_company_cache").run();
  activeSyncSession = null;
}
