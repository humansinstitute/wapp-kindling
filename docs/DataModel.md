# Kindling Data Model and API Contract

## Purpose

This contract is the first shared backend/frontend map for the Adapt by Design Kindling deployment. It describes the customer profile model, the staged depth of data expected at each stage, and the JSON shapes Andy can use to build a frontend against fake data while backend and pipeline work continues.

Kindling's core object is a customer profile. In the current codebase this is called a `company`, because the first target set is Australian SMEs. For Adapt, the frontend should use customer language where that is clearer, while the API can continue to expose `company` until the backend is renamed.

The app is trying to create a living dataset of potential customers. Some records will only have a name and possible website. Better records will have source-backed company facts, public writing, people, monitoring points, scoring, and outreach material. Static profile data and ongoing activity data should be kept separate so regular scans can improve a profile without rewriting the whole customer record.

## Current Backend Baseline

The current SQLite schema already supports the first slice of this model:

- `companies`: core customer/company identity, stage, duplicate status, enrichment status, confidence, and flexible `profile_json`.
- `sources`: source-backed evidence linked to a company.
- `activities`: timeline entries for manual actions, pipeline actions, scan attempts, enrichments, and future monitoring events.
- `discovery_jobs` and `scan_strategy_attempts`: target-list scan inputs, output counts, and strategy history.
- `target_rankings`: ranked targets and score JSON.
- `outreach_drafts`: generated pitch text for a company.
- `market_profiles` and `market_profile_versions`: Adapt's configurable positioning, ICP, services, triggers, and outreach voice.
- `pipeline_roles` and `kindling_pipeline_runs`: the configured Autopilot role and run status for each app action.

The current backend does not yet have first-class tables for people, monitoring points, signals, score breakdowns, or field-level evidence. The initial contract treats those as structured JSON nested on a customer profile, with a later migration path to tables once the UI and pipeline outputs settle.

## Customer Profile Stages

Profiles move through stages as more data becomes available. A stage is not a strict workflow lock. A record can move backward, be parked, or be partially complete if evidence is weak.

| Stage | API value | Minimum data | Added data expected | Frontend use |
| --- | --- | --- | --- | --- |
| Seed | `seed` | `id`, `name` | optional `website`, `location`, `industry` | Show sparse row; offer enrich action. |
| Publicly findable | `publicly_findable` | seed data plus at least one source | candidate website, directory profile, map result, LinkedIn/company profile | Show source coverage and confidence. |
| Basic profile | `basic_profile` | findable data plus structured summary | description, offer, customer types, size hints, source notes | Show customer summary card. |
| People found | `people_found` | profile plus at least one relevant person | roles, profile URLs, buyer/influencer confidence | Show people/contact panel. |
| Monitored | `monitored` | profile plus monitoring points | company blog, personal blog, LinkedIn activity, hiring page, news, events | Show monitored sources and latest checks. |
| Scored | `scored` | profile plus score breakdown | service fit, timing, reachability, trigger strength, confidence | Show ranking and score drivers. |
| Outreach candidate | `outreach_candidate` | scored plus clear next action | recommended service angle, missing data, risk | Show in today's targets. |
| Outreach ready | `outreach_ready` | candidate plus source-backed pitch inputs | draft variants, subject, CTA, evidence, warnings | Enable outreach draft review/copy. |
| Parked | `parked` | any stage | reason, attempted searches, revisit rule | Hide from today's targets by default. |

Current backend mapping:

- `companies.data_ring` can hold these API values.
- `companies.enrichment_status` remains a process status: `not_started`, `queued`, `running`, `complete`, or `failed`.
- `companies.confidence` remains a coarse 0 to 1 number until detailed score drivers are stored separately.

## Customer Profile Object

Frontend fake data should start from this shape. Fields can be omitted or empty if the profile is sparse.

```json
{
  "id": "cust_adapt_001",
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
    "sizeHints": {
      "employees": "5-20",
      "locations": 1,
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
  "people": [
    {
      "id": "person_001",
      "name": "Sam Taylor",
      "role": "Director",
      "relationship": "owner",
      "profileUrls": [
        {
          "type": "linkedin",
          "url": "https://linkedin.com/in/example",
          "confidence": 0.7
        }
      ],
      "buyerConfidence": 0.76,
      "influencerConfidence": 0.84,
      "notes": "Likely decision maker based on title and company size."
    }
  ],
  "monitoringPoints": [
    {
      "id": "mon_001",
      "targetType": "company",
      "targetId": "cust_adapt_001",
      "sourceType": "company_blog",
      "url": "https://northside.example/blog",
      "priority": "high",
      "status": "active",
      "checkCadence": "weekly",
      "lastCheckedAt": "2026-06-08T00:00:00.000Z",
      "reason": "First-party writing is a strong buying-signal source."
    }
  ],
  "sources": [],
  "activity": [],
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

## Static vs Activity Data

Static profile data is the current best known state of the customer. It should be shown in profile views and used as context for scoring and outreach.

Activity data is what happened over time: scans, source checks, pipeline enrichments, failed attempts, monitoring observations, manual edits, scoring runs, and outreach draft runs. It should be append-only where possible and visible as an audit timeline.

```json
{
  "activity": {
    "id": "act_001",
    "customerId": "cust_adapt_001",
    "targetType": "customer",
    "targetId": "cust_adapt_001",
    "actor": "pipeline",
    "actionType": "monitoring_signal_found",
    "summary": "Found a new blog post about AI-enabled bookkeeping.",
    "payload": {
      "sourceId": "src_001",
      "monitoringPointId": "mon_001",
      "signalId": "sig_001",
      "confidence": 0.81
    },
    "createdAt": "2026-06-08T00:00:00.000Z"
  }
}
```

## Source Contract

Sources are evidence records. The frontend should show source quality, recency, and summary before treating a profile as reliable.

```json
{
  "id": "src_001",
  "customerId": "cust_adapt_001",
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

## Monitoring Point Contract

Monitoring points define what should be checked again. Blogs and first-party public writing should be high priority because they reveal timing, language, and priorities.

```json
{
  "id": "mon_001",
  "customerId": "cust_adapt_001",
  "targetType": "person",
  "targetId": "person_001",
  "sourceType": "personal_blog",
  "url": "https://sam.example/blog",
  "label": "Sam Taylor personal blog",
  "priority": "high",
  "status": "active",
  "checkCadence": "weekly",
  "lastCheckedAt": null,
  "nextCheckAt": "2026-06-15T00:00:00.000Z",
  "reason": "Personal writing is the strongest available signal source.",
  "createdAt": "2026-06-08T00:00:00.000Z",
  "updatedAt": "2026-06-08T00:00:00.000Z"
}
```

Suggested `priority` values:

- `high`: personal blog, company blog, first-party writing, high-signal LinkedIn activity.
- `medium`: company website changes, job ads, events, newsletters.
- `low`: directories, maps, technology profiles, indirect secondary updates.

## Signal Contract

Signals are observed activity from a source or monitoring point. They should not overwrite static customer data until accepted, but they can influence scores and today's targets.

```json
{
  "id": "sig_001",
  "customerId": "cust_adapt_001",
  "sourceId": "src_001",
  "monitoringPointId": "mon_001",
  "signalType": "ai_interest",
  "title": "Blog post mentions using AI to reduce admin follow-up",
  "observedAt": "2026-06-08T00:00:00.000Z",
  "summary": "The director wrote about wanting to reduce manual client follow-up.",
  "evidenceUrl": "https://sam.example/blog/ai-admin",
  "relevance": 0.88,
  "confidence": 0.82,
  "recommendedAction": "Score against Adapt AI workflow consulting offer."
}
```

## Score Contract

Scoring should be explainable. A single number is useful for sorting, but the frontend should show why the customer is or is not a good target today.

```json
{
  "customerId": "cust_adapt_001",
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
  "customerId": "cust_adapt_001",
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
      "sourceId": "src_001",
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
      "id": "cust_adapt_001",
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

For the Adapt frontend mock, use the richer `CustomerProfile` shape above. The backend can initially return the current smaller shape and then grow `profile` to include the nested static, people, monitoring, source, score, and outreach data.

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
  "monitoringPoints": [],
  "signals": [],
  "activities": [],
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
    "id": "profile_adapt_001",
    "name": "Adapt by Design",
    "currentVersionId": "profile_version_001",
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
    "monitored": 0,
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
- One `monitored` customer with company blog and personal LinkedIn monitoring points.
- One `scored` customer with visible score drivers.
- One `outreach_ready` customer with draft variants and warnings.
- One `parked` customer with attempted searches and a clear parked reason.

## Backend Work Implied

To make the contract first-class rather than JSON-only, the next backend slice should add:

1. Stage vocabulary validation for `companies.data_ring`.
2. Stable `profile_json` shape for `staticProfile`, `people`, `monitoringPoints`, `signals`, `score`, `outreach`, and `gaps`.
3. New list/detail serializers that expose `customer` aliases while preserving `company` compatibility.
4. Pipeline callback normalisation for `find_people`, `monitor_and_score`, and monitoring signal results.
5. Optional later tables for `people`, `monitoring_points`, `signals`, and `score_snapshots` once the UI and pipeline shape have proven stable.

