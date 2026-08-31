import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PORT = Number(process.env.PORT || 3000);
export const KINDLING_DB_MODE = String(process.env.WAPP_DB_MODE || process.env.KINDLING_DB_MODE || "").trim().toLowerCase();
export const APP_NPUB = String(process.env.WAPP_APP_NPUB || process.env.APP_NPUB || "").trim();
export const TOWER_URL = String(process.env.TOWER_URL || "").trim().replace(/\/$/, "");
export const WORKSPACE_OWNER_NPUB = String(process.env.WORKSPACE_OWNER_NPUB || "").trim();
export const WAPP_TOWER_DB_BROKER_URL = String(process.env.WAPP_TOWER_DB_BROKER_URL || "").trim();
export const WAPP_TOWER_DB_CAPABILITY = String(process.env.WAPP_TOWER_DB_CAPABILITY || "").trim();

export function isTowerDbRuntime() {
  const mode = String(process.env.WAPP_DB_MODE || process.env.KINDLING_DB_MODE || KINDLING_DB_MODE || "").trim().toLowerCase();
  const brokerUrl = String(process.env.WAPP_TOWER_DB_BROKER_URL || WAPP_TOWER_DB_BROKER_URL || "").trim();
  const capability = String(process.env.WAPP_TOWER_DB_CAPABILITY || WAPP_TOWER_DB_CAPABILITY || "").trim();
  return mode === "tower" || mode === "tower-api" || Boolean(brokerUrl && capability);
}

export const IS_TOWER_DB_RUNTIME = isTowerDbRuntime();
export const DB_PATH = IS_TOWER_DB_RUNTIME
  ? ":memory:"
  : process.env.CHAT_WAPP_DB_PATH || join(APP_ROOT, "data/chat-wapp.sqlite");
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PIPELINE_NAME = process.env.CHAT_WAPP_PIPELINE_NAME || "kindling-ask-athena";
export const WINGMAN_URL = (process.env.WINGMAN_URL || "").replace(/\/$/, "");
export const PUBLIC_ORIGIN = (process.env.CHAT_WAPP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chat-wapp-local-demo";
export const WAPP_OWNER_NPUB = process.env.WAPP_OWNER_NPUB || "";
export const WAPP_ALLOWED_NPUBS_JSON = process.env.WAPP_ALLOWED_NPUBS_JSON || "[]";

function normalizeHttpBaseUrl(value: string, fallback: string): string {
  try {
    const parsed = new URL(value.trim() || fallback);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

// The local WApp-owned Kindling API port is the safe development default.
// Autopilot injects the public/canonical URL for managed runtime operation.
export const KINDLING_API_URL = normalizeHttpBaseUrl(
  process.env.KINDLING_API_URL || "",
  "http://127.0.0.1:41038",
);
const configuredCacheMaxAgeMs = Number(process.env.KINDLING_CACHE_MAX_AGE_MS || 15 * 60 * 1000);
export const KINDLING_CACHE_MAX_AGE_MS = Number.isFinite(configuredCacheMaxAgeMs) && configuredCacheMaxAgeMs > 0
  ? configuredCacheMaxAgeMs
  : 15 * 60 * 1000;
export const KINDLING_COMPANY_SOURCE = process.env.KINDLING_COMPANY_SOURCE === "local"
  ? "local"
  : "canonical-api";
