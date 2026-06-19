import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PORT = Number(process.env.PORT || 3000);
export const KINDLING_DB_MODE = String(process.env.KINDLING_DB_MODE || "").trim().toLowerCase();
export const APP_NSEC = String(process.env.APP_NSEC || "").trim();
export const APP_NPUB = String(process.env.APP_NPUB || "").trim();
export const TOWER_URL = String(process.env.TOWER_URL || "").trim().replace(/\/$/, "");
export const WORKSPACE_OWNER_NPUB = String(process.env.WORKSPACE_OWNER_NPUB || "").trim();

export function isTowerDbRuntime() {
  const mode = String(process.env.KINDLING_DB_MODE || KINDLING_DB_MODE || "").trim().toLowerCase();
  const appNsec = String(process.env.APP_NSEC || APP_NSEC || "").trim();
  const appNpub = String(process.env.APP_NPUB || APP_NPUB || "").trim();
  const towerUrl = String(process.env.TOWER_URL || TOWER_URL || "").trim().replace(/\/$/, "");
  const workspaceOwnerNpub = String(process.env.WORKSPACE_OWNER_NPUB || WORKSPACE_OWNER_NPUB || "").trim();
  return mode === "tower" || mode === "tower-api" || Boolean(appNsec && appNpub && towerUrl && workspaceOwnerNpub);
}

export const IS_TOWER_DB_RUNTIME = isTowerDbRuntime();
export const DB_PATH = IS_TOWER_DB_RUNTIME
  ? ":memory:"
  : process.env.CHAT_WAPP_DB_PATH || join(APP_ROOT, "data/chat-wapp.sqlite");
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PIPELINE_NAME = process.env.CHAT_WAPP_PIPELINE_NAME || "chat-wapp-agent-response";
export const WINGMAN_URL = (process.env.WINGMAN_URL || "").replace(/\/$/, "");
export const PUBLIC_ORIGIN = (process.env.CHAT_WAPP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chat-wapp-local-demo";
export const WAPP_OWNER_NPUB = process.env.WAPP_OWNER_NPUB || "";
export const WAPP_ALLOWED_NPUBS_JSON = process.env.WAPP_ALLOWED_NPUBS_JSON || "[]";
