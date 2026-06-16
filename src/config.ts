import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const PORT = Number(process.env.PORT || 3000);
export const DB_PATH = process.env.CHAT_WAPP_DB_PATH || join(APP_ROOT, "data/chat-wapp.sqlite");
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PIPELINE_NAME = process.env.CHAT_WAPP_PIPELINE_NAME || "chat-wapp-agent-response";
export const WINGMAN_URL = (process.env.WINGMAN_URL || "").replace(/\/$/, "");
export const PUBLIC_ORIGIN = (process.env.CHAT_WAPP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chat-wapp-local-demo";
export const WAPP_OWNER_NPUB = process.env.WAPP_OWNER_NPUB || "";
export const WAPP_ALLOWED_NPUBS_JSON = process.env.WAPP_ALLOWED_NPUBS_JSON || "[]";
