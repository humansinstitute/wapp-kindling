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

CREATE TABLE IF NOT EXISTS pipeline_roles (
  role_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active_pipeline_slug TEXT NOT NULL,
  pipeline_label TEXT NOT NULL,
  required_input_fields_json TEXT NOT NULL DEFAULT '[]',
  expected_output_shape TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_verified_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kindling_pipeline_runs (
  id TEXT PRIMARY KEY,
  role_key TEXT NOT NULL,
  local_request_id TEXT NOT NULL,
  autopilot_run_id TEXT,
  status TEXT NOT NULL,
  webhook_token TEXT NOT NULL,
  trigger_payload_json TEXT NOT NULL,
  result_payload_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (role_key) REFERENCES pipeline_roles(role_key)
);

CREATE TABLE IF NOT EXISTS market_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  structured_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  source_references_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES market_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  industry TEXT,
  website TEXT,
  data_ring TEXT NOT NULL DEFAULT 'seed',
  duplicate_status TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'not_started',
  confidence REAL NOT NULL DEFAULT 0,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  summary TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id TEXT PRIMARY KEY,
  industry TEXT NOT NULL,
  location TEXT NOT NULL,
  status TEXT NOT NULL,
  company_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrichment_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_kind TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS target_rankings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  reason TEXT NOT NULL,
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  pitch_text TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
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

const now = Date.now();
const defaultPipelineRoles = [
  ["develop_service_offering", "Develop service offering", "kindling-develop-service-offering", "Develop service offering", "[\"prompt\"]", "market_profile_update"],
  ["scan_target_list", "Scan target list", "kindling-scan-target-list", "Scan target list", "[\"industry\",\"location\"]", "target_scan_result"],
  ["enrich_company", "Enrich company", "kindling-enrich-company", "Enrich company", "[\"companyId\"]", "company_enrichment"],
  ["draft_outreach", "Draft outreach", "kindling-draft-outreach", "Draft outreach", "[\"companyId\"]", "outreach_draft"],
  ["resolve_duplicates", "Resolve duplicates", "kindling-stub-resolve-duplicates", "Stub: Resolve duplicates", "[]", "duplicate_updates"],
  ["find_people", "Find people", "kindling-stub-find-people", "Stub: Find people", "[\"companyId\"]", "people"],
  ["monitor_and_score", "Monitor and score", "kindling-stub-monitor-and-score", "Stub: Monitor and score", "[]", "target_rankings"],
].map(([roleKey, displayName, slug, label, required, expected]) => ({
  roleKey,
  displayName,
  slug,
  label,
  required,
  expected,
}));

export function ensureDefaultPipelineRoles(updatedAt = Date.now()) {
  for (const role of defaultPipelineRoles) {
    db.query(`
      INSERT INTO pipeline_roles(
        role_key, display_name, active_pipeline_slug, pipeline_label, required_input_fields_json, expected_output_shape, enabled, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
      ON CONFLICT(role_key) DO NOTHING
    `).run(role.roleKey, role.displayName, role.slug, role.label, role.required, role.expected, updatedAt);
  }

  for (const [roleKey, oldSlug, newSlug, expected] of [
    ["develop_service_offering", "kindling-stub-develop-service-offering", "kindling-develop-service-offering", "market_profile_update"],
    ["develop_service_offering", "kindling-develop-service-offering-stub", "kindling-develop-service-offering", "market_profile_update"],
    ["scan_target_list", "kindling-stub-scan-target-list", "kindling-scan-target-list", "target_scan_result"],
    ["scan_target_list", "kindling-scan-target-list-stub", "kindling-scan-target-list", "target_scan_result"],
    ["enrich_company", "kindling-stub-enrich-company", "kindling-enrich-company", "company_enrichment"],
    ["enrich_company", "kindling-enrich-company-stub", "kindling-enrich-company", "company_enrichment"],
    ["draft_outreach", "kindling-stub-draft-outreach", "kindling-draft-outreach", "outreach_draft"],
    ["draft_outreach", "kindling-draft-outreach-stub", "kindling-draft-outreach", "outreach_draft"],
  ]) {
    db.query(`
      UPDATE pipeline_roles
      SET active_pipeline_slug = ?3,
          pipeline_label = CASE WHEN pipeline_label = ?2 THEN ?3 ELSE pipeline_label END,
          expected_output_shape = ?4,
          updated_at = ?5
      WHERE role_key = ?1
        AND active_pipeline_slug = ?2
    `).run(roleKey, oldSlug, newSlug, expected, updatedAt);
  }
}

ensureDefaultPipelineRoles(now);

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
