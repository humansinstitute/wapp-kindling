CREATE TABLE IF NOT EXISTS users (
  pubkey text PRIMARY KEY,
  npub text NOT NULL,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  pubkey text PRIMARY KEY,
  nonce text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  pubkey text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id text PRIMARY KEY,
  pubkey text NOT NULL,
  title text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  pubkey text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'complete',
  run_id text,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  user_message_id text NOT NULL,
  assistant_message_id text NOT NULL,
  trigger_status text NOT NULL,
  autopilot_run_id text,
  webhook_token text NOT NULL,
  trigger_payload_json text,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS access_rules (
  pubkey text NOT NULL,
  npub text NOT NULL,
  role text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (pubkey, role)
);

CREATE TABLE IF NOT EXISTS pipeline_roles (
  role_key text PRIMARY KEY,
  display_name text NOT NULL,
  active_pipeline_slug text NOT NULL,
  pipeline_label text NOT NULL,
  required_input_fields_json text NOT NULL DEFAULT '[]',
  expected_output_shape text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  last_verified_at bigint,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS kindling_pipeline_runs (
  id text PRIMARY KEY,
  role_key text NOT NULL,
  local_request_id text NOT NULL,
  autopilot_run_id text,
  status text NOT NULL,
  webhook_token text NOT NULL,
  trigger_payload_json text NOT NULL,
  result_payload_json text,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS market_profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  current_version_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS market_profile_versions (
  id text PRIMARY KEY,
  profile_id text NOT NULL,
  version_number integer NOT NULL,
  structured_json text NOT NULL,
  summary text NOT NULL,
  rationale text NOT NULL,
  source_references_json text NOT NULL DEFAULT '[]',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS service_offerings (
  id text PRIMARY KEY,
  market_profile_version_id text NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  variant_key text NOT NULL DEFAULT '',
  structured_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  name text NOT NULL,
  location text,
  industry text,
  website text,
  data_ring text NOT NULL DEFAULT 'found',
  duplicate_status text NOT NULL DEFAULT 'unknown',
  enrichment_status text NOT NULL DEFAULT 'not_started',
  confidence double precision NOT NULL DEFAULT 0,
  profile_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS target_segments (
  id text PRIMARY KEY,
  parent_id text,
  label text NOT NULL,
  tier integer NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active',
  default_geo text NOT NULL DEFAULT 'Perth, WA',
  default_target_count integer NOT NULL DEFAULT 100,
  default_batch_size integer NOT NULL DEFAULT 25,
  coverage_targets_json text NOT NULL DEFAULT '{}',
  scan_prompts_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS company_segments (
  company_id text NOT NULL,
  segment_id text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  created_at bigint NOT NULL,
  PRIMARY KEY (company_id, segment_id)
);

CREATE TABLE IF NOT EXISTS target_geographies (
  id text PRIMARY KEY,
  parent_id text,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'search_text',
  canonical_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS coverage_slices (
  id text PRIMARY KEY,
  segment_id text,
  geography_id text,
  geography_text text NOT NULL DEFAULT '',
  source_family text NOT NULL DEFAULT 'web',
  strategy_type text NOT NULL DEFAULT 'search',
  status text NOT NULL DEFAULT 'active',
  target_counts_json text NOT NULL DEFAULT '{}',
  current_counts_json text NOT NULL DEFAULT '{}',
  yield_metrics_json text NOT NULL DEFAULT '{}',
  last_run_at bigint,
  next_run_after_at bigint,
  stalled_reason text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_settings (
  id text PRIMARY KEY,
  enabled integer NOT NULL DEFAULT 0,
  acquisition_enabled integer NOT NULL DEFAULT 1,
  enrichment_enabled integer NOT NULL DEFAULT 1,
  scoring_enabled integer NOT NULL DEFAULT 1,
  outreach_enabled integer NOT NULL DEFAULT 1,
  target_pool_size integer NOT NULL DEFAULT 10000,
  enriched_floor integer NOT NULL DEFAULT 50,
  top_target_count integer NOT NULL DEFAULT 100,
  outreach_target_count integer NOT NULL DEFAULT 100,
  per_role_concurrency_json text NOT NULL DEFAULT '{}',
  cooldowns_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id text PRIMARY KEY,
  run_type text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL,
  selected_action text NOT NULL DEFAULT '',
  skip_reason text NOT NULL DEFAULT '',
  role_key text,
  local_request_id text,
  autopilot_run_id text,
  lock_key text NOT NULL DEFAULT 'prospecting',
  context_json text NOT NULL DEFAULT '{}',
  result_json text NOT NULL DEFAULT '{}',
  error text,
  started_at bigint NOT NULL,
  finished_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_key text PRIMARY KEY,
  run_id text NOT NULL,
  owner_id text NOT NULL,
  lease_expires_at bigint NOT NULL,
  acquired_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  source_type text NOT NULL,
  url text,
  title text,
  summary text NOT NULL,
  extracted_data_json text NOT NULL DEFAULT '{}',
  confidence double precision NOT NULL DEFAULT 0,
  last_checked_at bigint,
  last_checked_by_run_id text,
  terms_notes text NOT NULL DEFAULT '',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_profile_versions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  profile_json text NOT NULL,
  change_summary text NOT NULL DEFAULT '',
  source_ids_json text NOT NULL DEFAULT '[]',
  activity_ids_json text NOT NULL DEFAULT '[]',
  created_by text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  signal_type text NOT NULL,
  summary text NOT NULL,
  source_id text,
  source_url text,
  observed_date text,
  strength text NOT NULL DEFAULT 'low',
  confidence double precision NOT NULL DEFAULT 0,
  adapt_relevance text NOT NULL DEFAULT '',
  evidence_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id text PRIMARY KEY,
  target_type text NOT NULL,
  target_id text NOT NULL,
  actor text NOT NULL,
  action_type text NOT NULL,
  summary text NOT NULL,
  payload_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id text PRIMARY KEY,
  industry text NOT NULL,
  location text NOT NULL,
  segment_id text,
  geography_id text,
  geography_text text NOT NULL DEFAULT '',
  coverage_slice_id text,
  target_count integer NOT NULL DEFAULT 25,
  scan_mode text NOT NULL DEFAULT 'interactive',
  status text NOT NULL,
  company_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  summary text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_strategy_attempts (
  id text PRIMARY KEY,
  discovery_job_id text NOT NULL,
  segment_id text,
  geography_id text,
  geography_text text NOT NULL DEFAULT '',
  coverage_slice_id text,
  source_family text NOT NULL DEFAULT 'web',
  industry text NOT NULL,
  location text NOT NULL,
  strategy_type text NOT NULL,
  query text NOT NULL,
  status text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  payload_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS enrichment_requests (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  work_queue_id text,
  status text NOT NULL,
  request_kind text NOT NULL,
  summary text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS work_queue (
  id text PRIMARY KEY,
  kind text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  segment_id text,
  segment text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  attempts integer NOT NULL DEFAULT 0,
  next_run_after_at bigint,
  locked_by_run_id text,
  error text NOT NULL DEFAULT '',
  context_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS service_fit_assessments (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  service_offering_id text NOT NULL,
  market_profile_version_id text NOT NULL,
  score double precision NOT NULL,
  band text NOT NULL,
  confidence double precision NOT NULL DEFAULT 0,
  drivers_json text NOT NULL DEFAULT '[]',
  fit_explanation text NOT NULL DEFAULT '',
  evidence_json text NOT NULL DEFAULT '[]',
  caveats_json text NOT NULL DEFAULT '[]',
  recommended_action text NOT NULL DEFAULT '',
  source_run_id text NOT NULL,
  assessment_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS target_rankings (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  rank integer NOT NULL,
  reason text NOT NULL,
  score_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_runs (
  id text PRIMARY KEY,
  ranking_type text NOT NULL DEFAULT 'initial',
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  candidate_count integer NOT NULL DEFAULT 0,
  ranked_count integer NOT NULL DEFAULT 0,
  score_version text NOT NULL DEFAULT 'initial-v1',
  parameters_json text NOT NULL DEFAULT '{}',
  created_by text NOT NULL DEFAULT 'local',
  started_at bigint NOT NULL,
  completed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_items (
  id text PRIMARY KEY,
  ranking_run_id text NOT NULL,
  company_id text NOT NULL,
  rank integer NOT NULL,
  score double precision NOT NULL,
  reason text NOT NULL,
  score_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS target_list_runs (
  id text PRIMARY KEY,
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  candidate_count integer NOT NULL DEFAULT 0,
  ranked_count integer NOT NULL DEFAULT 0,
  score_version text NOT NULL DEFAULT 'top-target-v1',
  parameters_json text NOT NULL DEFAULT '{}',
  created_by text NOT NULL DEFAULT 'local',
  started_at bigint NOT NULL,
  completed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS target_list_items (
  id text PRIMARY KEY,
  target_list_run_id text NOT NULL,
  company_id text NOT NULL,
  service_fit_assessment_id text NOT NULL,
  market_profile_version_id text NOT NULL,
  rank integer NOT NULL,
  score double precision NOT NULL,
  reason text NOT NULL,
  best_offering_id text NOT NULL,
  best_offering_key text NOT NULL DEFAULT '',
  best_offering_name text NOT NULL DEFAULT '',
  best_variant_key text NOT NULL DEFAULT '',
  why_now text NOT NULL DEFAULT '',
  evidence_quality double precision NOT NULL DEFAULT 0,
  confidence double precision NOT NULL DEFAULT 0,
  caveats_json text NOT NULL DEFAULT '[]',
  next_action text NOT NULL DEFAULT '',
  flags_json text NOT NULL DEFAULT '[]',
  score_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  pitch_text text NOT NULL,
  status text NOT NULL,
  source_run_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
