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

CREATE TABLE IF NOT EXISTS service_offerings (
  id TEXT PRIMARY KEY,
  market_profile_version_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT '',
  structured_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE,
  UNIQUE(market_profile_version_id, key, variant_key)
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  industry TEXT,
  website TEXT,
  data_ring TEXT NOT NULL DEFAULT 'found',
  duplicate_status TEXT NOT NULL DEFAULT 'unknown',
  enrichment_status TEXT NOT NULL DEFAULT 'not_started',
  confidence REAL NOT NULL DEFAULT 0,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_fit_assessments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  service_offering_id TEXT NOT NULL,
  market_profile_version_id TEXT NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  drivers_json TEXT NOT NULL DEFAULT '[]',
  fit_explanation TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  caveats_json TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT NOT NULL DEFAULT '',
  source_run_id TEXT NOT NULL,
  assessment_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (service_offering_id) REFERENCES service_offerings(id) ON DELETE CASCADE,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_run_id) REFERENCES kindling_pipeline_runs(id) ON DELETE CASCADE,
  UNIQUE(company_id, service_offering_id, market_profile_version_id, source_run_id)
);

CREATE TABLE IF NOT EXISTS target_segments (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  label TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK(tier BETWEEN 1 AND 5),
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'parked')),
  default_geo TEXT NOT NULL DEFAULT 'Perth, WA',
  default_target_count INTEGER NOT NULL DEFAULT 100,
  default_batch_size INTEGER NOT NULL DEFAULT 25,
  coverage_targets_json TEXT NOT NULL DEFAULT '{}',
  scan_prompts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES target_segments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS company_segments (
  company_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, segment_id),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id) REFERENCES target_segments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS target_geographies (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'search_text',
  canonical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'parked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES target_geographies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS coverage_slices (
  id TEXT PRIMARY KEY,
  segment_id TEXT,
  geography_id TEXT,
  geography_text TEXT NOT NULL DEFAULT '',
  source_family TEXT NOT NULL DEFAULT 'web',
  strategy_type TEXT NOT NULL DEFAULT 'search',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'stalled')),
  target_counts_json TEXT NOT NULL DEFAULT '{}',
  current_counts_json TEXT NOT NULL DEFAULT '{}',
  yield_metrics_json TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  next_run_after_at INTEGER,
  stalled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (segment_id) REFERENCES target_segments(id) ON DELETE SET NULL,
  FOREIGN KEY (geography_id) REFERENCES target_geographies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scheduler_settings (
  id TEXT PRIMARY KEY CHECK(id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0,
  acquisition_enabled INTEGER NOT NULL DEFAULT 1,
  enrichment_enabled INTEGER NOT NULL DEFAULT 1,
  scoring_enabled INTEGER NOT NULL DEFAULT 1,
  outreach_enabled INTEGER NOT NULL DEFAULT 1,
  target_pool_size INTEGER NOT NULL DEFAULT 10000,
  enriched_floor INTEGER NOT NULL DEFAULT 50,
  top_target_count INTEGER NOT NULL DEFAULT 100,
  per_role_concurrency_json TEXT NOT NULL DEFAULT '{}',
  cooldowns_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL CHECK(status IN ('running', 'skipped', 'complete', 'failed', 'cancelled')),
  selected_action TEXT NOT NULL DEFAULT '',
  skip_reason TEXT NOT NULL DEFAULT '',
  role_key TEXT,
  local_request_id TEXT,
  autopilot_run_id TEXT,
  lock_key TEXT NOT NULL DEFAULT 'prospecting',
  context_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (role_key) REFERENCES pipeline_roles(role_key)
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES scheduler_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  title TEXT,
  summary TEXT NOT NULL,
  extracted_data_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  last_checked_by_run_id TEXT,
  terms_notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customer_profile_versions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed', 'active', 'archived')),
  profile_json TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  activity_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  source_id TEXT,
  source_url TEXT,
  observed_date TEXT,
  strength TEXT NOT NULL DEFAULT 'low',
  confidence REAL NOT NULL DEFAULT 0,
  adapt_relevance TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL
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
  segment_id TEXT,
  geography_id TEXT,
  geography_text TEXT NOT NULL DEFAULT '',
  coverage_slice_id TEXT,
  target_count INTEGER NOT NULL DEFAULT 25,
  scan_mode TEXT NOT NULL DEFAULT 'interactive',
  status TEXT NOT NULL,
  company_count INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (segment_id) REFERENCES target_segments(id) ON DELETE SET NULL,
  FOREIGN KEY (geography_id) REFERENCES target_geographies(id) ON DELETE SET NULL,
  FOREIGN KEY (coverage_slice_id) REFERENCES coverage_slices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scan_strategy_attempts (
  id TEXT PRIMARY KEY,
  discovery_job_id TEXT NOT NULL,
  segment_id TEXT,
  geography_id TEXT,
  geography_text TEXT NOT NULL DEFAULT '',
  coverage_slice_id TEXT,
  source_family TEXT NOT NULL DEFAULT 'web',
  industry TEXT NOT NULL,
  location TEXT NOT NULL,
  strategy_type TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (discovery_job_id) REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id) REFERENCES target_segments(id) ON DELETE SET NULL,
  FOREIGN KEY (geography_id) REFERENCES target_geographies(id) ON DELETE SET NULL,
  FOREIGN KEY (coverage_slice_id) REFERENCES coverage_slices(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS enrichment_requests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  work_queue_id TEXT,
  status TEXT NOT NULL,
  request_kind TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  segment_id TEXT,
  segment TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_after_at INTEGER,
  locked_by_run_id TEXT,
  error TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (segment_id) REFERENCES target_segments(id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS ranking_runs (
  id TEXT PRIMARY KEY,
  ranking_type TEXT NOT NULL DEFAULT 'initial' CHECK(ranking_type IN ('initial')),
  status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  ranked_count INTEGER NOT NULL DEFAULT 0,
  score_version TEXT NOT NULL DEFAULT 'initial-v1',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'local',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_items (
  id TEXT PRIMARY KEY,
  ranking_run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (ranking_run_id) REFERENCES ranking_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  UNIQUE(ranking_run_id, company_id)
);

CREATE TABLE IF NOT EXISTS target_list_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  ranked_count INTEGER NOT NULL DEFAULT 0,
  score_version TEXT NOT NULL DEFAULT 'top-target-v1',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'local',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS target_list_items (
  id TEXT PRIMARY KEY,
  target_list_run_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  service_fit_assessment_id TEXT NOT NULL,
  market_profile_version_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  best_offering_id TEXT NOT NULL,
  best_offering_key TEXT NOT NULL DEFAULT '',
  best_offering_name TEXT NOT NULL DEFAULT '',
  best_variant_key TEXT NOT NULL DEFAULT '',
  why_now TEXT NOT NULL DEFAULT '',
  evidence_quality REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  caveats_json TEXT NOT NULL DEFAULT '[]',
  next_action TEXT NOT NULL DEFAULT '',
  flags_json TEXT NOT NULL DEFAULT '[]',
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (target_list_run_id) REFERENCES target_list_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (service_fit_assessment_id) REFERENCES service_fit_assessments(id) ON DELETE CASCADE,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (best_offering_id) REFERENCES service_offerings(id) ON DELETE CASCADE,
  UNIQUE(target_list_run_id, company_id)
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
  "ALTER TABLE sources ADD COLUMN title TEXT",
  "ALTER TABLE sources ADD COLUMN extracted_data_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE sources ADD COLUMN last_checked_at INTEGER",
  "ALTER TABLE sources ADD COLUMN last_checked_by_run_id TEXT",
  "ALTER TABLE sources ADD COLUMN terms_notes TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE enrichment_requests ADD COLUMN work_queue_id TEXT",
  "ALTER TABLE pipeline_runs ADD COLUMN trigger_payload_json TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN target_count INTEGER NOT NULL DEFAULT 25",
  "ALTER TABLE discovery_jobs ADD COLUMN scan_mode TEXT NOT NULL DEFAULT 'interactive'",
  "ALTER TABLE discovery_jobs ADD COLUMN segment_id TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN geography_id TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN geography_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE discovery_jobs ADD COLUMN coverage_slice_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN segment_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN geography_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN geography_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN coverage_slice_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN source_family TEXT NOT NULL DEFAULT 'web'",
  "ALTER TABLE coverage_slices ADD COLUMN segment_id TEXT",
  "ALTER TABLE coverage_slices ADD COLUMN geography_id TEXT",
  "ALTER TABLE coverage_slices ADD COLUMN geography_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE coverage_slices ADD COLUMN source_family TEXT NOT NULL DEFAULT 'web'",
  "ALTER TABLE coverage_slices ADD COLUMN strategy_type TEXT NOT NULL DEFAULT 'search'",
  "ALTER TABLE work_queue ADD COLUMN segment_id TEXT",
  "ALTER TABLE work_queue ADD COLUMN segment TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE work_queue ADD COLUMN next_run_after_at INTEGER",
  "ALTER TABLE work_queue ADD COLUMN locked_by_run_id TEXT",
  "ALTER TABLE work_queue ADD COLUMN error TEXT NOT NULL DEFAULT ''",
  "UPDATE discovery_jobs SET geography_text = location WHERE geography_text = ''",
  "UPDATE scan_strategy_attempts SET geography_text = location WHERE geography_text = ''",
]) {
  try {
    db.query(migration).run();
  } catch {
    // Column already exists on an existing local demo database.
  }
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_target_segments_parent_priority ON target_segments(parent_id, priority, label);
CREATE INDEX IF NOT EXISTS idx_target_segments_status_priority ON target_segments(status, priority, label);
CREATE INDEX IF NOT EXISTS idx_company_segments_segment ON company_segments(segment_id, confidence);
CREATE INDEX IF NOT EXISTS idx_target_geographies_parent ON target_geographies(parent_id, label);
CREATE INDEX IF NOT EXISTS idx_coverage_slices_segment_geo ON coverage_slices(segment_id, geography_id, source_family, strategy_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_slices_unique_key
  ON coverage_slices(
    COALESCE(segment_id, ''),
    COALESCE(geography_id, ''),
    lower(geography_text),
    lower(source_family),
    lower(strategy_type)
  );
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_coverage ON discovery_jobs(segment_id, coverage_slice_id, geography_id);
CREATE INDEX IF NOT EXISTS idx_scan_strategy_attempts_coverage ON scan_strategy_attempts(coverage_slice_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_updated ON scheduler_runs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_status ON scheduler_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_locks_expiry ON scheduler_locks(lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_work_queue_next ON work_queue(kind, status, next_run_after_at, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_work_queue_target ON work_queue(kind, target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_work_queue_segment ON work_queue(segment_id, segment, priority);
CREATE INDEX IF NOT EXISTS idx_companies_updated_name ON companies(updated_at DESC, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_companies_enrichment_updated ON companies(enrichment_status, updated_at DESC, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_companies_industry_location ON companies(industry, location, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_data_ring ON companies(data_ring, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_duplicate_status ON companies(duplicate_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_companies_website ON companies(website);
CREATE INDEX IF NOT EXISTS idx_enrichment_industry_status ON companies(industry, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_service_offerings_version_status ON service_offerings(market_profile_version_id, status, key, variant_key);
CREATE INDEX IF NOT EXISTS idx_service_fit_assessments_company ON service_fit_assessments(company_id, score DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_fit_assessments_offering ON service_fit_assessments(service_offering_id, market_profile_version_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_check ON sources(last_checked_at, confidence);
CREATE INDEX IF NOT EXISTS idx_customer_profile_versions_company ON customer_profile_versions(company_id, status, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_signals_company ON signals(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source_id);
CREATE INDEX IF NOT EXISTS idx_ranking_runs_type_created ON ranking_runs(ranking_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranking_items_run_rank ON ranking_items(ranking_run_id, rank);
CREATE INDEX IF NOT EXISTS idx_ranking_items_company ON ranking_items(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_target_list_runs_created ON target_list_runs(status, completed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_target_list_items_run_rank ON target_list_items(target_list_run_id, rank);
CREATE INDEX IF NOT EXISTS idx_target_list_items_company ON target_list_items(company_id, created_at DESC);
`);

for (const migration of [
  "ALTER TABLE sources ADD COLUMN title TEXT",
  "ALTER TABLE sources ADD COLUMN extracted_data_json TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE sources ADD COLUMN last_checked_at INTEGER",
  "ALTER TABLE sources ADD COLUMN last_checked_by_run_id TEXT",
  "ALTER TABLE sources ADD COLUMN terms_notes TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE enrichment_requests ADD COLUMN work_queue_id TEXT",
  "ALTER TABLE pipeline_runs ADD COLUMN trigger_payload_json TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN target_count INTEGER NOT NULL DEFAULT 25",
  "ALTER TABLE discovery_jobs ADD COLUMN scan_mode TEXT NOT NULL DEFAULT 'interactive'",
  "ALTER TABLE discovery_jobs ADD COLUMN segment_id TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN geography_id TEXT",
  "ALTER TABLE discovery_jobs ADD COLUMN geography_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE discovery_jobs ADD COLUMN coverage_slice_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN segment_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN geography_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN geography_text TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN coverage_slice_id TEXT",
  "ALTER TABLE scan_strategy_attempts ADD COLUMN source_family TEXT NOT NULL DEFAULT 'web'",
  "UPDATE discovery_jobs SET geography_text = location WHERE geography_text = ''",
  "UPDATE scan_strategy_attempts SET geography_text = location WHERE geography_text = ''",
  "DELETE FROM access_rules WHERE role = 'login'",
  "UPDATE companies SET data_ring = 'found' WHERE data_ring IN ('seed', 'manual', 'discovered')",
  "UPDATE companies SET data_ring = 'enhanced' WHERE data_ring IN ('agent', 'enriched')",
  "UPDATE companies SET data_ring = 'ranked' WHERE data_ring = 'matched'",
  "UPDATE companies SET data_ring = 'outreach_ready' WHERE data_ring = 'outreach'",
  "UPDATE companies SET data_ring = 'found' WHERE data_ring IS NULL OR data_ring = ''",
  `INSERT OR IGNORE INTO work_queue(
    id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
    next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
  )
  SELECT
    er.id,
    'company_enrichment',
    'company',
    er.company_id,
    (
      SELECT cs.segment_id
      FROM company_segments cs
      JOIN target_segments ts ON ts.id = cs.segment_id
      WHERE cs.company_id = er.company_id
      ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
      LIMIT 1
    ),
    COALESCE(NULLIF(c.industry, ''), ''),
    CASE er.request_kind WHEN 'standard' THEN 10 WHEN 'industry_batch' THEN 50 ELSE 100 END,
    CASE WHEN er.status IN ('queued', 'running', 'complete', 'failed', 'cancelled') THEN er.status ELSE 'queued' END,
    COALESCE(NULLIF(er.summary, ''), 'Migrated enrichment request'),
    CASE WHEN er.status IN ('failed', 'complete') THEN 1 ELSE 0 END,
    CASE WHEN er.status = 'failed' THEN er.updated_at ELSE NULL END,
    NULL,
    CASE WHEN er.status = 'failed' THEN COALESCE(NULLIF(er.summary, ''), 'Enrichment request failed') ELSE '' END,
    json_object('enrichmentRequestId', er.id, 'requestKind', er.request_kind, 'migratedFrom', 'enrichment_requests'),
    er.created_at,
    er.updated_at
  FROM enrichment_requests er
  LEFT JOIN companies c ON c.id = er.company_id`,
  "UPDATE enrichment_requests SET work_queue_id = id WHERE work_queue_id IS NULL OR work_queue_id = ''",
]) {
  try {
    db.query(migration).run();
  } catch {
    // Column already exists on an existing local demo database.
  }
}

export function backfillEnrichmentRequestWorkQueue() {
  const createMissingQueueRows = `
    INSERT OR IGNORE INTO work_queue(
      id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
      next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
    )
    SELECT
      er.id,
      'company_enrichment',
      'company',
      er.company_id,
      (
        SELECT cs.segment_id
        FROM company_segments cs
        JOIN target_segments ts ON ts.id = cs.segment_id
        WHERE cs.company_id = er.company_id
        ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
        LIMIT 1
      ),
      COALESCE(NULLIF(c.industry, ''), ''),
      CASE er.request_kind WHEN 'standard' THEN 10 WHEN 'industry_batch' THEN 50 ELSE 100 END,
      CASE WHEN er.status IN ('queued', 'running', 'complete', 'failed', 'cancelled') THEN er.status ELSE 'queued' END,
      COALESCE(NULLIF(er.summary, ''), 'Migrated enrichment request'),
      CASE WHEN er.status IN ('failed', 'complete') THEN 1 ELSE 0 END,
      CASE WHEN er.status = 'failed' THEN er.updated_at ELSE NULL END,
      NULL,
      CASE WHEN er.status = 'failed' THEN COALESCE(NULLIF(er.summary, ''), 'Enrichment request failed') ELSE '' END,
      json_object('enrichmentRequestId', er.id, 'requestKind', er.request_kind, 'migratedFrom', 'enrichment_requests'),
      er.created_at,
      er.updated_at
    FROM enrichment_requests er
    LEFT JOIN companies c ON c.id = er.company_id
  `;
  const linkLegacyRequests = "UPDATE enrichment_requests SET work_queue_id = id WHERE work_queue_id IS NULL OR work_queue_id = ''";
  const transaction = db.transaction(() => {
    db.query(createMissingQueueRows).run();
    db.query(linkLegacyRequests).run();
  });
  transaction();
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

export type SchedulerSettings = {
  enabled: boolean;
  acquisitionEnabled: boolean;
  enrichmentEnabled: boolean;
  scoringEnabled: boolean;
  outreachEnabled: boolean;
  targetPoolSize: number;
  enrichedFloor: number;
  topTargetCount: number;
  perRoleConcurrency: Record<string, number>;
  cooldowns: Record<string, number>;
  createdAt: number;
  updatedAt: number;
};

export type SchedulerSettingsPatch = Partial<Omit<SchedulerSettings, "createdAt" | "updatedAt">>;

export type SchedulerRunStatus = "running" | "skipped" | "complete" | "failed" | "cancelled";

export type SchedulerRun = {
  id: string;
  runType: string;
  status: SchedulerRunStatus;
  selectedAction: string;
  skipReason: string;
  roleKey: string | null;
  localRequestId: string | null;
  autopilotRunId: string | null;
  lockKey: string;
  context: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type SchedulerLock = {
  lockKey: string;
  runId: string;
  ownerId: string;
  leaseExpiresAt: number;
  acquiredAt: number;
  updatedAt: number;
};

export type AccessRole = "read" | "edit";

export type AccessRule = {
  pubkey: string;
  npub: string;
  role: AccessRole;
  createdAt: number;
};

export const COMPANY_DATA_RINGS = [
  "found",
  "enhanced",
  "ranked",
  "scored",
  "outreach_ready",
  "contacted",
  "parked",
  "stale",
] as const;

export type CompanyDataRing = typeof COMPANY_DATA_RINGS[number];

const COMPANY_DATA_RING_ALIASES: Record<string, CompanyDataRing> = {
  seed: "found",
  manual: "found",
  discovered: "found",
  found: "found",
  agent: "enhanced",
  enriched: "enhanced",
  enhanced: "enhanced",
  matched: "ranked",
  ranked: "ranked",
  scored: "scored",
  outreach: "outreach_ready",
  outreach_ready: "outreach_ready",
  contacted: "contacted",
  parked: "parked",
  stale: "stale",
};

export function normalizeCompanyDataRing(value: unknown, fallback: CompanyDataRing = "found"): CompanyDataRing {
  const key = String(value ?? "").trim().toLowerCase();
  return COMPANY_DATA_RING_ALIASES[key] ?? fallback;
}

export function companyDataRingFilterValues(value: unknown): string[] {
  const raw = String(value ?? "");
  const canonical = COMPANY_DATA_RING_ALIASES[raw.trim().toLowerCase()];
  if (!canonical) return raw ? [raw] : [];
  return [
    canonical,
    ...Object.entries(COMPANY_DATA_RING_ALIASES)
      .filter(([, mapped]) => mapped === canonical)
      .map(([alias]) => alias),
  ].filter((item, index, values) => values.indexOf(item) === index);
}

export function normalizeCompanyExecutionStatus(value: unknown, fallback = "not_started") {
  const status = String(value ?? "").trim().toLowerCase();
  return ["not_started", "queued", "running", "complete", "failed"].includes(status) ? status : fallback;
}

function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const defaultSchedulerSettings = {
  enabled: false,
  acquisitionEnabled: true,
  enrichmentEnabled: true,
  scoringEnabled: true,
  outreachEnabled: true,
  targetPoolSize: 10000,
  enrichedFloor: 50,
  topTargetCount: 100,
  perRoleConcurrency: {
    scan_target_list: 1,
    enrich_company: 1,
    enrich_industry_segment: 1,
    monitor_and_score: 1,
    draft_outreach: 1,
  },
  cooldowns: {
    acquisitionMs: 60 * 60 * 1000,
    enrichmentMs: 30 * 60 * 1000,
    scoringMs: 30 * 60 * 1000,
    outreachMs: 30 * 60 * 1000,
    stalledSliceMs: 7 * 24 * 60 * 60 * 1000,
  },
} satisfies SchedulerSettingsPatch;

function normalizeBooleanSetting(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return fallback;
}

function normalizePositiveIntegerSetting(value: unknown, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeIntegerSetting(value: unknown, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeNumberRecord(value: unknown, fallback: Record<string, number>, allowZero = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const normalized: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = key.trim();
    if (!cleanKey) continue;
    const next = allowZero
      ? normalizeNonNegativeIntegerSetting(raw, Number.NaN)
      : normalizePositiveIntegerSetting(raw, Number.NaN);
    if (Number.isFinite(next)) normalized[cleanKey] = next;
  }
  return Object.keys(normalized).length ? normalized : fallback;
}

export function ensureDefaultSchedulerSettings(updatedAt = Date.now()) {
  db.query(`
    INSERT INTO scheduler_settings(
      id, enabled, acquisition_enabled, enrichment_enabled, scoring_enabled, outreach_enabled,
      target_pool_size, enriched_floor, top_target_count, per_role_concurrency_json, cooldowns_json,
      created_at, updated_at
    )
    VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    ON CONFLICT(id) DO NOTHING
  `).run(
    defaultSchedulerSettings.enabled ? 1 : 0,
    defaultSchedulerSettings.acquisitionEnabled ? 1 : 0,
    defaultSchedulerSettings.enrichmentEnabled ? 1 : 0,
    defaultSchedulerSettings.scoringEnabled ? 1 : 0,
    defaultSchedulerSettings.outreachEnabled ? 1 : 0,
    defaultSchedulerSettings.targetPoolSize,
    defaultSchedulerSettings.enrichedFloor,
    defaultSchedulerSettings.topTargetCount,
    JSON.stringify(defaultSchedulerSettings.perRoleConcurrency),
    JSON.stringify(defaultSchedulerSettings.cooldowns),
    updatedAt,
  );
}

function mapSchedulerSettings(row: Record<string, unknown>): SchedulerSettings {
  return {
    enabled: Boolean(Number(row.enabled)),
    acquisitionEnabled: Boolean(Number(row.acquisition_enabled)),
    enrichmentEnabled: Boolean(Number(row.enrichment_enabled)),
    scoringEnabled: Boolean(Number(row.scoring_enabled)),
    outreachEnabled: Boolean(Number(row.outreach_enabled)),
    targetPoolSize: Number(row.target_pool_size),
    enrichedFloor: Number(row.enriched_floor),
    topTargetCount: Number(row.top_target_count),
    perRoleConcurrency: jsonParse<Record<string, number>>(row.per_role_concurrency_json, defaultSchedulerSettings.perRoleConcurrency ?? {}),
    cooldowns: jsonParse<Record<string, number>>(row.cooldowns_json, defaultSchedulerSettings.cooldowns ?? {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getSchedulerSettings(): SchedulerSettings {
  ensureDefaultSchedulerSettings();
  const row = db.query("SELECT * FROM scheduler_settings WHERE id = 'default'").get() as Record<string, unknown> | null;
  if (!row) throw new Error("scheduler settings could not be initialized");
  return mapSchedulerSettings(row);
}

export function updateSchedulerSettings(patch: SchedulerSettingsPatch, updatedAt = Date.now()): SchedulerSettings {
  const current = getSchedulerSettings();
  const next: SchedulerSettings = {
    ...current,
    enabled: normalizeBooleanSetting(patch.enabled, current.enabled),
    acquisitionEnabled: normalizeBooleanSetting(patch.acquisitionEnabled, current.acquisitionEnabled),
    enrichmentEnabled: normalizeBooleanSetting(patch.enrichmentEnabled, current.enrichmentEnabled),
    scoringEnabled: normalizeBooleanSetting(patch.scoringEnabled, current.scoringEnabled),
    outreachEnabled: normalizeBooleanSetting(patch.outreachEnabled, current.outreachEnabled),
    targetPoolSize: normalizePositiveIntegerSetting(patch.targetPoolSize, current.targetPoolSize),
    enrichedFloor: normalizePositiveIntegerSetting(patch.enrichedFloor, current.enrichedFloor),
    topTargetCount: normalizePositiveIntegerSetting(patch.topTargetCount, current.topTargetCount),
    perRoleConcurrency: normalizeNumberRecord(patch.perRoleConcurrency, current.perRoleConcurrency),
    cooldowns: normalizeNumberRecord(patch.cooldowns, current.cooldowns, true),
    updatedAt,
  };
  db.query(`
    UPDATE scheduler_settings
    SET enabled = ?1,
        acquisition_enabled = ?2,
        enrichment_enabled = ?3,
        scoring_enabled = ?4,
        outreach_enabled = ?5,
        target_pool_size = ?6,
        enriched_floor = ?7,
        top_target_count = ?8,
        per_role_concurrency_json = ?9,
        cooldowns_json = ?10,
        updated_at = ?11
    WHERE id = 'default'
  `).run(
    next.enabled ? 1 : 0,
    next.acquisitionEnabled ? 1 : 0,
    next.enrichmentEnabled ? 1 : 0,
    next.scoringEnabled ? 1 : 0,
    next.outreachEnabled ? 1 : 0,
    next.targetPoolSize,
    next.enrichedFloor,
    next.topTargetCount,
    JSON.stringify(next.perRoleConcurrency),
    JSON.stringify(next.cooldowns),
    updatedAt,
  );
  return getSchedulerSettings();
}

function objectJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createSchedulerRun(input: {
  id?: string;
  runType?: string;
  status?: SchedulerRunStatus;
  selectedAction?: string;
  skipReason?: string;
  roleKey?: string | null;
  localRequestId?: string | null;
  autopilotRunId?: string | null;
  lockKey?: string;
  context?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
  now?: number;
}): SchedulerRun {
  const now = input.now ?? Date.now();
  const status = input.status ?? (input.skipReason ? "skipped" : "running");
  const id = input.id ?? crypto.randomUUID();
  db.query(`
    INSERT INTO scheduler_runs(
      id, run_type, status, selected_action, skip_reason, role_key, local_request_id, autopilot_run_id,
      lock_key, context_json, result_json, error, started_at, finished_at, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
  `).run(
    id,
    String(input.runType ?? "scheduled").trim() || "scheduled",
    status,
    String(input.selectedAction ?? "").trim(),
    String(input.skipReason ?? "").trim(),
    input.roleKey ?? null,
    input.localRequestId ?? null,
    input.autopilotRunId ?? null,
    String(input.lockKey ?? "prospecting").trim() || "prospecting",
    JSON.stringify(objectJson(input.context)),
    JSON.stringify(objectJson(input.result)),
    input.error ?? null,
    input.startedAt ?? now,
    input.finishedAt ?? (status === "skipped" ? now : null),
    now,
  );
  const run = getSchedulerRun(id);
  if (!run) throw new Error("scheduler run could not be created");
  return run;
}

function mapSchedulerRun(row: Record<string, unknown>): SchedulerRun {
  return {
    id: String(row.id),
    runType: String(row.run_type),
    status: String(row.status) as SchedulerRunStatus,
    selectedAction: String(row.selected_action ?? ""),
    skipReason: String(row.skip_reason ?? ""),
    roleKey: row.role_key ? String(row.role_key) : null,
    localRequestId: row.local_request_id ? String(row.local_request_id) : null,
    autopilotRunId: row.autopilot_run_id ? String(row.autopilot_run_id) : null,
    lockKey: String(row.lock_key ?? "prospecting"),
    context: jsonParse<Record<string, unknown>>(row.context_json, {}),
    result: jsonParse<Record<string, unknown>>(row.result_json, {}),
    error: String(row.error ?? ""),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getSchedulerRun(id: string): SchedulerRun | null {
  const row = db.query("SELECT * FROM scheduler_runs WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapSchedulerRun(row) : null;
}

export function listSchedulerRuns(limit = 20): SchedulerRun[] {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = db.query(`
    SELECT *
    FROM scheduler_runs
    ORDER BY updated_at DESC
    LIMIT ?1
  `).all(safeLimit) as Record<string, unknown>[];
  return rows.map(mapSchedulerRun);
}

function mapSchedulerLock(row: Record<string, unknown>): SchedulerLock {
  return {
    lockKey: String(row.lock_key),
    runId: String(row.run_id),
    ownerId: String(row.owner_id),
    leaseExpiresAt: Number(row.lease_expires_at),
    acquiredAt: Number(row.acquired_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getSchedulerLock(lockKey = "prospecting"): SchedulerLock | null {
  const row = db.query("SELECT * FROM scheduler_locks WHERE lock_key = ?1").get(lockKey) as Record<string, unknown> | null;
  return row ? mapSchedulerLock(row) : null;
}

export function acquireSchedulerLock(input: {
  runId: string;
  ownerId: string;
  lockKey?: string;
  leaseMs?: number;
  now?: number;
}): SchedulerLock | null {
  const now = input.now ?? Date.now();
  const lockKey = String(input.lockKey ?? "prospecting").trim() || "prospecting";
  const leaseMs = normalizePositiveIntegerSetting(input.leaseMs, 10 * 60 * 1000);
  const leaseExpiresAt = now + leaseMs;
  db.query(`
    INSERT INTO scheduler_locks(lock_key, run_id, owner_id, lease_expires_at, acquired_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    ON CONFLICT(lock_key) DO UPDATE SET
      run_id = excluded.run_id,
      owner_id = excluded.owner_id,
      lease_expires_at = excluded.lease_expires_at,
      acquired_at = excluded.acquired_at,
      updated_at = excluded.updated_at
    WHERE scheduler_locks.lease_expires_at <= ?5
       OR scheduler_locks.run_id = ?2
  `).run(lockKey, input.runId, input.ownerId, leaseExpiresAt, now);
  const lock = getSchedulerLock(lockKey);
  return lock?.runId === input.runId ? lock : null;
}

export function releaseSchedulerLock(lockKey: string, runId: string): boolean {
  const result = db.query("DELETE FROM scheduler_locks WHERE lock_key = ?1 AND run_id = ?2").run(lockKey, runId);
  return result.changes > 0;
}

const defaultTargetSegments = [
  {
    id: "adapt-tier-1-sme-advisory-referral-rich",
    parentId: null,
    label: "Tier 1: SME advisory and referral-rich firms",
    tier: 1,
    priority: 10,
    status: "active",
    targets: { found: 600, enriched: 240, scored: 120, outreachReady: 60 },
    prompts: {
      prompt: "Find Perth and WA SME advisory firms with strong owner relationships, referral paths, and operational improvement pain.",
      synonyms: ["SME advisory", "referral partners", "owner-led advisory", "Perth professional services"],
    },
  },
  {
    id: "adapt-tier-1-financial-planning-wealth",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "Financial planning and wealth advisory",
    tier: 1,
    priority: 11,
    status: "active",
    targets: { found: 100, enriched: 40, scored: 20, outreachReady: 10 },
    prompts: {
      prompt: "Find Perth financial planning and wealth advisory firms serving SME owners and family business clients.",
      synonyms: ["financial planners", "wealth advisory", "investment advice", "retirement planning", "family wealth"],
    },
  },
  {
    id: "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "Accounting, tax, bookkeeping, and business advisory",
    tier: 1,
    priority: 12,
    status: "active",
    targets: { found: 140, enriched: 56, scored: 28, outreachReady: 14 },
    prompts: {
      prompt: "Find Perth accounting, tax, bookkeeping, and business advisory firms with SME client bases.",
      synonyms: ["accountants", "tax accountants", "bookkeepers", "business advisory", "Xero advisors", "MYOB partners"],
    },
  },
  {
    id: "adapt-tier-1-sme-legal-commercial-succession",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "Legal firms serving SMEs, family businesses, succession, commercial law, employment, estate planning, or M&A",
    tier: 1,
    priority: 13,
    status: "active",
    targets: { found: 120, enriched: 48, scored: 24, outreachReady: 12 },
    prompts: {
      prompt: "Find Perth legal firms serving SMEs, family businesses, succession, commercial law, employment, estate planning, or M&A.",
      synonyms: ["commercial lawyers", "SME law firm", "succession planning", "employment law", "estate planning", "M&A lawyers"],
    },
  },
  {
    id: "adapt-tier-1-hr-leadership-organisational-development",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "HR consulting, leadership advisory, and organisational development",
    tier: 1,
    priority: 14,
    status: "active",
    targets: { found: 80, enriched: 32, scored: 16, outreachReady: 8 },
    prompts: {
      prompt: "Find Perth HR consulting, leadership advisory, and organisational development firms working with SME teams.",
      synonyms: ["HR consultants", "leadership advisory", "organisational development", "people advisory", "workplace culture"],
    },
  },
  {
    id: "adapt-tier-1-outsourced-cfo-business-coaching-strategy",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "Outsourced CFO, business coaching, and strategy consulting",
    tier: 1,
    priority: 15,
    status: "active",
    targets: { found: 80, enriched: 32, scored: 16, outreachReady: 8 },
    prompts: {
      prompt: "Find Perth outsourced CFO, business coaching, and strategy consulting firms advising SME owners.",
      synonyms: ["outsourced CFO", "virtual CFO", "business coach", "strategy consultant", "management consultant"],
    },
  },
  {
    id: "adapt-tier-1-insurance-risk-mortgage-finance-brokers",
    parentId: "adapt-tier-1-sme-advisory-referral-rich",
    label: "Insurance, risk, mortgage, finance, and commercial lending brokers with SME owner relationships",
    tier: 1,
    priority: 16,
    status: "active",
    targets: { found: 80, enriched: 32, scored: 16, outreachReady: 8 },
    prompts: {
      prompt: "Find Perth insurance, risk, mortgage, finance, and commercial lending brokers with SME owner relationships.",
      synonyms: ["insurance brokers", "risk advisors", "mortgage brokers", "finance brokers", "commercial lending"],
    },
  },
  {
    id: "adapt-tier-2-owner-led-professional-services",
    parentId: null,
    label: "Tier 2: Owner-led professional services",
    tier: 2,
    priority: 30,
    status: "active",
    targets: { found: 300, enriched: 120, scored: 60, outreachReady: 30 },
    prompts: {
      prompt: "Find Perth owner-led professional services firms with repeated client workflows and administrative bottlenecks.",
      synonyms: ["professional services", "consultancies", "owner-led firms", "Perth advisory firms"],
    },
  },
  {
    id: "adapt-tier-3-operational-smes-scale-pain",
    parentId: null,
    label: "Tier 3: Operational SMEs with scale pain",
    tier: 3,
    priority: 50,
    status: "active",
    targets: { found: 300, enriched: 90, scored: 45, outreachReady: 20 },
    prompts: {
      prompt: "Find Perth operational SMEs showing scale pain, process complexity, and repeatable admin or coordination load.",
      synonyms: ["operational SMEs", "scaling businesses", "process improvement", "workflow automation"],
    },
  },
  {
    id: "adapt-tier-4-regulated-high-trust-services",
    parentId: null,
    label: "Tier 4: Regulated or high-trust service businesses",
    tier: 4,
    priority: 70,
    status: "active",
    targets: { found: 200, enriched: 60, scored: 30, outreachReady: 15 },
    prompts: {
      prompt: "Find Perth regulated or high-trust service businesses where documentation, compliance, and service quality matter.",
      synonyms: ["regulated services", "high-trust services", "compliance-heavy services"],
    },
  },
  {
    id: "adapt-tier-5-later-expansion-opportunistic",
    parentId: null,
    label: "Tier 5: Later expansion or opportunistic segments",
    tier: 5,
    priority: 90,
    status: "parked",
    targets: { found: 100, enriched: 25, scored: 10, outreachReady: 5 },
    prompts: {
      prompt: "Parked expansion segments for later review when core Perth advisory coverage is healthy.",
      synonyms: ["later expansion", "opportunistic segments", "future market tests"],
    },
  },
] as const;

export function ensureDefaultTargetSegments(updatedAt = Date.now()) {
  const insert = db.query(`
    INSERT INTO target_segments(
      id, parent_id, label, tier, priority, status, default_geo, default_target_count, default_batch_size,
      coverage_targets_json, scan_prompts_json, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Perth, WA', ?7, ?8, ?9, ?10, ?11, ?11)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const segment of defaultTargetSegments) {
    insert.run(
      segment.id,
      segment.parentId,
      segment.label,
      segment.tier,
      segment.priority,
      segment.status,
      segment.targets.found,
      Math.min(25, segment.targets.found),
      JSON.stringify(segment.targets),
      JSON.stringify(segment.prompts),
      updatedAt,
    );
  }
}

const now = Date.now();
const defaultPipelineRoles = [
  ["develop_service_offering", "Develop service offering", "kindling-develop-service-offering", "Develop service offering", "[\"prompt\"]", "market_profile_update"],
  ["scan_target_list", "Scan target list", "kindling-scan-target-list", "Scan target list", "[\"industry\",\"location\"]", "target_scan_result"],
  ["enrich_company", "Enrich company", "kindling-enrich-company", "Enrich company", "[\"companyId\"]", "company_enrichment"],
  ["enrich_industry_segment", "Enrich industry segment", "kindling-enrich-industry-segment", "Enrich industry segment", "[\"industry\"]", "industry_enrichment_batch"],
  ["score_company_service_fit", "Score company service fit", "kindling-score-company-service-fit", "Score company service fit", "[\"companyId\",\"serviceOfferingId\"]", "service_fit_assessment"],
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
    ["enrich_industry_segment", "kindling-stub-enrich-industry-segment", "kindling-enrich-industry-segment", "industry_enrichment_batch"],
    ["enrich_industry_segment", "kindling-enrich-industry-segment-stub", "kindling-enrich-industry-segment", "industry_enrichment_batch"],
    ["score_company_service_fit", "kindling-score-company-service-fit-stub", "kindling-score-company-service-fit", "service_fit_assessment"],
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
ensureDefaultTargetSegments(now);
ensureDefaultSchedulerSettings(now);

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
