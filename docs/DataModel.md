# Kindling Data Model and API Contract

## Scope

Kindling stores three linked datasets:

- The owner company running Kindling.
- Market profiles for the owner company. Each profile targets a specific segment, such as SME Manufacturing or SME Accounting, and each profile has its own version history.
- Prospective customer records, sources, people, match results, outreach drafts, and follow-up history.

All persisted API identifiers are UUID strings. Timestamps are Unix milliseconds in SQLite rows and ISO-8601 strings in JSON examples unless an existing endpoint already returns milliseconds.

## SQLite Tables

### `owner_companies`

Stores the organisation running Kindling.

```sql
CREATE TABLE owner_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  location TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

JSON shape:

```json
{
  "id": "a2dd40fd-5a11-46d6-a1e6-b6b1f6a568b8",
  "name": "Adapt by Design",
  "website": "https://adaptbydesign.example",
  "location": "Perth, WA",
  "summary": "Adapt helps businesses improve workflows with practical AI, automation, training, and implementation support.",
  "createdAt": 1780876800000,
  "updatedAt": 1780876800000
}
```

### `market_profiles`

Stores one market profile for the owner company. An owner company can have many market profiles, for example `sme_manufacturing` and `sme_accounting`.

```sql
CREATE TABLE market_profiles (
  id TEXT PRIMARY KEY,
  owner_company_id TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  name TEXT NOT NULL,
  target_segment TEXT NOT NULL,
  current_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_company_id) REFERENCES owner_companies(id) ON DELETE CASCADE,
  UNIQUE(owner_company_id, profile_key)
);
```

JSON shape:

```json
{
  "id": "586e57f9-c90a-48f7-a55d-14e2f6f08f19",
  "ownerCompanyId": "a2dd40fd-5a11-46d6-a1e6-b6b1f6a568b8",
  "profileKey": "sme_accounting",
  "name": "SME Accounting Profile",
  "targetSegment": "SME accounting firms in Western Australia",
  "currentVersionId": "538b52f0-f52d-4f10-927e-77f978abf184",
  "createdAt": 1780876800000,
  "updatedAt": 1780876800000
}
```

### `market_profile_versions`

Stores versioned positioning, services, and matching data for one market profile. Matching and outreach use the active version referenced by `market_profiles.current_version_id`.

```sql
CREATE TABLE market_profile_versions (
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
```

`structured_json` shape:

```json
{
  "profile": {
    "profileKey": "sme_accounting",
    "name": "SME Accounting Profile",
    "targetSegment": "SME accounting firms in Western Australia"
  },
  "positioning": {
    "statement": "Practical AI and workflow improvement for accounting firms carrying manual client follow-up and recurring admin load.",
    "proofPoints": ["Workshop delivery", "Workflow automation", "Wingman implementation experience"]
  },
  "services": [
    {
      "id": "c94f91ca-7c1e-4c74-a588-f0cadf3cab4a",
      "key": "ai_workflow_consulting",
      "name": "AI workflow consulting",
      "description": "Identify and design practical AI-enabled process improvements.",
      "outcomes": ["Less manual follow-up", "Better operational visibility"],
      "deliveryModes": ["workshop", "implementation"],
      "typicalBudgetBand": "5k-20k"
    }
  ],
  "idealCustomerProfile": {
    "industries": ["accounting", "bookkeeping", "business_advisory"],
    "employeeCountBuckets": ["5-20", "20-50", "50-100"],
    "locations": ["Perth", "Western Australia"],
    "positiveSignals": ["manual client follow-up", "public AI interest", "recurring compliance workload"],
    "exclusionRules": ["no public business footprint", "consumer-only microbusiness"]
  },
  "buyingTriggers": [
    {
      "key": "ai_interest",
      "label": "Public interest in AI or automation",
      "weight": 0.8
    }
  ],
  "outreachVoice": {
    "tone": "plain-spoken",
    "directness": "medium",
    "proofThreshold": "source_backed_claims_only"
  },
  "matchingRules": [
    {
      "serviceKey": "ai_workflow_consulting",
      "customerFields": ["industry", "size.employeeCountBucket", "sources.sourceType", "activities.activityType"],
      "positiveEvidence": ["AI interest", "manual workflow pain", "service business complexity"]
    }
  ]
}
```

### `service_offerings`

Extracted scoring identities for the services and variants in one market profile version. `market_profile_versions.structured_json` remains the source profile document, while `service_offerings` gives scoring stable row IDs and keys. Rows are version-tied, so assessments created later can keep referencing the exact offering identity from the profile version they were scored against.

```sql
CREATE TABLE service_offerings (
  id TEXT PRIMARY KEY,
  market_profile_version_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  variant_key TEXT NOT NULL DEFAULT '',
  structured_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE,
  UNIQUE(market_profile_version_id, key, variant_key)
);
```

Default active scoring identities include service lines for AI consulting, Wingman implementations, custom WApps, and training, plus positioning variants for scale, exit, succession, handover, maximizing value, and reducing owner dependence. Profile JSON can add or override extracted rows for a specific version.

### `service_fit_assessments`

Stores one service-fit score for a company against one stable service-offering identity and market profile version. Writes are idempotent per company, service offering, market profile version, and Kindling run, so a retried callback updates the same assessment while a later scoring run can create a new audit row.

```sql
CREATE TABLE service_fit_assessments (
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
  UNIQUE(company_id, service_offering_id, market_profile_version_id, source_run_id)
);
```

Evidence and caveats are stored with the score because the assessment must remain interpretable after later top-target aggregation or profile changes.

### `companies`

Stores prospective customers.

```sql
CREATE TABLE companies (
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
```

Allowed `data_ring` values:

- `found`: public customer record exists with at least a name and source, website, or directory reference.
- `enhanced`: source-backed customer profile has been generated.
- `ranked`: initial priority score exists for deeper scoring selection.
- `scored`: one or more service-offering fit assessments exist.
- `outreach_ready`: outreach approach or draft exists and can be reviewed.
- `contacted`: outreach activity has happened.
- `parked`: customer is not currently useful for matching or outreach.
- `stale`: previously useful data needs re-enrichment or rescoring.

Compatibility mapping for older stored or incoming values:

- `seed`, `manual`, and `discovered` map to `found`.
- `agent` and `enriched` map to `enhanced`.
- `matched` maps to `ranked`.
- `outreach` maps to `outreach_ready`.

`data_ring` describes data maturity and review readiness only. It must not be used for transient pipeline execution state. Use role/run records and status fields such as `enrichment_status` for queue or execution progress.

Allowed `enrichment_status` values:

- `not_started`
- `queued`
- `running`
- `complete`
- `failed`

Allowed `duplicate_status` values:

- `unknown`
- `unique`
- `possible_duplicate`
- `duplicate`

`profile_json` shape:

```json
{
  "summary": "Small accounting practice serving local trade and professional clients.",
  "description": "Source-backed profile text generated during enhancement.",
  "servicesOffered": ["Tax returns", "Bookkeeping", "Business advisory"],
  "customerTypes": ["Trades", "Small businesses"],
  "size": {
    "employeeCountBucket": "5-20",
    "locationCount": 1,
    "confidence": 0.55
  },
  "technologyHints": ["Xero", "MYOB"],
  "contactPaths": [
    {
      "type": "website_contact_form",
      "value": "https://northside.example/contact",
      "confidence": 0.8
    }
  ],
  "primaryPersonIds": ["638dcd54-0424-4ed9-bc24-3fc4b4d7fd89"],
  "currentCustomerProfileVersionId": "e934d4d3-6808-43d0-9680-203be5198d83",
  "gaps": [
    {
      "field": "people",
      "severity": "medium",
      "status": "not_attempted",
      "nextAction": "Find public decision makers."
    }
  ],
  "parkedReason": null
}
```

Allowed `employeeCountBucket` values:

- `1`
- `<5`
- `5-20`
- `20-50`
- `50-100`
- `100-500`
- `500+`

### `target_segments`

Stores Adapt's editable prospecting hierarchy. Existing free-text `companies.industry` and `discovery_jobs.industry` remain available during the transition.

```sql
CREATE TABLE target_segments (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  label TEXT NOT NULL,
  tier INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active',
  default_geo TEXT NOT NULL DEFAULT 'Perth, WA',
  default_target_count INTEGER NOT NULL DEFAULT 100,
  default_batch_size INTEGER NOT NULL DEFAULT 25,
  coverage_targets_json TEXT NOT NULL DEFAULT '{}',
  scan_prompts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `company_segments`

Links companies to one or more target segments with confidence and source metadata.

```sql
CREATE TABLE company_segments (
  company_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, segment_id)
);
```

### `target_geographies`

Stores a transitional geography model for scan coverage. The first version normalises free-text search locations such as `Perth` or `Subiaco` into durable rows while preserving the original scan text.

```sql
CREATE TABLE target_geographies (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'search_text',
  canonical_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `coverage_slices`

Stores durable coverage by segment, geography, source family, and strategy type across scan jobs. Scheduler selectors that act on this data are intentionally left for later tickets.

```sql
CREATE TABLE coverage_slices (
  id TEXT PRIMARY KEY,
  segment_id TEXT,
  geography_id TEXT,
  geography_text TEXT NOT NULL DEFAULT '',
  source_family TEXT NOT NULL DEFAULT 'web',
  strategy_type TEXT NOT NULL DEFAULT 'search',
  status TEXT NOT NULL DEFAULT 'active',
  target_counts_json TEXT NOT NULL DEFAULT '{}',
  current_counts_json TEXT NOT NULL DEFAULT '{}',
  yield_metrics_json TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  next_run_after_at INTEGER,
  stalled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`current_counts_json` stores rollup fields such as `found`, `unique`, `possibleDuplicates`, `weakSource`, `enriched`, `scored`, `outreachReady`, `parked`, `stale`, and `executedAttempts`.

`yield_metrics_json` stores executed-attempt metrics such as `resultCount`, `averageResultCount`, `netNewCompanies`, and `blockedAttempts`. Planned-next strategies are retained in pipeline result payloads and discovery-job detail responses, but they are not inserted into `scan_strategy_attempts` and are not counted in coverage.

### `scheduler_settings`

Stores the singleton durable configuration for the automated prospecting scheduler. The scheduler is disabled by default until a later ticket wires the run endpoint and timer.

```sql
CREATE TABLE scheduler_settings (
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
```

`per_role_concurrency_json` stores role-key limits such as `scan_target_list`, `enrich_company`, `monitor_and_score`, and `draft_outreach`. `cooldowns_json` stores millisecond cooldowns for acquisition, enrichment, scoring, outreach, and stalled coverage slices.

### `scheduler_runs`

Stores the scheduler decision log. Each row records either the selected action that a scheduler pass chose or the skip reason that explains why no work was started.

```sql
CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL DEFAULT 'scheduled',
  status TEXT NOT NULL,
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
  updated_at INTEGER NOT NULL
);
```

### `scheduler_locks`

Stores short-lived scheduler leases. A lock can be replaced only by the same run or after the lease has expired, preventing duplicate concurrent scheduler passes.

```sql
CREATE TABLE scheduler_locks (
  lock_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### `work_queue`

Stores durable prioritized work items for automated prospecting roles. Ticket 10 uses it for company enrichment while preserving `enrichment_requests` as the compatibility table for existing manual and industry enrichment endpoints.

```sql
CREATE TABLE work_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  segment_id TEXT,
  segment TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_after_at INTEGER,
  locked_by_run_id TEXT,
  error TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Allowed `status` values:

- `queued`
- `running`
- `complete`
- `failed`
- `cancelled`

For company enrichment rows, `kind = 'company_enrichment'`, `target_type = 'company'`, and `target_id` stores `companies.id`. `segment_id` links to a target segment when known and `segment` keeps a denormalized label or legacy industry text. Lower `priority` values run first. Failed enrichment rows keep `attempts`, `next_run_after_at`, and `error` so they can be retried without losing the original context.

`enrichment_requests.work_queue_id` points to the queue item when an existing manual or industry enrichment request creates queue state. Existing imports without that column still work; startup migration backfills queue rows from old enrichment requests.

### `discovery_jobs`

Stores target scan jobs. Jobs keep the legacy free-text `industry` and `location` fields and can also link to a target segment, transitional geography row, and primary coverage slice.

```sql
CREATE TABLE discovery_jobs (
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
  updated_at INTEGER NOT NULL
);
```

### `scan_strategy_attempts`

Stores executed or blocked strategy slices under a discovery job. Each attempt can link to the segment/geography coverage slice used for durable rollups.

```sql
CREATE TABLE scan_strategy_attempts (
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
  created_at INTEGER NOT NULL
);
```

### `people`

Stores people linked to prospective customers.

```sql
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  relationship TEXT,
  buyer_confidence REAL NOT NULL DEFAULT 0,
  influencer_confidence REAL NOT NULL DEFAULT 0,
  profile_urls_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
```

JSON shape:

```json
{
  "id": "638dcd54-0424-4ed9-bc24-3fc4b4d7fd89",
  "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "name": "Sam Taylor",
  "role": "Director",
  "relationship": "owner",
  "buyerConfidence": 0.76,
  "influencerConfidence": 0.84,
  "profileUrls": [
    {
      "type": "linkedin_person",
      "url": "https://linkedin.com/in/example",
      "confidence": 0.7
    }
  ],
  "notes": "Likely decision maker based on title and company size.",
  "createdAt": 1780876800000,
  "updatedAt": 1780876800000
}
```

### `sources`

Stores evidence and agent-checkable inputs. Agents own the checking loop. A daily agent fetches sources ordered by `last_checked_at`, takes a batch such as the oldest 20, inspects those sources, writes profile updates or activities if needed, and marks the sources checked.

```sql
CREATE TABLE sources (
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
```

Allowed `source_type` values:

- `company_website`
- `company_blog`
- `personal_blog`
- `linkedin_company`
- `linkedin_person`
- `directory`
- `map_listing`
- `business_register`
- `job_ad`
- `news`
- `event`
- `technology_profile`
- `manual_note`
- `pipeline_enrichment`

JSON shape:

```json
{
  "id": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
  "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "sourceType": "company_website",
  "url": "https://northside.example",
  "title": "Northside Accounting",
  "summary": "Official company website describing bookkeeping and tax services.",
  "extractedData": {
    "industry": "Accounting",
    "location": "Perth, WA",
    "services": ["Bookkeeping", "Tax"]
  },
  "confidence": 0.86,
  "lastCheckedAt": 1780876800000,
  "lastCheckedByRunId": "2a5ba3d4-ecf0-4e13-a6e1-a66c6edcbdab",
  "termsNotes": ""
}
```

### `customer_profile_versions`

Stores version history for generated or manually edited customer profile content.

```sql
CREATE TABLE customer_profile_versions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  profile_json TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  activity_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
```

Allowed `status` values:

- `proposed`
- `active`
- `archived`

JSON shape:

```json
{
  "id": "f8f875a1-2024-44ec-b20f-d48fb37adabf",
  "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "versionNumber": 3,
  "status": "active",
  "profile": {
    "summary": "Updated source-backed customer summary.",
    "description": "Longer profile text after enhancement.",
    "servicesOffered": ["Tax returns", "Bookkeeping", "Business advisory"],
    "customerTypes": ["Trades", "Small businesses"],
    "size": {
      "employeeCountBucket": "5-20",
      "locationCount": 1,
      "confidence": 0.55
    }
  },
  "changeSummary": "Added public-writing evidence and tightened service fit.",
  "sourceIds": ["5e735698-7d4d-409a-b977-ad77e4eeccdc"],
  "activityIds": ["fa5720bb-e85f-4bba-ae27-4146d75f314a"],
  "createdBy": "pipeline",
  "createdAt": 1780876800000
}
```

### `signals`

Stores source-linked enrichment signals for later scoring and outreach reasoning. A signal should either point at source evidence or carry low confidence with an explicit low-confidence reason in `evidence_json`.

```sql
CREATE TABLE signals (
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
```

Ticket 11 persists signals from structured enrichment output and returns them in company detail responses with their linked source evidence where available. Public decision-maker `people` records remain deferred because the current company detail caller path only needs company-level evidence, profile versions, and signal review data in this phase.

JSON shape:

```json
{
  "id": "8d9180b6-b37d-4599-8448-6136de9c73dc",
  "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "signalType": "ai_adoption",
  "summary": "Public post describes experimenting with AI-assisted quoting.",
  "sourceId": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
  "sourceUrl": "https://northside.example/news/ai-quoting",
  "observedDate": "2026-05-20",
  "strength": "medium",
  "confidence": 0.82,
  "adaptRelevance": "Good fit for AI workflow discovery.",
  "evidence": {
    "sourceIds": ["5e735698-7d4d-409a-b977-ad77e4eeccdc"]
  },
  "createdAt": 1780876800000
}
```

### `activities`

Stores audit history for customers, sources, outreach, and market profile versions.

```sql
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
```

Allowed `target_type` values:

- `company`
- `person`
- `source`
- `outreach`
- `market_profile`

Allowed `actor` values:

- `user`
- `pipeline`
- `system`

Allowed `action_type` values:

- `company_created`
- `company_updated`
- `company_enhanced`
- `initial_ranking_rebuilt`
- `source_checked`
- `person_found`
- `match_created`
- `outreach_drafted`
- `outreach_feedback_added`
- `profile_version_created`
- `manual_note_added`

JSON shape:

```json
{
  "id": "fa5720bb-e85f-4bba-ae27-4146d75f314a",
  "targetType": "source",
  "targetId": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
  "actor": "pipeline",
  "actionType": "source_checked",
  "summary": "Checked the company website and found a new blog post about AI-enabled bookkeeping.",
  "payload": {
    "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
    "customerProfileVersionId": "f8f875a1-2024-44ec-b20f-d48fb37adabf",
    "changed": true,
    "confidence": 0.81
  },
  "createdAt": 1780876800000
}
```

### `ranking_runs`

Stores durable initial-ranking rebuild history. Each rebuild creates a new run so old ranked snapshots remain available for review and export.

```sql
CREATE TABLE ranking_runs (
  id TEXT PRIMARY KEY,
  ranking_type TEXT NOT NULL DEFAULT 'initial',
  status TEXT NOT NULL,
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
```

Allowed `ranking_type` values:

- `initial`: cheap local ranking for enhanced companies before expensive company x offering scoring.

Allowed `status` values:

- `running`
- `complete`
- `failed`

### `ranking_items`

Stores the ranked companies for one `ranking_runs` snapshot.

```sql
CREATE TABLE ranking_items (
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
```

Initial ranking is local-only and must not trigger Autopilot scoring. It ranks enhanced/ranked companies by source quality, segment priority, Perth/WA fit, owner-led hints, trigger signals, reachability, freshness, missing-field completeness, and advisory/referral potential. Rebuilds also mark newly ranked enhanced companies as `data_ring = 'ranked'`.

`score_json` shape:

```json
{
  "score": 82.4,
  "scoreVersion": "initial-v1",
  "rankingRunId": "b912e9ad-5d41-4d17-922d-52be45d5fed0",
  "rankingType": "initial",
  "rank": 1,
  "dimensions": {
    "sourceQuality": 0.91,
    "segmentPriority": 0.86,
    "geography": 0.95,
    "ownerLed": 0.9,
    "triggers": 0.63,
    "reachability": 0.94,
    "freshness": 1,
    "missingFieldCompleteness": 0.88,
    "advisoryReferralPotential": 0.91
  },
  "evidence": {
    "sourceCount": 2,
    "signalCount": 2,
    "bestSegmentId": "adapt-tier-1-accounting-tax-bookkeeping-business-advisory"
  },
  "drivers": ["strong source evidence", "priority segment fit"],
  "risks": ["profile gaps"]
}
```

### `target_list_runs`

Stores rebuildable scored top-target snapshots assembled from stored `service_fit_assessments`.

```sql
CREATE TABLE target_list_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
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
```

### `target_list_items`

Stores the best scored company x offering row per company for one top-target snapshot. Ranking combines best service-fit score, second-best service-fit support, evidence quality, trigger recency, reachability, segment priority, confidence, and caveat penalties.

```sql
CREATE TABLE target_list_items (
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
  created_at INTEGER NOT NULL
);
```

Low-confidence, weak-evidence, weak-reachability, and high-caveat records are flagged in `flags_json`; confidence and caveat issues also reduce the ranked score.

### `company_matches`

Stores match results between a prospective customer and a market profile version.

```sql
CREATE TABLE company_matches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  market_profile_id TEXT NOT NULL,
  market_profile_version_id TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  reason TEXT NOT NULL,
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (market_profile_id) REFERENCES market_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE,
  UNIQUE(company_id, market_profile_version_id)
);
```

`score_json` shape:

```json
{
  "overallScore": 82,
  "drivers": {
    "serviceFit": 0.86,
    "timing": 0.74,
    "reachability": 0.68,
    "evidenceQuality": 0.79
  },
  "matchedServices": [
    {
      "serviceKey": "ai_workflow_consulting",
      "score": 0.88,
      "reason": "Public writing mentions reducing admin and follow-up load."
    }
  ],
  "risks": ["No direct email found yet."],
  "nextBestAction": "Draft outreach approach."
}
```

### `outreach_drafts`

Stores outreach approaches and draft copy.

```sql
CREATE TABLE outreach_drafts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  company_match_id TEXT,
  market_profile_id TEXT NOT NULL,
  market_profile_version_id TEXT NOT NULL,
  pitch_text TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (company_match_id) REFERENCES company_matches(id) ON DELETE SET NULL,
  FOREIGN KEY (market_profile_id) REFERENCES market_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (market_profile_version_id) REFERENCES market_profile_versions(id) ON DELETE CASCADE
);
```

Allowed `status` values:

- `draft`
- `reviewed`
- `sent`
- `feedback_recorded`
- `retry_scheduled`
- `closed`

`pitch_text` stores markdown containing the selected approach and one or more draft variants.

### `outreach_feedback`

Stores post-outreach feedback and retry dates.

```sql
CREATE TABLE outreach_feedback (
  id TEXT PRIMARY KEY,
  outreach_draft_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  retry_after_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (outreach_draft_id) REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
```

Allowed `feedback_type` values:

- `no_answer`
- `not_now`
- `wrong_person`
- `interested`
- `rejected`
- `retry_later`
- `manual_note`

## API Contract

### Summary

```txt
GET /api/kindling/summary
```

Response:

```json
{
  "ownerCompany": {},
  "marketProfiles": [],
  "companies": [],
  "pipelineRoles": [],
  "recentRuns": [],
  "counts": {
    "companies": 0,
    "enhanced": 0,
    "outreach": 0,
    "activeRuns": 0
  }
}
```

### Owner Company and Market Profiles

```txt
GET   /api/kindling/owner-company
PATCH /api/kindling/owner-company
GET   /api/kindling/market-profiles
POST  /api/kindling/market-profiles
GET   /api/kindling/market-profiles/:profileId
PATCH /api/kindling/market-profiles/:profileId
GET   /api/kindling/market-profiles/:profileId/versions
POST  /api/kindling/market-profiles/:profileId/versions
POST  /api/kindling/market-profiles/:profileId/versions/:versionId/activate
```

`POST /api/kindling/market-profiles` request:

```json
{
  "profileKey": "sme_accounting",
  "name": "SME Accounting Profile",
  "targetSegment": "SME accounting firms in Western Australia"
}
```

`POST /api/kindling/market-profiles/:profileId/versions` request:

```json
{
  "prompt": "We help local service businesses reduce manual follow-up and operational admin with practical AI workflows.",
  "deferAutopilotAuth": true
}
```

Response when deferred:

```json
{
  "requiresAutopilotAuth": true,
  "runId": "f45bd30d-765e-46b9-93f2-b1ef3552765e",
  "triggerRequest": {
    "body": {
      "input": {
        "pipelineRole": "develop_service_offering",
        "message": "We help local service businesses reduce manual follow-up and operational admin with practical AI workflows.",
        "localContext": {
          "ownerCompany": {},
          "marketProfile": {},
          "marketProfileVersion": {}
        }
      }
    }
  }
}
```

Pipeline callback payload:

```json
{
  "requestId": "f45bd30d-765e-46b9-93f2-b1ef3552765e",
  "role": "develop_service_offering",
  "status": "ok",
  "response": "Created a sharper SME Accounting Profile version.",
  "result": {
    "outputKind": "market_profile_update",
    "marketProfileId": "586e57f9-c90a-48f7-a55d-14e2f6f08f19",
    "marketProfileVersionPatch": {},
    "changeSummary": "Added AI workflow consulting service line for SME accounting firms.",
    "rationaleNotes": ["The new service line matches the supplied positioning."],
    "sourceReferences": []
  }
}
```

### Target Segments

```txt
GET   /api/kindling/target-segments
POST  /api/kindling/target-segments
PATCH /api/kindling/target-segments/:segmentId
GET   /api/kindling/companies/:companyId/segments
PATCH /api/kindling/companies/:companyId/segments
```

Target segment create/update fields:

```json
{
  "label": "Accounting, tax, bookkeeping, and business advisory",
  "parentId": "adapt-tier-1-sme-advisory-referral-rich",
  "tier": 1,
  "priority": 12,
  "status": "active",
  "defaultGeo": "Perth, WA",
  "defaultTargetCount": 140,
  "defaultBatchSize": 25,
  "targets": {
    "found": 140,
    "enriched": 56,
    "scored": 28,
    "outreachReady": 14
  },
  "prompts": {
    "prompt": "Find Perth accounting, tax, bookkeeping, and business advisory firms with SME client bases.",
    "synonyms": ["accountants", "tax accountants", "bookkeepers"]
  }
}
```

`GET /api/kindling/target-segments` returns both `segments` and `tree`. Segment parent updates reject loops.

Company segment membership request:

```json
{
  "replace": true,
  "segments": [
    {
      "segmentId": "adapt-tier-1-accounting-tax-bookkeeping-business-advisory",
      "confidence": 0.88,
      "source": "manual-review"
    }
  ],
  "removeSegmentIds": []
}
```

### Customers

```txt
GET  /api/kindling/companies
POST /api/kindling/companies
GET  /api/kindling/companies/:companyId
PATCH /api/kindling/companies/:companyId
```

List query parameters:

- `industry`
- `location`
- `dataRing`
- `duplicateStatus`
- `enrichmentStatus`
- `hasWebsite=yes|no`

Create request:

```json
{
  "name": "Northside Accounting",
  "location": "Perth, WA",
  "industry": "Accounting",
  "website": "https://northside.example",
  "dataRing": "found",
  "duplicateStatus": "unknown",
  "confidence": 0.2,
  "notes": "Added from target search."
}
```

Detail response:

```json
{
  "company": {},
  "sources": [],
  "signals": [],
  "evidence": {
    "sources": [],
    "signals": []
  },
  "people": [],
  "activities": [],
  "customerProfileVersions": [],
  "matches": [],
  "outreachDrafts": [],
  "feedback": []
}
```

### Scheduler State

```txt
GET   /api/kindling/scheduler-settings
PATCH /api/kindling/scheduler-settings
POST  /api/kindling/scheduler/run-once?dryRun=true
```

Patch request:

```json
{
  "enabled": false,
  "acquisitionEnabled": true,
  "enrichmentEnabled": true,
  "scoringEnabled": true,
  "outreachEnabled": true,
  "targetPoolSize": 10000,
  "enrichedFloor": 50,
  "topTargetCount": 100,
  "perRoleConcurrency": {
    "scan_target_list": 1,
    "enrich_company": 1
  },
  "cooldowns": {
    "acquisitionMs": 3600000
  }
}
```

Settings response includes `settings`, `recentRuns`, and `activeLock`.

`POST /api/kindling/scheduler/run-once?dryRun=true` evaluates exactly one scheduler pass without creating discovery jobs, enrichment requests, rankings, outreach drafts, Kindling pipeline runs, or Autopilot runs. It returns a `decision` with `workAvailable`, `action`, `roleKey`, `item`, `reason`, `evaluatedRoles`, and `activeLock`. Acquisition decisions use the current segment/geography coverage model: active, due coverage slices and segment default geographies are scored by source-backed unique prospect deficit against `found` targets, segment priority, Tier 1 Perth preference, and low-yield cooldown state. Parked segments, parked geographies, paused slices, and low-yield stalled slices still inside cooldown are skipped. The selected acquisition item has `kind = "acquisition_slice"` and includes the segment, geography, optional `coverageSliceId`, target counts, current source-backed counts, deficit, yield metrics, and cooldown explanation. The dry-run endpoint writes one `scheduler_runs` audit row with `run_type = 'dry_run'`, `result_json.dryRun = true`, `context_json.selectedAcquisitionWork` when acquisition was selected, and either the selected action or the no-work skip reason. Non-dry-run execution remains reserved for later scheduler tickets.

### Scoring Offerings

```txt
GET /api/kindling/scoring/offerings
```

Lists active service-offering identities for the current market profile version. The endpoint reads `service_offerings` rows, backfilling them from the active version's structured JSON if a pre-extraction profile version has no rows yet. It does not create scoring queue items or service-fit assessments.

Response:

```json
{
  "marketProfileVersionId": "538b52f0-f52d-4f10-927e-77f978abf184",
  "offerings": [
    {
      "id": "service_offering:538b52f0-f52d-4f10-927e-77f978abf184:ai_consulting:base",
      "marketProfileVersionId": "538b52f0-f52d-4f10-927e-77f978abf184",
      "key": "ai_consulting",
      "name": "AI consulting",
      "variantKey": "",
      "status": "active"
    }
  ]
}
```

### Service Fit Assessments

```txt
POST /api/kindling/service-assessments
POST /api/kindling/pipeline-write/service-assessment
```

`POST /api/kindling/service-assessments` creates exactly one scoring trigger for one company x one service offering. Calling it for 10 companies and 5 offerings creates 50 independent `kindling_pipeline_runs` and `work_queue` items because the queue target includes company id, service offering id, and market profile version id.

Request:

```json
{
  "companyId": "company_123",
  "serviceOfferingId": "service_offering:profile_v1:ai_consulting:base",
  "marketProfileVersionId": "profile_v1",
  "reason": "Manual scoring batch"
}
```

The trigger payload uses role `score_company_service_fit` and includes company profile versions, sources, signals, the exact service offering row, the active market profile version, a scoring rubric, and a token-scoped write API.

`POST /api/kindling/pipeline-write/service-assessment` persists pipeline output for the request token:

```json
{
  "requestId": "local-request-id",
  "result": {
    "outputKind": "service_fit_assessment",
    "companyId": "company_123",
    "serviceOfferingId": "service_offering:profile_v1:ai_consulting:base",
    "marketProfileVersionId": "profile_v1",
    "score": 84,
    "band": "high",
    "confidence": 0.78,
    "drivers": [{"dimension": "service_fit", "score": 86, "reason": "Source-backed fit"}],
    "fitExplanation": "Why this company fits this offering.",
    "evidence": [{"sourceId": "source_1", "url": "https://example.com", "summary": "Evidence summary"}],
    "caveats": ["Evidence gap"],
    "recommendedAction": "Review for outreach positioning"
  }
}
```

The write endpoint validates the company, service offering, profile version, request id, and token before upserting the assessment.

### Top Targets

```txt
GET  /api/kindling/top-targets
POST /api/kindling/top-targets/rebuild
```

Top-target aggregation materializes a scored list from stored `service_fit_assessments`. `GET /api/kindling/top-targets` returns the latest complete top-target snapshot and rebuilds one from stored assessments when no snapshot exists. `POST /api/kindling/top-targets/rebuild` forces a new local rebuild; it does not create outreach opportunities or outreach drafts.

Each target row includes `rank`, `score`, `reason`, `bestOffering`, `bestVariantKey`, `whyNow`, `evidenceQuality`, `confidence`, `caveats`, `flags`, and `nextAction`. Low-confidence and high-caveat records are flagged and penalized in `scoreJson.penalties`.

Response:

```json
{
  "source": "top_targets",
  "targetListRunId": "5a34d459-0a4d-4738-8a8e-8f5b76fbb0ab",
  "targets": [
    {
      "companyId": "company_123",
      "rank": 1,
      "reason": "Why this company fits this offering.",
      "bestOffering": {"id": "service_offering:profile_v1:ai_consulting:base", "name": "AI consulting"},
      "confidence": 0.78,
      "caveats": ["Evidence gap"],
      "flags": [],
      "nextAction": "Review for outreach positioning"
    }
  ]
}
```

### Initial Ranking

```txt
POST /api/kindling/initial-ranking/run
GET  /api/kindling/initial-ranking/runs
GET  /api/kindling/initial-ranking/runs/:runId
GET  /api/kindling/todays-targets
```

`POST /api/kindling/initial-ranking/run` rebuilds the cheap local initial ranking. It creates a new `ranking_runs` row and `ranking_items` snapshot, writes the score JSON and reason for each item, and preserves previous run history. It does not call Autopilot or create service-offering/service-fit records.

Request:

```json
{
  "reason": "Manual rebuild before scoring queue selection",
  "limit": 500
}
```

Response:

```json
{
  "run": {},
  "items": [
    {
      "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
      "rank": 1,
      "score": 82.4,
      "reason": "strong source evidence, priority segment fit, Perth/WA fit",
      "scoreJson": {}
    }
  ]
}
```

`GET /api/kindling/todays-targets` is a compatibility endpoint. It returns the latest complete top-target snapshot when one exists, then falls back to the latest complete initial-ranking snapshot, and finally to legacy `target_rankings` rows.

### Source Batch for Agent Checks

```txt
GET  /api/kindling/sources/check-batch?limit=20
POST /api/kindling/sources/:sourceId/check-result
```

Batch response:

```json
{
  "sources": [
    {
      "id": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
      "companyId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
      "sourceType": "company_website",
      "url": "https://northside.example",
      "lastCheckedAt": null
    }
  ],
  "limit": 20
}
```

Check-result request:

```json
{
  "runId": "2a5ba3d4-ecf0-4e13-a6e1-a66c6edcbdab",
  "checkedAt": 1780876800000,
  "changed": true,
  "activity": {
    "summary": "Found new blog post about AI-enabled bookkeeping.",
    "payload": {}
  },
  "customerProfileVersion": {}
}
```

### Pipeline Role Triggers

```txt
POST /api/kindling/target-scans
POST /api/kindling/companies/:companyId/enrich
POST /api/kindling/companies/:companyId/outreach
POST /api/kindling/pipeline-webhook
POST /api/kindling/pipeline-write/target-scan
```

Common trigger payload shape sent to Autopilot:

```json
{
  "input": {
    "source": "kindling-wapp",
    "wappId": "kindling",
    "pipelineRole": "enrich_company",
    "roleKey": "enrich_company",
    "requestId": "local-request-id",
    "userNpub": "npub1...",
    "message": "Enhance this customer profile.",
    "localContext": {
      "company": {},
      "knownSources": [],
      "marketProfile": {},
      "marketProfileVersion": {}
    },
    "webhook": {
      "url": "https://kindling.example/api/kindling/pipeline-webhook",
      "authHeader": "x-kindling-pipeline-token",
      "token": "run-scoped-token"
    }
  }
}
```

## Backend Work Implied

1. Add `owner_companies` table.
2. Add `owner_company_id`, `profile_key`, and `target_segment` to `market_profiles`.
3. Add `people` table.
4. Add `customer_profile_versions` table.
5. Add `outreach_feedback` table.
6. Add `last_checked_at` and `last_checked_by_run_id` to `sources`.
7. Extend prospect state consumers to use the canonical `companies.data_ring` vocabulary above and avoid storing transient queue execution state in `data_ring`.
8. Add `company_matches` table for market-profile-specific match records.
9. Add `company_match_id`, `market_profile_id`, and `market_profile_version_id` to `outreach_drafts`.
10. Add owner-company and market-profile read/create/version/activate endpoints around `owner_companies`, `market_profiles`, and `market_profile_versions`.
11. Add source check-batch and check-result endpoints for agent daily cycles.
12. Return `people`, `customerProfileVersions`, `matches`, `outreachDrafts`, and `feedback` in company detail responses.
