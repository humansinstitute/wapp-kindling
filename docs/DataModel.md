# Kindling Data Model and API Contract

## Purpose

This contract is the first shared backend/frontend map for the Adapt by Design Kindling deployment. It describes the customer profile model, the staged depth of data expected at each stage, and the JSON shapes Andy can use to build a frontend against fake data while backend and pipeline work continues.

Kindling's core object is a customer profile. In the current codebase this is called a `company`, because the first target set is Australian SMEs. For Adapt, the frontend should use customer language where that is clearer, while the API can continue to expose `company` until the backend is renamed.

The app is trying to create a living dataset of potential customers. Some records will only have a name and possible website. Better records will have source-backed company facts, public writing, people, scoring, and outreach material. Static profile data and ongoing activity data should be kept separate so regular scans can improve a profile without rewriting the whole customer record.

## Current Backend Baseline

The current SQLite schema already supports the first slice of this model:

- `companies`: core customer/company identity, stage, duplicate status, enrichment status, confidence, and flexible `profile_json`.
- `sources`: source-backed evidence linked to a company.
- `activities`: timeline entries for manual actions, pipeline actions, scan attempts, enrichments, source checks, meetings, and public updates.
- `discovery_jobs` and `scan_strategy_attempts`: target-list scan inputs, output counts, and strategy history.
- `target_rankings`: ranked targets and score JSON.
- `outreach_drafts`: generated pitch text for a company.
- `market_profiles` and `market_profile_versions`: Adapt's configurable positioning, ICP, services, triggers, and outreach voice.
- `pipeline_roles` and `kindling_pipeline_runs`: the configured Autopilot role and run status for each app action.

The current backend does not yet have first-class tables for people, score breakdowns, or field-level evidence. The first contract should add people as first-class records. Sources are the available inputs agents can check. Agents own the checking cycle: they can ask for sources ordered by `lastCheckedAt`, take a batch such as the oldest 20, inspect those sources, update any affected customer profiles, then mark the sources checked.

## Customer Profile Stages

Profiles move through stages as more data becomes available. A stage is not a strict workflow lock. A record can move backward, be parked, or be partially complete if evidence is weak.

| Stage | API value | Minimum data | Added data expected | Frontend use |
| --- | --- | --- | --- | --- |
| Seed | `seed` | `id`, `name` | optional `website`, `location`, `industry` | Show sparse row; offer enrich action. |
| Publicly findable | `publicly_findable` | seed data plus at least one source | candidate website, directory profile, map result, LinkedIn/company profile | Show source coverage and confidence. |
| Basic profile | `basic_profile` | findable data plus structured summary | description, offer, customer types, size hints, source notes | Show customer summary card. |
| People found | `people_found` | profile plus at least one relevant person | roles, profile URLs, buyer/influencer confidence | Show people/contact panel. |
| Scored | `scored` | profile plus score breakdown | service fit, timing, reachability, trigger strength, confidence | Show ranking and score drivers. |
| Outreach candidate | `outreach_candidate` | scored plus clear next action | recommended service angle, missing data, risk | Show in today's targets. |
| Outreach ready | `outreach_ready` | candidate plus source-backed pitch inputs | draft variants, subject, CTA, evidence, warnings | Enable outreach draft review/copy. |
| Parked | `parked` | any stage | reason, attempted searches, revisit rule | Hide from today's targets by default. |

Current backend mapping:

- `companies.data_ring` can hold these API values.
- `companies.enrichment_status` remains a process status: `not_started`, `queued`, `running`, `complete`, or `failed`.
- `companies.confidence` remains a coarse 0 to 1 number until detailed score drivers are stored separately.
- All API identifiers should be UUIDs. Human-readable labels can be generated in fixtures, but persisted IDs should not use semantic prefixes.

## Customer Profile Object

Frontend fake data should start from this shape. Fields can be omitted or empty if the profile is sparse.

```json
{
  "id": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "name": "Northside Accounting",
  "displayName": "Northside Accounting",
  "stage": "basic_profile",
  "location": "Perth, WA",
  "industry": "Accounting",
  "website": "https://northside.example",
  "duplicateStatus": "unique",
  "enrichmentStatus": "complete",
  "confidence": 0.72,
  "staticProfile": {
    "summary": "Small accounting practice serving local trade and professional clients.",
    "description": "Source-backed longer internal summary.",
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
    "tags": ["local", "professional-services", "possible-ai-admin-fit"]
  },
  "primaryPersonIds": ["638dcd54-0424-4ed9-bc24-3fc4b4d7fd89"],
  "sources": [],
  "activity": [],
  "currentVersionId": "e934d4d3-6808-43d0-9680-203be5198d83",
  "score": null,
  "outreach": null,
  "gaps": [
    {
      "field": "people",
      "severity": "medium",
      "status": "not_attempted",
      "nextAction": "Find public decision makers."
    }
  ],
  "createdAt": "2026-06-08T00:00:00.000Z",
  "updatedAt": "2026-06-08T00:00:00.000Z"
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

## Person Contract

People are first-class records. The customer profile can reference important people by ID, but person details should not live only inside `profile_json`.

```json
{
  "id": "638dcd54-0424-4ed9-bc24-3fc4b4d7fd89",
  "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "name": "Sam Taylor",
  "role": "Director",
  "relationship": "owner",
  "profileUrls": [
    {
      "type": "linkedin_person",
      "url": "https://linkedin.com/in/example",
      "confidence": 0.7
    }
  ],
  "buyerConfidence": 0.76,
  "influencerConfidence": 0.84,
  "notes": "Likely decision maker based on title and company size.",
  "createdAt": "2026-06-08T00:00:00.000Z",
  "updatedAt": "2026-06-08T00:00:00.000Z"
}
```

## Static vs Activity Data

Static profile data is the current best known state of the customer. It should be shown in profile views and used as context for scoring and outreach.

Activity data is what happened over time: scans, source checks, pipeline enrichments, failed attempts, public updates, meetings, manual edits, scoring runs, and outreach draft runs. It should be append-only where possible and visible as an audit timeline.

```json
{
  "activity": {
    "id": "fa5720bb-e85f-4bba-ae27-4146d75f314a",
    "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
    "targetType": "customer",
    "targetId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
    "actor": "pipeline",
    "activityType": "source_checked",
    "actionType": "source_checked",
    "summary": "Checked the company website and found a new blog post about AI-enabled bookkeeping.",
    "payload": {
      "sourceId": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
      "customerVersionId": "f8f875a1-2024-44ec-b20f-d48fb37adabf",
      "changed": true,
      "confidence": 0.81
    },
    "createdAt": "2026-06-08T00:00:00.000Z"
  }
}
```

Suggested `actor` values:

- `user`: manual updates, meetings, notes, corrections.
- `pipeline`: Autopilot or tool-driven discovery/enrichment/update.
- `system`: automatic housekeeping, imports, migrations, and status changes.

Suggested `activityType` values for the first frontend:

- `meeting`
- `blog_post`
- `linkedin_post`
- `instagram_post`
- `x_post`
- `speaking`
- `podcast`
- `website_update`
- `source_checked`
- `enrichment_applied`
- `manual_update`
- `outreach_draft`
- `score_update`

## Source Contract

Sources are evidence records and available check inputs. They explain why the static profile says what it says, and they give agents concrete places to look when cycling through possible updates.

The data model does not schedule source checks. Agents own that loop. A daily agent can request sources ordered by `lastCheckedAt`, take the top 20 oldest or never-checked sources, inspect them, write activities and customer-profile versions where useful, then mark those sources with the latest check timestamp.

```json
{
  "id": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
  "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "sourceType": "company_website",
  "url": "https://northside.example",
  "title": "Northside Accounting",
  "retrievedAt": "2026-06-08T00:00:00.000Z",
  "summary": "Official company website describing bookkeeping and tax services.",
  "extractedData": {
    "industry": "Accounting",
    "location": "Perth, WA",
    "services": ["Bookkeeping", "Tax"]
  },
  "confidence": 0.86,
  "lastCheckedAt": "2026-06-08T00:00:00.000Z",
  "lastCheckedByRunId": "2a5ba3d4-ecf0-4e13-a6e1-a66c6edcbdab",
  "termsNotes": ""
}
```

Suggested `sourceType` values:

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

## Customer Profile Version Contract

When new evidence materially changes the static profile, create a new version instead of mutating the profile with no history. The UI can flag that a pipeline has proposed or applied a newer version and let the user restore an earlier version if needed.

```json
{
  "id": "f8f875a1-2024-44ec-b20f-d48fb37adabf",
  "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "versionNumber": 3,
  "status": "proposed",
  "staticProfile": {
    "summary": "Updated source-backed customer summary.",
    "description": "Longer profile text after enrichment.",
    "servicesOffered": ["Tax returns", "Bookkeeping", "Business advisory"],
    "customerTypes": ["Trades", "Small businesses"],
    "size": {
      "employeeCountBucket": "5-20",
      "locationCount": 1,
      "confidence": 0.55
    }
  },
  "changeSummary": "Added new public-writing evidence and tightened service fit.",
  "sourceIds": ["5e735698-7d4d-409a-b977-ad77e4eeccdc"],
  "activityIds": ["fa5720bb-e85f-4bba-ae27-4146d75f314a"],
  "createdBy": "pipeline",
  "createdAt": "2026-06-08T00:00:00.000Z"
}
```

## Score Contract

Scoring should be explainable. A single number is useful for sorting, but the frontend should show why the customer is or is not a good target today.

```json
{
  "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "overallScore": 82,
  "stage": "outreach_candidate",
  "drivers": {
    "fit": 0.86,
    "timing": 0.74,
    "reachability": 0.68,
    "triggerStrength": 0.9,
    "confidence": 0.79,
    "serviceMatch": 0.84
  },
  "matchedServices": [
    {
      "serviceKey": "ai_workflow_consulting",
      "label": "AI workflow consulting",
      "score": 0.88,
      "reason": "Public writing mentions reducing admin and follow-up load."
    }
  ],
  "risks": [
    "No direct email found yet."
  ],
  "nextBestAction": "Find contact path or draft soft intro email.",
  "updatedAt": "2026-06-08T00:00:00.000Z"
}
```

## Outreach Contract

Outreach is generated only once a customer has enough evidence to avoid generic messaging.

```json
{
  "customerId": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
  "status": "draft",
  "subject": "Reducing manual client follow-up at Northside",
  "variants": [
    {
      "label": "Direct",
      "subject": "Reducing manual client follow-up at Northside",
      "body": "Hi Sam, ...",
      "angle": "Practical admin workflow improvement",
      "callToAction": "Worth a 15 minute chat next week?"
    }
  ],
  "personalisationInputs": [
    {
      "sourceId": "5e735698-7d4d-409a-b977-ad77e4eeccdc",
      "claim": "Northside publishes advice for small business clients.",
      "safeToUse": true
    }
  ],
  "warnings": [
    "No direct personal email found."
  ],
  "confidence": 0.76,
  "createdAt": "2026-06-08T00:00:00.000Z"
}
```

## List API Contract

The existing list endpoint can support the first frontend screen:

```txt
GET /api/kindling/companies
GET /api/kindling/companies?industry=Accounting&location=Perth&dataRing=basic_profile&hasWebsite=yes
```

Response:

```json
{
  "companies": [
    {
      "id": "8fb4b145-8a80-44a0-a178-f731acfed5c9",
      "name": "Northside Accounting",
      "location": "Perth, WA",
      "industry": "Accounting",
      "website": "https://northside.example",
      "dataRing": "basic_profile",
      "duplicateStatus": "unique",
      "enrichmentStatus": "complete",
      "confidence": 0.72,
      "profile": {
        "summary": "Small accounting practice serving local trade and professional clients.",
        "tags": ["local", "professional-services"]
      },
      "createdAt": 1780876800000,
      "updatedAt": 1780876800000
    }
  ],
  "total": 1,
  "returned": 1,
  "limit": 500
}
```

For the Adapt frontend mock, use the richer `CustomerProfile` shape above. The backend can initially return the current smaller shape and then grow `profile` to include static profile, current version, score, outreach, and gaps. People should be first-class records, sources should be evidence/check inputs, and activities should be the audit/update timeline.

## Detail API Contract

The existing detail endpoint is the right starting point:

```txt
GET /api/kindling/companies/:companyId
```

Response:

```json
{
  "company": {},
  "sources": [],
  "activities": [],
  "drafts": []
}
```

Target Adapt response:

```json
{
  "customer": {},
  "sources": [],
  "people": [],
  "activities": [],
  "versions": [],
  "score": {},
  "outreach": {},
  "gaps": []
}
```

Backend compatibility rule: until the route is renamed, frontend adapters can map `company` to `customer`.

## Create and Update Contract

Only `name` is required for a manual customer create. Everything else can be added by the user or by pipelines.

```txt
POST /api/kindling/companies
PATCH /api/kindling/companies/:companyId
```

Create request:

```json
{
  "name": "Northside Accounting",
  "location": "Perth, WA",
  "industry": "Accounting",
  "website": "https://northside.example",
  "dataRing": "manual",
  "duplicateStatus": "unknown",
  "confidence": 0.2,
  "notes": "Added manually from Adapt target list."
}
```

Update request:

```json
{
  "name": "Northside Accounting",
  "location": "Perth, WA",
  "industry": "Accounting",
  "website": "https://northside.example",
  "dataRing": "basic_profile",
  "duplicateStatus": "unique",
  "enrichmentStatus": "complete",
  "confidence": 0.72,
  "notes": "Reviewed by user."
}
```

## Pipeline Role Contract

The UI should treat pipeline actions as asynchronous. A button creates a local run, the backend triggers Autopilot, and a webhook or write API updates the customer dataset later.

Current role keys:

- `develop_service_offering`
- `scan_target_list`
- `enrich_company`
- `enrich_industry_segment`
- `draft_outreach`
- `resolve_duplicates`
- `find_people`
- `monitor_and_score`

Trigger payload shape:

```json
{
  "input": {
    "source": "kindling-wapp",
    "wappId": "kindling",
    "pipelineRole": "enrich_company",
    "roleKey": "enrich_company",
    "requestId": "local-request-id",
    "userNpub": "npub1...",
    "message": "Enrich this customer profile.",
    "localContext": {
      "customer": {},
      "knownSources": [],
      "activeMarketProfile": {}
    },
    "webhook": {
      "url": "https://kindling.example/api/kindling/pipeline-webhook",
      "authHeader": "x-kindling-pipeline-token",
      "token": "run-scoped-token"
    }
  }
}
```

## Fake Dataset Contract

Andy can build UI screens against a single JSON fixture with this shape:

```json
{
  "generatedAt": "2026-06-08T00:00:00.000Z",
  "marketProfile": {
    "id": "586e57f9-c90a-48f7-a55d-14e2f6f08f19",
    "name": "Adapt by Design",
    "currentVersionId": "538b52f0-f52d-4f10-927e-77f978abf184",
    "summary": "Adapt helps clients improve operations with AI, workflow design, training, and implementation support.",
    "services": [
      {
        "key": "ai_workflow_consulting",
        "label": "AI workflow consulting",
        "description": "Identify practical AI-enabled process improvements."
      }
    ]
  },
  "customers": [],
  "counts": {
    "totalCustomers": 0,
    "seed": 0,
    "publiclyFindable": 0,
    "basicProfile": 0,
    "peopleFound": 0,
    "scored": 0,
    "outreachCandidate": 0,
    "outreachReady": 0,
    "parked": 0
  }
}
```

Recommended first fake records:

- One `seed` customer with only name and possible website.
- One `publicly_findable` customer with sources but weak profile.
- One `basic_profile` customer with company summary and evidence.
- One `people_found` customer with a likely decision maker.
- One `scored` customer with visible score drivers.
- One `outreach_ready` customer with draft variants and warnings.
- One `parked` customer with attempted searches and a clear parked reason.

## Backend Work Implied

To make the contract first-class rather than JSON-only, the next backend slice should add:

1. Stage vocabulary validation for `companies.data_ring`.
2. Stable `profile_json` shape for `staticProfile`, `currentVersionId`, `primaryPersonIds`, `score`, `outreach`, and `gaps`.
3. New list/detail serializers that expose `customer` aliases while preserving `company` compatibility.
4. First-class `people` and `customer_profile_versions` tables.
5. Source check metadata: `last_checked_at` and `last_checked_by_run_id`.
6. Pipeline callback normalisation for `find_people`, source-check activities, profile-version proposals, and `monitor_and_score`.
7. Optional later tables for `score_snapshots` if score history needs richer querying.
