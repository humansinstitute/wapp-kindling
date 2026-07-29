import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { KINDLING_API_URL, KINDLING_COMPANY_SOURCE } from "./config.ts";
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

type FetchLike = typeof fetch;
type SecretInput = string | Uint8Array;
export type CanonicalRequestOptions = {
  method?: string;
  body?: unknown;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  secretInput?: SecretInput;
  sourceMode?: "canonical-api" | "local";
};

const CURSOR_SETTING = "canonicalApiSyncCursor";
const LAST_SYNC_SETTING = "canonicalApiLastSyncAt";
let syncPromise: Promise<CanonicalSyncResult> | null = null;
let lastSyncError = "";

export function canonicalApiBaseUrl(value = KINDLING_API_URL): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("KINDLING_API_URL must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function secretKeyFromInput(input: SecretInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(Buffer.from(value, "hex"));
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("Kindling FE requires its own valid WAPP_NSEC for canonical API access");
}

function configuredSecretKey(): Uint8Array {
  return secretKeyFromInput(process.env.WAPP_NSEC || "");
}

export function buildCanonicalNip98Authorization(
  url: string,
  method = "GET",
  bodyText = "",
  secretInput: SecretInput = configuredSecretKey(),
  createdAt = Math.floor(Date.now() / 1000),
): string {
  const upperMethod = method.toUpperCase();
  const tags: string[][] = [["u", new URL(url).toString()], ["method", upperMethod]];
  if (["POST", "PUT", "PATCH"].includes(upperMethod)) {
    tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(bodyText)))]);
  }
  const event = finalizeEvent({ kind: 27235, created_at: createdAt, tags, content: "" }, secretKeyFromInput(secretInput));
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

export function canonicalSignerNpub(secretInput: SecretInput = configuredSecretKey()): string {
  return nip19.npubEncode(getPublicKey(secretKeyFromInput(secretInput)));
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
  // Preserve local workflow history and FK targets, but remove the company from
  // canonical-backed reads by deleting only its authority/cache marker.
  db.query("DELETE FROM canonical_company_cache WHERE company_id = ?1").run(companyId);
}

async function canonicalRequest<T>(
  path: string,
  options: CanonicalRequestOptions = {},
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const baseUrl = canonicalApiBaseUrl(options.baseUrl);
  const url = new URL(path, `${baseUrl}/`).toString();
  const bodyText = options.body === undefined ? "" : JSON.stringify(options.body);
  const authorization = buildCanonicalNip98Authorization(url, method, bodyText, options.secretInput ?? configuredSecretKey());
  const response = await (options.fetchImpl || fetch)(url, {
    method,
    headers: { accept: "application/json", authorization, ...(bodyText ? { "content-type": "application/json" } : {}) },
    body: bodyText || undefined,
  });
  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 500) };
  }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? JSON.stringify(payload) : String(payload);
    throw new Error(`Kindling API ${method} ${new URL(url).pathname} failed (${response.status}): ${detail}`);
  }
  return payload as T;
}

export async function fetchCanonicalTarget(companyId: string, options: CanonicalRequestOptions = {}): Promise<CanonicalTarget> {
  const payload = await canonicalRequest<{ item: CanonicalTarget }>(`api/v1/targets/${encodeURIComponent(companyId)}`, options);
  upsertCanonicalTarget(payload.item);
  return payload.item;
}

export async function fetchCanonicalTargetsBulk(ids: string[], options: CanonicalRequestOptions = {}) {
  return canonicalRequest<{ items: CanonicalTarget[]; missingIds: string[] }>("api/v1/targets/bulk", {
    ...options,
    method: "POST",
    body: { ids, include: "detail" },
  });
}

export type CanonicalSyncResult = {
  source: "canonical-api" | "local";
  mode: "bootstrap" | "changes" | "compatibility";
  cursor: string | null;
  applied: number;
};

async function runCanonicalSync(options: CanonicalRequestOptions = {}): Promise<CanonicalSyncResult> {
  if ((options.sourceMode ?? KINDLING_COMPANY_SOURCE) === "local") {
    return { source: "local", mode: "compatibility", cursor: null, applied: 0 };
  }
  const storedCursor = getSetting(CURSOR_SETTING);
  let applied = 0;
  if (!storedCursor) {
    const bootstrap = await canonicalRequest<{
      sync: { currentCursor: string };
      snapshot: { recommendedPageSize?: number };
    }>("api/v1/bootstrap", options);
    let pageCursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: String(bootstrap.snapshot.recommendedPageSize || 500) });
      if (pageCursor) query.set("cursor", pageCursor);
      const page = await canonicalRequest<{
        items: CanonicalTarget[];
        page: { nextCursor: string | null; hasMore: boolean };
      }>(`api/v1/targets?${query}`, options);
      for (const target of page.items) upsertCanonicalTarget(target);
      applied += page.items.length;
      pageCursor = page.page.hasMore ? page.page.nextCursor : null;
    } while (pageCursor);
    setSetting(CURSOR_SETTING, bootstrap.sync.currentCursor);
    setSetting(LAST_SYNC_SETTING, new Date().toISOString());
    return { source: "canonical-api", mode: "bootstrap", cursor: bootstrap.sync.currentCursor, applied };
  }

  let cursor = storedCursor;
  let hasMore = false;
  do {
    const payload = await canonicalRequest<{
      changes: Array<{ operation: string; companyId: string; target: CanonicalTarget | null }>;
      sync: { nextCursor: string; hasMore: boolean };
    }>(`api/v1/targets/changes?since=${encodeURIComponent(cursor)}&limit=500&include=summary`, options);
    for (const change of payload.changes) {
      if (change.operation === "delete" || !change.target) removeCanonicalTarget(change.companyId);
      else upsertCanonicalTarget(change.target);
    }
    applied += payload.changes.length;
    cursor = payload.sync.nextCursor;
    hasMore = payload.sync.hasMore;
    // Cursor advances only after every change in the page is committed.
    setSetting(CURSOR_SETTING, cursor);
  } while (hasMore);
  setSetting(LAST_SYNC_SETTING, new Date().toISOString());
  return { source: "canonical-api", mode: "changes", cursor, applied };
}

export async function syncCanonicalCompanies(options: CanonicalRequestOptions = {}): Promise<CanonicalSyncResult> {
  if (!syncPromise) {
    syncPromise = runCanonicalSync(options)
      .then((result) => {
        lastSyncError = "";
        return result;
      })
      .catch((error) => {
        lastSyncError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        syncPromise = null;
      });
  }
  return syncPromise;
}

export function canonicalApiStatus() {
  const cache = db.query("SELECT COUNT(*) AS count, MAX(change_seq) AS max_seq FROM canonical_company_cache").get() as
    | { count: number; max_seq: number | null }
    | null;
  let signerNpub: string | null = null;
  try {
    signerNpub = canonicalSignerNpub();
  } catch {
    // Health reports signer readiness without exposing the secret.
  }
  return {
    companySource: KINDLING_COMPANY_SOURCE,
    apiBaseUrl: canonicalApiBaseUrl(),
    syncCursor: getSetting(CURSOR_SETTING),
    lastSyncAt: getSetting(LAST_SYNC_SETTING),
    cachedCompanies: Number(cache?.count || 0),
    maxCachedChangeSeq: cache?.max_seq == null ? null : Number(cache.max_seq),
    signerReady: Boolean(signerNpub),
    signerNpub,
    lastError: lastSyncError || null,
  };
}

export function resetCanonicalSyncStateForTests(): void {
  db.query("DELETE FROM canonical_company_cache").run();
  db.query("DELETE FROM app_settings WHERE key IN (?1, ?2)").run(CURSOR_SETTING, LAST_SYNC_SETTING);
  lastSyncError = "";
  syncPromise = null;
}
