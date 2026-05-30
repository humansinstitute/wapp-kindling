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

## Local Run

```bash
bun install
PORT=4317 WINGMAN_URL=http://localhost:3256 CHAT_WAPP_ALLOW_MOCK=0 bun src/server.ts
```

Open `http://localhost:4317/act`.

You need a Nostr browser signer for login and for NIP-98 requests to Autopilot. Until access rules exist, the first signed-in user can bootstrap settings. After that, only configured read/edit npubs can use the app, and only edit users can change admin settings or role mappings.

## Local Data

The default SQLite path is `data/chat-wapp.sqlite`. The environment variable is still `CHAT_WAPP_DB_PATH` because this repo grew from the chat WApp starter.

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

Kindling triggers Autopilot with:

```txt
POST /api/pipelines/triggers/http/:pipelineSlug
```

When no server-side trigger token is configured, Kindling asks the browser to sign the Autopilot trigger as a NIP-98 request. Long-running work happens inside Autopilot; the WApp records a local run, shows high-level status, and applies the webhook or write callback when the pipeline finishes.

Scan pipelines may call `POST /api/kindling/pipeline-write/target-scan` as companies are discovered, then call the normal webhook to close the run.

## Validation

```bash
bun run check
bun test
```
