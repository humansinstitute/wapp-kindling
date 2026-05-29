import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { nip19, verifyEvent, type Event } from "nostr-tools";
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, WAPP_ALLOWED_NPUBS_JSON, WAPP_OWNER_NPUB } from "./config.ts";
import { db, mapAccessRule, type AccessRole, type AccessRule, type Session } from "./db.ts";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const NIP98_KIND = 27235;
const NIP98_MAX_AGE_SECONDS = 5 * 60;

export function normalizePubkey(value: string): string | null {
  const trimmed = value.trim();
  if (HEX_PUBKEY.test(trimmed)) return trimmed;
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub" && typeof decoded.data === "string" ? decoded.data : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
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
  for (const npub of [WAPP_OWNER_NPUB, ...normaliseNpubsFromJson(WAPP_ALLOWED_NPUBS_JSON)]) {
    const pubkey = normalizePubkey(npub);
    if (pubkey) pubkeys.add(pubkey);
  }
  return pubkeys;
}

export function getAccessRules(): AccessRule[] {
  const rows = db.query("SELECT * FROM access_rules ORDER BY role ASC, npub ASC").all() as Record<string, unknown>[];
  return rows.map(mapAccessRule);
}

export function hasConfiguredAccessRules(): boolean {
  const row = db.query("SELECT COUNT(*) AS count FROM access_rules").get() as { count: number } | null;
  return Number(row?.count ?? 0) > 0;
}

export function addAccessRule(pubkey: string, role: AccessRole): AccessRule {
  const now = Date.now();
  const npub = pubkeyToNpub(pubkey);
  db.query(`
    INSERT INTO access_rules(pubkey, npub, role, created_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(pubkey, role) DO UPDATE SET npub = excluded.npub
  `).run(pubkey, npub, role, now);
  return { pubkey, npub, role, createdAt: now };
}

export function removeAccessRule(pubkey: string, role: AccessRole): void {
  db.query("DELETE FROM access_rules WHERE pubkey = ?1 AND role = ?2").run(pubkey, role);
}

export function hasAccess(pubkey: string, role: AccessRole): boolean {
  const ownerPubkey = normalizePubkey(WAPP_OWNER_NPUB);
  if (ownerPubkey && ownerPubkey === pubkey) return true;
  if (initialAllowedPubkeys().has(pubkey) && role === "read") return true;
  if (!hasConfiguredAccessRules()) return true;
  const roles: AccessRole[] = role === "read" ? ["read", "edit"] : ["edit"];
  const placeholders = roles.map((_, index) => `?${index + 2}`).join(", ");
  const row = db.query(`SELECT 1 FROM access_rules WHERE pubkey = ?1 AND role IN (${placeholders}) LIMIT 1`).get(pubkey, ...roles);
  return Boolean(row);
}

export function canLogin(pubkey: string): boolean {
  return hasAccess(pubkey, "read");
}

export function createChallenge(pubkey: string) {
  const now = Date.now();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = now + CHALLENGE_TTL_MS;
  db.query(`
    INSERT INTO login_challenges(pubkey, nonce, expires_at, created_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(pubkey) DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at, created_at = excluded.created_at
  `).run(pubkey, nonce, expiresAt, now);
  return { nonce, expiresAt, content: `chat-wapp-login:${nonce}` };
}

export function verifyLoginEvent(event: Event) {
  if (!normalizePubkey(event.pubkey)) return { ok: false as const, error: "Invalid pubkey" };
  if (!verifyEvent(event)) return { ok: false as const, error: "Invalid signature" };
  const row = db.query("SELECT nonce, expires_at FROM login_challenges WHERE pubkey = ?1").get(event.pubkey) as
    | { nonce: string; expires_at: number }
    | null;
  if (!row) return { ok: false as const, error: "Challenge not found" };
  if (row.expires_at < Date.now()) return { ok: false as const, error: "Challenge expired" };
  if (event.content !== `chat-wapp-login:${row.nonce}`) return { ok: false as const, error: "Challenge mismatch" };
  if (Math.abs(event.created_at * 1000 - Date.now()) > CHALLENGE_TTL_MS) {
    return { ok: false as const, error: "Event timestamp out of range" };
  }
  if (!canLogin(event.pubkey)) {
    return { ok: false as const, error: "This npub is not allowed to log in to this WApp" };
  }

  const now = Date.now();
  const npub = pubkeyToNpub(event.pubkey);
  db.query(`
    INSERT INTO users(pubkey, npub, created_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?3)
    ON CONFLICT(pubkey) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(event.pubkey, npub, now);
  db.query("DELETE FROM login_challenges WHERE pubkey = ?1").run(event.pubkey);

  const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = now + SESSION_TTL_MS;
  db.query("INSERT INTO sessions(token, pubkey, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
    .run(token, event.pubkey, expiresAt, now);

  return { ok: true as const, token, pubkey: event.pubkey, npub, expiresAt };
}

function decodeNip98Token(raw: string | null): Event | null {
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  if (scheme !== "Nostr" || !token) return null;
  try {
    return JSON.parse(atob(token)) as Event;
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function normaliseUrlForNip98(value: string): string | null {
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return null;
  }
}

export async function verifyNip98Request(req: Request, url: URL): Promise<{ ok: true; pubkey: string; npub: string } | { ok: false; error: string }> {
  const event = decodeNip98Token(req.headers.get("authorization"));
  if (!event) return { ok: false, error: "NIP-98 authorization required" };
  if (event.kind !== NIP98_KIND) return { ok: false, error: "Invalid NIP-98 event kind" };
  if (!normalizePubkey(event.pubkey)) return { ok: false, error: "Invalid NIP-98 pubkey" };
  if (!verifyEvent(event)) return { ok: false, error: "Invalid NIP-98 signature" };

  const eventUrl = event.tags.find((tag) => tag[0] === "u")?.[1];
  const eventMethod = event.tags.find((tag) => tag[0] === "method")?.[1];
  if (!eventUrl || normaliseUrlForNip98(eventUrl) !== url.toString()) return { ok: false, error: "NIP-98 URL mismatch" };
  if (!eventMethod || eventMethod.toUpperCase() !== req.method.toUpperCase()) return { ok: false, error: "NIP-98 method mismatch" };
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(event.created_at)) > NIP98_MAX_AGE_SECONDS) {
    return { ok: false, error: "NIP-98 event expired" };
  }

  if (["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) {
    const payload = event.tags.find((tag) => tag[0] === "payload")?.[1];
    const expected = sha256Hex(await req.clone().text());
    if (!payload || payload !== expected) return { ok: false, error: "NIP-98 payload mismatch" };
  }

  return { ok: true, pubkey: event.pubkey, npub: pubkeyToNpub(event.pubkey) };
}

export function getBearerToken(req: Request): string | null {
  const raw = req.headers.get("authorization");
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : null;
}

export function getSession(req: Request): Session | null {
  const token = getBearerToken(req);
  if (!token) return null;
  const row = db.query("SELECT token, pubkey, expires_at FROM sessions WHERE token = ?1").get(token) as
    | { token: string; pubkey: string; expires_at: number }
    | null;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.query("DELETE FROM sessions WHERE token = ?1").run(token);
    return null;
  }
  return { token: row.token, pubkey: row.pubkey, expiresAt: row.expires_at };
}

export function cleanupExpiredAuthRows() {
  const now = Date.now();
  db.query("DELETE FROM sessions WHERE expires_at < ?1").run(now);
  db.query("DELETE FROM login_challenges WHERE expires_at < ?1").run(now);
}
