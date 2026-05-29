import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { DB_PATH } from "./config.ts";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  pubkey TEXT PRIMARY KEY,
  npub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  pubkey TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  run_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  trigger_status TEXT NOT NULL,
  autopilot_run_id TEXT,
  webhook_token TEXT NOT NULL,
  trigger_payload_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_rules (
  pubkey TEXT NOT NULL,
  npub TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('read', 'edit')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, role)
);
`);

for (const migration of [
  "ALTER TABLE pipeline_runs ADD COLUMN trigger_payload_json TEXT",
  "DELETE FROM access_rules WHERE role = 'login'",
]) {
  try {
    db.query(migration).run();
  } catch {
    // Column already exists on an existing local demo database.
  }
}

export type Session = {
  token: string;
  pubkey: string;
  expiresAt: number;
};

export type Chat = {
  id: string;
  pubkey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type Message = {
  id: string;
  chatId: string;
  pubkey: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "complete" | "error";
  runId: string | null;
  createdAt: number;
};

export type AppSettings = {
  autopilotUrl: string;
  defaultPipeline: string;
};

export type AccessRole = "read" | "edit";

export type AccessRule = {
  pubkey: string;
  npub: string;
  role: AccessRole;
  createdAt: number;
};

export function mapChat(row: Record<string, unknown>): Chat {
  return {
    id: String(row.id),
    pubkey: String(row.pubkey),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    pubkey: String(row.pubkey),
    role: String(row.role) as Message["role"],
    content: String(row.content),
    status: String(row.status) as Message["status"],
    runId: row.run_id ? String(row.run_id) : null,
    createdAt: Number(row.created_at),
  };
}

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM app_settings WHERE key = ?1").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.query(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function mapAccessRule(row: Record<string, unknown>): AccessRule {
  return {
    pubkey: String(row.pubkey),
    npub: String(row.npub),
    role: String(row.role) as AccessRole,
    createdAt: Number(row.created_at),
  };
}
