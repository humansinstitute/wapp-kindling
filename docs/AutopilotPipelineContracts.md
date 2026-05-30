# Autopilot Pipeline Contracts

Kindling calls Autopilot pipelines by role. The WApp owns screens, local SQLite state, run records, webhook tokens, and final application state. Autopilot owns pipeline definitions and long-running agent work.

The first Autopilot support set started as stubs so the WApp could exercise the full workflow before real research and enrichment steps were added. The minimum role set now has first-pass working pipelines, with the original stubs retained as fallbacks.

## Seed Pipeline Roles

| Role key | Recommended trigger key | Stub fallback trigger key | Discovered slug | Output kind |
| --- | --- | --- | --- | --- |
| `develop_service_offering` | `kindling-develop-service-offering` | `kindling-develop-service-offering-stub` | `kindling-develop-service-offering.v1` | `market_profile_update` |
| `scan_target_list` | `kindling-scan-target-list` | `kindling-scan-target-list-stub` | `kindling-scan-target-list.v1` | `target_scan_result` |
| `enrich_company` | `kindling-enrich-company` | `kindling-enrich-company-stub` | `kindling-enrich-company.v1` | `company_enrichment` |
| `draft_outreach` | `kindling-draft-outreach` | `kindling-draft-outreach-stub` | `kindling-draft-outreach.v1` | `outreach_draft` |

These are user-scoped Autopilot definitions for Pete's workspace. The WApp can trigger by default trigger key because the Autopilot HTTP trigger route accepts the definition name, while the pipeline discovery list will show the versioned slug or opaque definition ID. The WApp should store the selected value as admin-editable configuration rather than hard-coded behavior.

## Trigger Payload

All Kindling role pipelines should accept the common WApp trigger shape:

```json
{
  "input": {
    "source": "kindling-wapp",
    "pipelineRole": "scan_target_list",
    "requestId": "local-request-id",
    "userNpub": "npub1...",
    "message": "plain-language request or latest user instruction",
    "localContext": {},
    "webhook": {
      "url": "http://localhost:PORT/api/pipeline-webhook",
      "authHeader": "x-kindling-pipeline-token",
      "token": "run-scoped-token"
    }
  }
}
```

Role-specific fields can sit beside `message` and `localContext`. Examples:

- `scan_target_list`: `industry`, `location`, `targetCount`.
- `enrich_company`: `companyId`, `companyName`, `localContext.company`.
- `draft_outreach`: `companyId`, `companyName`, `localContext.activeProfileVersion`.
- `develop_service_offering`: `history`, `localContext.marketProfileId`, `localContext.activeProfileVersionId`, `localContext.documents`.

## Webhook Payload

Kindling pipelines post one completion callback to the supplied webhook:

```json
{
  "requestId": "local-request-id",
  "role": "develop_service_offering",
  "status": "ok",
  "stub": false,
  "generatedAt": "2026-05-29T00:00:00.000Z",
  "response": "Short user-facing summary",
  "result": {},
  "metadata": {
    "source": "kindling-profile-update-pipeline",
    "pipelineRole": "develop_service_offering",
    "stub": false
  }
}
```

The WApp should treat `requestId` as the local join key and use the Autopilot trigger response to store the Autopilot `run.id`. The callback does not need to repeat the run ID.

## Profile Update Pipeline

`kindling-develop-service-offering` has two steps:

1. `synthesise-profile-update`: an agent step that interprets the latest user message, prior conversation history, and `localContext.activeProfileVersion`.
2. `deliver-profile-update`: a deterministic function that normalises the agent output and posts the WApp callback.

The WApp should pass compact profile context rather than expecting Autopilot to read SQLite:

```json
{
  "input": {
    "pipelineRole": "develop_service_offering",
    "requestId": "local-request-id",
    "message": "We mostly help local service businesses tighten follow-up after initial enquiry.",
    "history": [],
    "localContext": {
      "marketProfileId": "profile_123",
      "activeProfileVersionId": "profile_version_4",
      "activeProfileVersion": {},
      "documents": [],
      "recentChangeNotes": []
    },
    "webhook": {
      "url": "http://localhost:PORT/api/pipeline-webhook",
      "authHeader": "x-kindling-pipeline-token",
      "token": "run-scoped-token"
    }
  }
}
```

It returns:

- `result.outputKind = "market_profile_update"`
- `result.marketProfileId`
- `result.activeProfileVersionId`
- `result.profileVersionPatch`
- `result.changeSummary`
- `result.rationaleNotes`
- `result.nextQuestions`
- `result.evidence`
- `result.warnings`
- `result.confidence`

The profile patch includes `title`, `summary`, `positioningStatement`, `services`, `idealCustomerProfile`, `problemsSolved`, `buyingTriggers`, `differentiators`, `outreachVoice`, `exclusions`, `assumptions`, and `confidence`.

## Target Scan Pipeline

`kindling-scan-target-list` is moving toward a manager/search loop. The first production shape should be:

1. `load-scan-context`: a deterministic step that calls the WApp scan-context API for matching counts, previous strategy attempts, coverage, recent companies, and target count.
2. `plan-next-strategy`: a manager agent step that chooses the next strategy slice and explains why it is likely to produce net-new verified companies.
3. `run-search-slice`: a search agent step that executes the selected strategy only. It does not enrich people or draft outreach.
4. `normalise-slice-results`: a deterministic step that converts raw agent output into companies, sources, duplicate hints, and strategy telemetry.
5. `write-partial-results`: a deterministic step that writes the batch to the WApp scan-result API.
6. `evaluate-progress`: a manager or deterministic step that checks current total, net-new yield, target count, max slices, and time/effort budget before looping or finishing.

The current first-pass pipeline still uses a compact discover/persist shape, but it must preserve the same contract: strategy selection happens from WApp state, results are normalised before persistence, and every attempted strategy is recorded.

The code step writes a JSON file before callback delivery so the discovered company batch is inspectable outside the agent transcript. By default artifacts are written under:

```text
~/.wingmen/pipelines/users/honest-ivory-thicket/artifacts/kindling/target-scans/
```

The WApp remains the owner of SQLite. The pipeline does not open the SQLite database directly. It sends the normalized companies to `localContext.writeApi`, the NIP-98 scan-result API, or the normal final webhook callback path. The WApp endpoint performs the actual SQLite insert/update, duplicate marking, and strategy-attempt persistence.

For repeat scans, the WApp includes `localContext.priorScanStrategies`. The pipeline should use this to avoid repeating the same first-page searches and should return `searchSlices` with `strategyType`, `query`, `status`, `resultCount`, and `notes` so later runs can improve coverage.

The WApp API surface for strategy-aware scans is:

- `GET /api/nip98/kindling/scan-context?industry=...&location=...&targetCount=...`: returns current matching counts, coverage, recent companies, and prior scan strategies.
- `POST /api/nip98/kindling/scan-results`: writes a partial or final scan batch through NIP-98 edit access.
- `POST /api/kindling/pipeline-write/target-scan`: writes a token-scoped partial pipeline batch for runs that use webhook-token auth rather than NIP-98.

Partial writes are repeatable and do not mark the run complete. The final webhook remains the pipeline completion signal, but the WApp discovery job should remain `partial` when the returned company count is below the requested target. Planned next strategies must be displayed separately from strategies actually run.

It returns:

- `result.outputKind = "target_scan_result"`
- `result.industry`
- `result.location`
- `result.originalRequest`
- `result.normalisedLocations`
- `result.coverage`
- `result.companies`
- `result.companiesArtifact`
- `result.possibleDuplicates`
- `result.searchSlices`
- `result.activities`
- `result.warnings`
- `result.confidence`

The scan remains company-discovery only. People-finding, deeper profiling, scoring, and outreach stay in later stages.

## Company Enrichment Pipeline

`kindling-enrich-company` has two steps:

1. `enrich-company-profile`: an agent step that uses supplied company context, known sources, and available source tools to propose company-level profile updates.
2. `deliver-company-enrichment`: a deterministic function that normalises the result and posts the WApp callback.

It returns:

- `result.outputKind = "company_enrichment"`
- `result.companyId`
- `result.companyName`
- `result.profilePatch`
- `result.fieldsUpdated`
- `result.sources`
- `result.activities`
- `result.confidence`
- `result.gaps`
- `result.warnings`

The enrichment pipeline avoids person discovery for now. It focuses on source-backed company facts and records missing fields as gaps.

## Outreach Draft Pipeline

`kindling-draft-outreach` has five steps:

1. `craft-outreach-positioning`: an agent reviews the company offerings, Kindling's research on the company, the active service profile, and any known signals. It produces unique selling points, positioning angles, safe personalisation inputs, claims to avoid, and evidence gaps.
2. `draft-example-one`: a drafting agent creates a concise practical direct pitch from the positioning brief.
3. `draft-example-two`: a drafting agent creates a consultative problem-led pitch from the same positioning brief.
4. `draft-example-three`: a drafting agent creates a local plain-spoken pitch from the same positioning brief.
5. `deliver-outreach-draft`: a deterministic function normalises the positioning and all three examples, then posts the WApp callback.

It returns:

- `result.outputKind = "outreach_draft"`
- `result.companyId`
- `result.companyName`
- `result.positioning`
- `result.variants`
- `result.subject`
- `result.body`
- `result.openingLine`
- `result.callToAction`
- `result.rationale`
- `result.personalisationInputs`
- `result.warnings`
- `result.confidence`

`result.subject` and `result.body` remain as backward-compatible aliases for the first variant. The app should prefer `result.variants` and show all three draft examples for review.

## Stub Result Shapes

The `develop_service_offering` stub fallback returns:

- `result.outputKind = "market_profile_update"`
- `result.profileVersionPatch`
- `result.nextQuestions`

`scan_target_list` returns:

- `result.outputKind = "target_scan_result"`
- `result.industry`
- `result.location`
- `result.normalisedLocations`
- `result.coverage`
- `result.companies`
- `result.possibleDuplicates`

`enrich_company` returns:

- `result.outputKind = "company_enrichment"`
- `result.companyId`
- `result.companyName`
- `result.fieldsUpdated`
- `result.sources`
- `result.confidence`
- `result.gaps`

`draft_outreach` returns:

- `result.outputKind = "outreach_draft"`
- `result.companyId`
- `result.companyName`
- `result.subject`
- `result.body`
- `result.rationale`
- `result.confidence`

## Autopilot Files

Current stub definitions:

- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-develop-service-offering-stub.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-scan-target-list-stub.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-enrich-company-stub.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-draft-outreach-stub.v1.json`

They share one deterministic callback function:

- `~/.wingmen/pipelines/users/honest-ivory-thicket/functions/kindling-stub-webhook.v1.ts`

Current first-pass working pipelines:

- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-develop-service-offering.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/functions/kindling-deliver-profile-update.v1.ts`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-scan-target-list.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/functions/kindling-deliver-target-scan.v1.ts`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-enrich-company.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/functions/kindling-deliver-company-enrichment.v1.ts`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/definitions/kindling-draft-outreach.v1.json`
- `~/.wingmen/pipelines/users/honest-ivory-thicket/functions/kindling-deliver-outreach-variants.v1.ts`

## Expansion Path

Keep the public role trigger keys stable until there is a reason to split production and test pipelines. Replace the internals progressively:

1. Add validation and WApp NIP-98 context reads.
2. Add planning/extraction agent steps.
3. Add research/enrichment agent steps.
4. Add deterministic normalisation and confidence scoring.
5. Keep the same webhook envelope so WApp code remains stable.
