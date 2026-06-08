# Kindling Data Model and API Contract

## Scope

Kindling stores three linked datasets:

- The owner company running Kindling.
- Marketing/service profiles for the owner company. Each profile targets a specific segment, such as SME Manufacturing or SME Accounting, and each profile has its own version history.
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

Stores one marketing/service profile for the owner company. An owner company can have many market profiles, for example `sme_manufacturing` and `sme_accounting`.

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

Stores versioned service-offering and matching data for one market profile. Matching and outreach use the active version referenced by `market_profiles.current_version_id`.

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
- `matched`: customer has been matched against a market profile version.
- `outreach`: outreach approach or draft exists.
- `parked`: customer is not currently useful for matching or outreach.

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
  "currentVersionId": "e934d4d3-6808-43d0-9680-203be5198d83",
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

### `activities`

Stores audit history for customers, sources, outreach, and service-offering versions.

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
    "customerVersionId": "f8f875a1-2024-44ec-b20f-d48fb37adabf",
    "changed": true,
    "confidence": 0.81
  },
  "createdAt": 1780876800000
}
```

### `target_rankings`

Stores match results between a prospective customer and a market profile version.

```sql
CREATE TABLE target_rankings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  reason TEXT NOT NULL,
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
```

`score_json` shape:

```json
{
  "marketProfileId": "586e57f9-c90a-48f7-a55d-14e2f6f08f19",
  "marketProfileVersionId": "538b52f0-f52d-4f10-927e-77f978abf184",
  "profileKey": "sme_accounting",
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
  pitch_text TEXT NOT NULL,
  status TEXT NOT NULL,
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
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

### Owner Company and Service Offering Profiles

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
          "currentVersion": {}
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
    "profileVersionPatch": {},
    "changeSummary": "Added AI workflow consulting service line for SME accounting firms.",
    "rationaleNotes": ["The new service line matches the supplied positioning."],
    "sourceReferences": []
  }
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
  "people": [],
  "activities": [],
  "versions": [],
  "matches": [],
  "drafts": [],
  "feedback": []
}
```

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
  "profileVersion": {}
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
7. Normalize `companies.data_ring` to `found`, `enhanced`, `matched`, `outreach`, and `parked`.
8. Add owner-company and market-profile read/create/version/activate endpoints around `owner_companies`, `market_profiles`, and `market_profile_versions`.
9. Add source check-batch and check-result endpoints for agent daily cycles.
10. Return `people`, `versions`, `matches`, and `feedback` in company detail responses.
