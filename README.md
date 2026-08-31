# Kindling WApp

Kindling FE is a local business-development WApp for shaping a service offering, building target lists, reviewing companies, and drafting outreach with Wingman Autopilot pipelines.

Kindling API `/api/v1` is authoritative for company identity and enrichment facts. Kindling FE keeps offer-specific scores, notes, lists, outreach, campaigns, and other workflow state locally, keyed by the canonical API company ID. A separate `canonical_company_cache` table marks the compatibility projection explicitly; legacy local-company authority is available only with `KINDLING_COMPANY_SOURCE=local`.

Canonical reads use browser-mediated NIP-98. Kindling FE prepares an exact API URL, the active browser signer authorizes it as the signed-in user, and the frontend server forwards only that short-lived signed event to Kindling API. No raw signing key is configured in the frontend server, image, or browser bundle. The managed app card injects the runtime-only `KINDLING_API_URL`, which defaults to the local API WApp at `http://127.0.0.1:41038` for isolated development.

## Product Flow

The first screen asks what Kindling should do today:

- Build service offering.
- Build target list.
- Review today's targets.
- Act on a selected company.

The first implementation keeps the workflow deliberately staged:

1. Build or update the active service offering profile.
2. Scan for companies from free-text industry and location prompts.
3. Review and filter company records in Kindling.
4. Enrich one selected company.
5. Generate three copyable outreach draft variants for that company.

Company discovery is company-only. People finding, duplicate resolution, monitoring, and deeper scoring are separate pipeline roles so they can be added iteratively without overloading the scan step.

## Pipeline Roles

Kindling stores role mappings locally so an admin can swap the active Autopilot pipeline behind each app action.

| Role | Default pipeline | Result |
| --- | --- | --- |
| Develop service offering | `kindling-develop-service-offering` | Updates the active market profile. |
| Scan target list | `kindling-scan-target-list` | Discovers companies, coverage, sources, warnings, and possible duplicates. |
| Enrich company | `kindling-enrich-company` | Adds company research, positioning, confidence, and next actions. |
| Draft outreach | `kindling-draft-outreach` | Produces three outreach draft variants for review and copy/paste. |

Future roles are stubbed in the data model for duplicate resolution, people finding, and monitor-and-score workflows.

## Bootstrap / Migration

Repo-local bootstrap assets live in `bootstrap/`:

- `bootstrap/LLM_INSTRUCTIONS.md` is the setup handoff for a target local agent.
- `bootstrap/pipelines/definitions/` contains Kindling pipeline definitions.
- `bootstrap/pipelines/functions/` contains Kindling pipeline functions.

The SQLite database is runtime state and is migrated separately. Use `bun scripts/export-migration.ts` to create a private migration bundle with a sanitized SQLite backup plus the repo-local bootstrap assets.

## Running As A WApp

Kindling should normally be launched and tested from its Wingman Autopilot WApp card. WApps are registered app cards in Autopilot, and the card owns the runtime port and public app URL. Do not pick an arbitrary local port for normal testing.

For Pete's local Wingman instance, use the separately registered `Kindling FE` app card described in `AGENTS.md`. The older Kindling app remains a sibling deployment and is not this checkout.

```txt
App label: Kindling FE
User alias: honest-ivory-thicket
```

Open Kindling from the Autopilot WApps/apps screen. The process is launched by Wingman with app environment such as `APP_ID`, `APP_LABEL`, `USER_ALIAS`, and an assigned `PORT`.

Each Wingman machine needs its own clone and Autopilot app card. The durable Pete/Andy/CapRover setup, feature-branch workflow, backend access contract, and integration procedure are in [Collaborative development and deployment](docs/CollaborativeDevelopment.md).

## Direct Developer Run

```bash
bun install
PORT=4317 WINGMAN_URL=https://<autopilot-public-host> bun src/server.ts
```

Use a direct run only for isolated development/debugging outside the WApp card runner. When testing the product flow, use the Kindling app card URL assigned by Wingman.

You need a Nostr browser signer for login and for NIP-98 requests to Autopilot. Until access rules exist, the first signed-in user can bootstrap settings. After that, only configured read/edit npubs can use the app, and only edit users can change admin settings or role mappings.

The company cache never syncs silently. Choose **Authorize API sync** in the Kindling header. Current, stale, offline/denied, and empty cache states are shown explicitly; a stale cache remains readable but is never labelled as current.

## Local Data

The default SQLite path is `data/chat-wapp.sqlite`. The environment variable is still `CHAT_WAPP_DB_PATH` because this repo grew from the chat WApp starter.

Important Kindling routes:

```txt
GET  /api/kindling/summary
GET  /api/kindling/canonical-status
POST /api/kindling/canonical-sync
GET  /api/kindling/companies
POST /api/kindling/companies
POST /api/kindling/service-offering
POST /api/kindling/target-scans
POST /api/kindling/companies/:companyId/enrich
POST /api/kindling/companies/:companyId/outreach
POST /api/kindling/pipeline-webhook
POST /api/kindling/pipeline-write/target-scan
```

The legacy chat route remains available from the Home screen as a developer/testing surface for generic pipeline chat. Its default `chat-wapp-agent-response` Autopilot pipeline treats graph memory as optional: if graph memory is not configured or unavailable, the pipeline should continue with warnings and still deliver the webhook response.

## Autopilot Integration

Kindling triggers Autopilot with browser-signed NIP-98 requests to the exact Autopilot URL saved in Settings:

```txt
POST /api/pipelines/triggers/http/:pipelineSlug
```

Long-running work happens inside Autopilot; the WApp records a local run, shows high-level status, and applies the webhook or write callback when the pipeline finishes. Kindling does not use bearer trigger tokens or remap public Autopilot URLs to local addresses.

Scan pipelines may call `POST /api/kindling/pipeline-write/target-scan` as companies are discovered, then call the normal webhook to close the run.

## Validation

```bash
bun run validate
bun test # full inherited suite; see the collaboration guide for the current baseline classification
```

`bun run validate` deterministically runs typecheck, focused canonical auth/client tests, browser syntax validation, the browser signer build, the deployment contract, and a repository-file secret audit. A Docker image build and isolated-port smoke procedure are documented in the collaboration guide.
