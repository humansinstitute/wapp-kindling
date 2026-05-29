# Autopilot Pipeline Contracts

Kindling calls Autopilot pipelines by role. The WApp owns screens, local SQLite state, run records, webhook tokens, and final application state. Autopilot owns pipeline definitions and long-running agent work.

The first Autopilot support set is stubbed so the WApp can exercise the full workflow before real research and enrichment steps are added.

## Seed Pipeline Roles

| Role key | Default trigger key | Discovered slug | Output kind |
| --- | --- | --- | --- |
| `develop_service_offering` | `kindling-develop-service-offering-stub` | `kindling-develop-service-offering-stub.v1` | `market_profile_update` |
| `scan_target_list` | `kindling-scan-target-list-stub` | `kindling-scan-target-list-stub.v1` | `target_scan_result` |
| `enrich_company` | `kindling-enrich-company-stub` | `kindling-enrich-company-stub.v1` | `company_enrichment` |
| `draft_outreach` | `kindling-draft-outreach-stub` | `kindling-draft-outreach-stub.v1` | `outreach_draft` |

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

The stub pipelines post one completion callback to the supplied webhook:

```json
{
  "requestId": "local-request-id",
  "role": "scan_target_list",
  "status": "ok",
  "stub": true,
  "generatedAt": "2026-05-29T00:00:00.000Z",
  "response": "Short user-facing summary",
  "result": {},
  "metadata": {
    "source": "kindling-stub-pipeline",
    "pipelineRole": "scan_target_list",
    "stub": true
  }
}
```

The WApp should treat `requestId` as the local join key and use the Autopilot trigger response to store the Autopilot `run.id`. The callback does not need to include the run ID in the first stub version.

## Stub Result Shapes

`develop_service_offering` returns:

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

## Expansion Path

Keep the public role slugs stable until there is a reason to split production and test pipelines. Replace the internals progressively:

1. Add validation and WApp NIP-98 context reads.
2. Add planning/extraction agent steps.
3. Add research/enrichment agent steps.
4. Add deterministic normalisation and confidence scoring.
5. Keep the same webhook envelope so WApp code remains stable.
