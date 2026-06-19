import { CHALLENGE_TTL_MS, PIPELINE_NAME, SESSION_TTL_MS, WAPP_ALLOWED_NPUBS_JSON, WAPP_OWNER_NPUB, WINGMAN_URL, isTowerDbRuntime } from "./config.ts";
import { normalizeCompanyDataRing, normalizeCompanyExecutionStatus, type AccessRole, type AccessRule, type AppSettings, type Session } from "./db.ts";
import { TowerDbError, createTowerDbClientFromEnv, type TowerDbClient } from "./tower-db.ts";
import { normalizePubkey, pubkeyToNpub } from "./auth.ts";

type QueryInput = {
  select?: string[];
  where?: Record<string, Record<string, unknown>>;
  order?: Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
};

export type TowerStore = ReturnType<typeof createTowerStore>;

let singleton: TowerStore | null = null;

export function towerStoreEnabled() {
  return isTowerDbRuntime();
}

export function getTowerStore() {
  if (!singleton) singleton = createTowerStore();
  return singleton;
}

export function resetTowerStoreForTests(store: TowerStore | null = null) {
  singleton = store;
}

export function createTowerStore(client: TowerDbClient = createTowerDbClientFromEnv()) {
  const query = async (table: string, input: QueryInput = {}) => {
    const payload = await client.queryRows(table, input as Record<string, unknown>);
    return rowsFromPayload(payload);
  };
  const getById = async (table: string, id: string) => {
    const payload = await ignoreMissingRow(() => client.getRow(table, id));
    return rowFromPayload(payload);
  };
  const create = async (table: string, row: Record<string, unknown>, id = String(row.id ?? row.pubkey ?? row.token ?? row.key ?? "")) => {
    const payload = await client.createRow(table, row, id || undefined);
    return rowFromPayload(payload) ?? row;
  };
  const patch = async (table: string, id: string, set: Record<string, unknown>) => {
    const payload = await client.patchRow(table, id, set);
    return rowFromPayload(payload) ?? { id, ...set };
  };
  const upsert = async (table: string, row: Record<string, unknown>, id = String(row.id ?? row.pubkey ?? row.token ?? row.key ?? "")) => {
    const existing = id ? await getById(table, id) : null;
    if (existing) return patch(table, id, row);
    return create(table, row, id);
  };
  const deleteRow = async (table: string, id: string) => {
    await client.deleteRow(table, id);
  };

  return {
    client,
    query,
    getById,
    create,
    patch,
    upsert,
    deleteRow,
  };
}

async function ignoreMissingRow<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingRowError(error)) return null;
    throw error;
  }
}

function isMissingRowError(error: unknown) {
  if (error instanceof TowerDbError && error.status === 404) return true;
  if (!(error instanceof Error)) return false;
  return /\brow not found\b/i.test(error.message);
}

function rowsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rows = (payload as Record<string, unknown>).rows;
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function rowFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const row = (payload as Record<string, unknown>).row;
  return isRecord(row) ? row : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normaliseNpubsFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function initialAllowedPubkeys(): Set<string> {
  const pubkeys = new Set<string>();
  const ownerNpub = process.env.WAPP_OWNER_NPUB || WAPP_OWNER_NPUB;
  const allowedNpubsJson = process.env.WAPP_ALLOWED_NPUBS_JSON || WAPP_ALLOWED_NPUBS_JSON;
  for (const npub of [ownerNpub, ...normaliseNpubsFromJson(allowedNpubsJson)]) {
    const pubkey = normalizePubkey(npub);
    if (pubkey) pubkeys.add(pubkey);
  }
  return pubkeys;
}

function mapAccessRule(row: Record<string, unknown>): AccessRule {
  return {
    pubkey: String(row.pubkey),
    npub: String(row.npub),
    role: String(row.role) as AccessRole,
    createdAt: Number(row.created_at),
  };
}

export async function towerGetAccessRules(store = getTowerStore()): Promise<AccessRule[]> {
  const rows = await store.query("access_rules", {
    order: [{ field: "role", dir: "asc" }, { field: "npub", dir: "asc" }],
    limit: 500,
  });
  return rows.map(mapAccessRule);
}

export async function towerHasConfiguredAccessRules(store = getTowerStore()) {
  return (await store.query("access_rules", { select: ["pubkey"], limit: 1 })).length > 0;
}

export async function towerAddAccessRule(pubkey: string, role: AccessRole, store = getTowerStore()): Promise<AccessRule> {
  const now = Date.now();
  const npub = pubkeyToNpub(pubkey);
  await store.upsert("access_rules", { pubkey, npub, role, created_at: now }, `${pubkey}:${role}`);
  return { pubkey, npub, role, createdAt: now };
}

export async function towerRemoveAccessRule(pubkey: string, role: AccessRole, store = getTowerStore()) {
  await store.deleteRow("access_rules", `${pubkey}:${role}`);
}

export async function towerHasAccess(pubkey: string, role: AccessRole, store = getTowerStore()) {
  const ownerPubkey = normalizePubkey(process.env.WAPP_OWNER_NPUB || WAPP_OWNER_NPUB);
  if (ownerPubkey && ownerPubkey === pubkey) return true;
  const allowedPubkeys = initialAllowedPubkeys();
  if (allowedPubkeys.has(pubkey) && role === "read") return true;
  const hasAccessRules = await towerHasConfiguredAccessRules(store);
  if (!hasAccessRules && (allowedPubkeys.size > 0 || ownerPubkey)) return false;
  if (!hasAccessRules) return true;
  const roles: AccessRole[] = role === "read" ? ["read", "edit"] : ["edit"];
  const rows = await store.query("access_rules", {
    where: { pubkey: { eq: pubkey }, role: { in: roles } },
    limit: 1,
  });
  return rows.length > 0;
}

export async function towerCreateChallenge(pubkey: string, store = getTowerStore()) {
  const now = Date.now();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = now + CHALLENGE_TTL_MS;
  await store.upsert("login_challenges", { pubkey, nonce, expires_at: expiresAt, created_at: now }, pubkey);
  return { nonce, expiresAt, content: `kindling-login:${nonce}` };
}

export async function towerGetChallenge(pubkey: string, store = getTowerStore()) {
  return await store.getById("login_challenges", pubkey) as { nonce: string; expires_at: number } | null;
}

export async function towerDeleteChallenge(pubkey: string, store = getTowerStore()) {
  await store.deleteRow("login_challenges", pubkey);
}

export async function towerCreateSession(pubkey: string, store = getTowerStore()) {
  const now = Date.now();
  const npub = pubkeyToNpub(pubkey);
  const existingUser = await store.getById("users", pubkey);
  if (existingUser) {
    await store.patch("users", pubkey, { npub, last_seen_at: now });
  } else {
    await store.create("users", { pubkey, npub, created_at: now, last_seen_at: now }, pubkey);
  }
  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = now + SESSION_TTL_MS;
  await store.create("sessions", { token, pubkey, expires_at: expiresAt, created_at: now }, token);
  return { token, pubkey, npub, expiresAt };
}

export async function towerGetSessionToken(token: string, store = getTowerStore()): Promise<Session | null> {
  const row = await store.getById("sessions", token) as { token: string; pubkey: string; expires_at: number } | null;
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  if (expiresAt < Date.now()) {
    await store.deleteRow("sessions", token);
    return null;
  }
  return { token: String(row.token), pubkey: String(row.pubkey), expiresAt };
}

export async function towerGetAppSettings(store = getTowerStore()): Promise<AppSettings> {
  const rows = await store.query("app_settings", { limit: 50 });
  const values = new Map(rows.map((row) => [String(row.key), String(row.value ?? "")]));
  return {
    autopilotUrl: (values.get("autopilotUrl") || WINGMAN_URL || "").replace(/\/$/, ""),
    defaultPipeline: values.get("defaultPipeline") || PIPELINE_NAME,
  };
}

export async function towerSetSetting(key: string, value: string, store = getTowerStore()) {
  await store.upsert("app_settings", { key, value, updated_at: Date.now() }, key);
}

export function mapTowerCompany(row: Record<string, unknown>) {
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
    profile: parseJson<Record<string, unknown>>(row.profile_json, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapTowerCompanyListItem(row: Record<string, unknown>) {
  const company = mapTowerCompany(row);
  const { profile: _profile, ...item } = company;
  return item;
}

export function mapTowerTargetSegment(row: Record<string, unknown>) {
  const coverageTargets = parseJson<Record<string, unknown>>(row.coverage_targets_json, {});
  const scanPrompts = parseJson<Record<string, unknown>>(row.scan_prompts_json, {});
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

export type TowerTargetSegment = ReturnType<typeof mapTowerTargetSegment> & { children?: TowerTargetSegment[] };

export async function towerListTargetSegments(store = getTowerStore()): Promise<TowerTargetSegment[]> {
  const rows = await store.query("target_segments", {
    order: [{ field: "tier", dir: "asc" }, { field: "priority", dir: "asc" }, { field: "label", dir: "asc" }],
    limit: 500,
  });
  return rows.map(mapTowerTargetSegment);
}

export async function towerGetTargetSegment(id: string, store = getTowerStore()) {
  const row = await store.getById("target_segments", id);
  return row ? mapTowerTargetSegment(row) : null;
}

export async function towerCreateTargetSegment(row: Record<string, unknown>, store = getTowerStore()) {
  const created = await store.create("target_segments", row, String(row.id));
  return mapTowerTargetSegment(created);
}

export async function towerPatchTargetSegment(id: string, set: Record<string, unknown>, store = getTowerStore()) {
  const row = await store.patch("target_segments", id, set);
  return mapTowerTargetSegment(row);
}

export async function towerListCompanies(filters: URLSearchParams | null, options: { limit: number; offset: number; compact?: boolean }, store = getTowerStore()) {
  const { where, postFilter } = towerCompanyFilters(filters);
  const rows = await store.query("companies", {
    where,
    order: [{ field: "updated_at", dir: "desc" }, { field: "name", dir: "asc" }],
    limit: options.limit,
    offset: options.offset,
  });
  const filtered = postFilter(rows);
  return filtered.map(options.compact ? mapTowerCompanyListItem : mapTowerCompany);
}

export async function towerCountCompanies(filters: URLSearchParams | null, store = getTowerStore()) {
  const { where, postFilter } = towerCompanyFilters(filters);
  const rows = await store.query("companies", { select: ["id", "name", "website"], where, limit: 500 });
  return postFilter(rows).length;
}

export async function towerGetCompany(id: string, store = getTowerStore()) {
  const row = await store.getById("companies", id);
  return row ? mapTowerCompany(row) : null;
}

export async function towerGetCompanyRow(id: string, store = getTowerStore()) {
  return await store.getById("companies", id);
}

export async function towerCreateCompany(row: Record<string, unknown>, store = getTowerStore()) {
  return mapTowerCompany(await store.create("companies", row, String(row.id)));
}

export async function towerPatchCompany(id: string, set: Record<string, unknown>, store = getTowerStore()) {
  return mapTowerCompany(await store.patch("companies", id, set));
}

export async function towerRecordActivity(targetType: string, targetId: string, actor: string, actionType: string, summary: string, payload: Record<string, unknown> = {}, store = getTowerStore()) {
  const createdAt = Date.now();
  await store.create("activities", {
    id: crypto.randomUUID(),
    target_type: targetType,
    target_id: targetId,
    actor,
    action_type: actionType,
    summary,
    payload_json: JSON.stringify(payload),
    created_at: createdAt,
  });
}

export async function towerListCompanyDetailRows(companyId: string, store = getTowerStore()) {
  const [sources, signals, customerProfileVersions, activities, drafts, serviceFitAssessments, segments] = await Promise.all([
    store.query("sources", { where: { company_id: { eq: companyId } }, order: [{ field: "created_at", dir: "desc" }], limit: 500 }),
    store.query("signals", { where: { company_id: { eq: companyId } }, order: [{ field: "created_at", dir: "desc" }], limit: 500 }),
    store.query("customer_profile_versions", { where: { company_id: { eq: companyId } }, order: [{ field: "version_number", dir: "desc" }, { field: "created_at", dir: "desc" }], limit: 100 }),
    store.query("activities", { where: { target_type: { eq: "company" }, target_id: { eq: companyId } }, order: [{ field: "created_at", dir: "desc" }], limit: 50 }),
    store.query("outreach_drafts", { where: { company_id: { eq: companyId } }, order: [{ field: "updated_at", dir: "desc" }], limit: 100 }),
    store.query("service_fit_assessments", { where: { company_id: { eq: companyId } }, order: [{ field: "updated_at", dir: "desc" }], limit: 100 }),
    store.query("company_segments", { where: { company_id: { eq: companyId } }, order: [{ field: "created_at", dir: "desc" }], limit: 100 }),
  ]);
  return { sources, signals, customerProfileVersions, activities, drafts, serviceFitAssessments, segments };
}

function towerCompanyFilters(filters: URLSearchParams | null) {
  const where: Record<string, Record<string, unknown>> = {};
  const add = (field: string, value: string | null) => {
    if (value && value !== "all") where[field] = { eq: value };
  };
  add("industry", filters?.get("industry") || null);
  add("location", filters?.get("location") || null);
  const dataRing = filters?.get("dataRing") || null;
  if (dataRing) where.data_ring = { in: companyDataRingFilterValues(dataRing) };
  add("duplicate_status", filters?.get("duplicateStatus") || null);
  add("enrichment_status", filters?.get("enrichmentStatus") || null);
  const hasWebsite = filters?.get("hasWebsite");
  const query = String(filters?.get("q") || filters?.get("search") || "").trim().toLowerCase();
  const postFilter = (rows: Record<string, unknown>[]) => rows.filter((row) => {
    if (hasWebsite === "yes" && !String(row.website ?? "").trim()) return false;
    if (hasWebsite === "no" && String(row.website ?? "").trim()) return false;
    if (query && !String(row.name ?? "").toLowerCase().includes(query)) return false;
    return true;
  });
  return { where, postFilter };
}

function companyDataRingFilterValues(value: string) {
  if (value === "manual") return ["found", "enhanced", "ranked"];
  if (value === "enriched") return ["enhanced", "ranked", "scored", "outreach_ready", "outreach", "contacted"];
  if (value === "outreach") return ["outreach_ready", "outreach", "contacted"];
  return [value];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
