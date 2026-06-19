# Kindling WApp

Kindling is a local business-development WApp for shaping a service offering, building target lists, reviewing companies, and drafting outreach with Wingman Autopilot pipelines.

The WApp owns the user interface, Nostr login, access rules, business records, and local SQLite database. Autopilot owns the pipeline runs and agent work. Pipeline results return to Kindling through run-scoped webhooks and write APIs.

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

For Pete's local Wingman instance, the Kindling app card is:

```txt
App label: Kindling
App ID: c8dc3b14-6869-444f-94c3-37ccb2348cc9
User alias: honest-ivory-thicket
```

Open Kindling from the Autopilot WApps/apps screen. The process is launched by Wingman with app environment such as `APP_ID`, `APP_LABEL`, `USER_ALIAS`, and an assigned `PORT`.

## Direct Developer Run

```bash
bun install
PORT=4317 WINGMAN_URL=https://<autopilot-public-host> bun src/server.ts
```

Use a direct run only for isolated development/debugging outside the WApp card runner. When testing the product flow, use the Kindling app card URL assigned by Wingman.

You need a Nostr browser signer for login and for NIP-98 requests to Autopilot. Until access rules exist, the first signed-in user can bootstrap settings. After that, only configured read/edit npubs can use the app, and only edit users can change admin settings or role mappings.

## Database Runtime

SQLite remains the default for tests and direct local fallback. The default SQLite path is `data/chat-wapp.sqlite`. The environment variable is still `CHAT_WAPP_DB_PATH` because this repo grew from the chat WApp starter.

When Autopilot starts Kindling as a Tower-backed WApp, it injects the app identity and Tower binding:

```txt
APP_NPUB
APP_NSEC
TOWER_URL
WORKSPACE_OWNER_NPUB
```

Tower mode is enabled when those four values are present, or explicitly with `KINDLING_DB_MODE=tower`. On startup Kindling signs Tower WApp DB requests with `APP_NSEC`, provisions its WApp DB namespace, and applies SQL migrations from `src/db/migrations/` before serving. `APP_NSEC` must only be injected as runtime secret material; do not write it into repo files, logs, or browser-visible responses.

Tower v1 exposes provision, migrations, and constrained per-table CRUD/query APIs. Kindling keeps browser auth, user/session/access checks, pipeline webhooks, and domain routes inside the WApp backend; browsers and agents should call Kindling APIs, not Tower DB directly.

In Tower mode, `CHAT_WAPP_DB_PATH` is not used as authoritative app storage. Auth challenge/verify/session/access-rule/settings flows, target segments, companies, reporting/dashboard routes, work queue, scheduler settings/preview/run-once, coverage, top-target/today views, chats, pipeline run bookkeeping, pipeline webhook/write handlers, enrichment, scoring, target scan, outreach, and service-offering workflows use Tower WApp DB APIs. Unknown API paths return HTTP 404 in Tower mode instead of falling back to SQLite. The legacy cleanup and automated prospecting startup timers stay disabled in Tower mode; explicit scheduler run-once requests prepare Tower-backed pipeline runs.

Important Kindling routes:

```txt
GET  /api/kindling/summary
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
bun run check
bun test
```
