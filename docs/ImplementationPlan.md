# Implementation Plan

## Pipeline Handoff Brief

This document is suitable as the brief for a software implementation loop pipeline.

Repository: `/Users/mini/code/wapp-kindling`

Objective: turn the existing chat WApp starter into the first full-path Kindling WApp. The first release should prove the full user workflow with local SQLite records and webhook-capable Autopilot pipeline stubs.

Implementation rule: build the full thin path first, then deepen each screen and pipeline role iteratively. Do not build a large speculative schema. Add the minimum tables, fields, API routes, and UI state required for each next vertical slice.

Primary validation commands:

```bash
bun run check
bun test
bun src/server.ts
```

Current starter shape:

- Runtime: Bun TypeScript server.
- Backend entry point: `src/server.ts`.
- SQLite setup: `src/db.ts` using `bun:sqlite`.
- Current pipeline trigger helper: `src/pipeline.ts`.
- Frontend: static app in `public/index.html`, `public/app.js`, and `public/styles.css`.
- Existing behavior: Nostr login, access rules, chat records, default pipeline selection, chat pipeline trigger, and webhook callback.

Hard constraints:

- Keep WApp data local in SQLite.
- Keep pipeline definitions in Autopilot, not in this WApp.
- Normal users interact with the WApp, not with pipeline internals.
- Pipeline settings are admin-only.
- Each required Autopilot pipeline role can start as a stub, but it must accept a trigger and post a valid webhook callback.
- Autopilot agents must use WApp APIs for app data. They should not directly read or write the WApp SQLite database.
- Company manual create requires only `name`.
- Build target list uses free-text industry and location fields, not dropdowns.
- The first outreach artifact is a copyable pitch suitable for pasting into email. Do not implement email sending in the first version.

First deliverable: a locally runnable WApp where the user can move through the full thin path:

1. Action hub.
2. Service offering workspace.
3. Target list builder.
4. Company list and manual company CRUD.
5. Company profile.
6. Enrichment request.
7. Today's targets priority list.
8. Copyable pitch workflow.

All four minimum pipeline roles should be triggerable through role configuration and able to complete through stub callbacks:

- Develop service offering.
- Scan target list.
- Enrich company.
- Draft outreach.

Definition of done for the first implementation loop:

- `bun run check` passes.
- The app starts locally.
- Admin can configure pipeline roles.
- Stub callbacks can update local records for the four minimum roles.
- The full thin path can be reviewed in the browser without using hidden database edits.
- The implementation updates this plan if it intentionally changes scope, schema, or pipeline contracts.

## Direction

Build the full thin path first, then deepen each part iteratively.

The first implementation should let a user move through the whole Kindling loop:

1. Open the action hub.
2. Build or revise a service offering.
3. Build a target list from free-text industry and location research inputs.
4. Review companies in a list.
5. Open and edit a company profile.
6. Trigger enrichment for a selected company.
7. Review today's targets as a priority-ordered list.
8. Generate a copyable pitch for a selected target.

The first pass can use stubbed pipeline responses and minimal records where needed. The important thing is to prove the WApp structure, data ownership, NIP-98 API boundary, pipeline-role configuration, webhook callback path, and user workflow end to end.

## Build Method

Use an iterative build-and-review loop:

- Implement a thin vertical slice.
- Run it locally.
- Review the UI and data shape.
- Add only the schema and business rules needed for the next slice.
- Replace stubs with real Autopilot pipeline steps progressively.

Avoid over-building the schema up front. Add tables and fields when the next workflow requires them.

## WApp Scope

The WApp owns:

- Local SQLite schema and migrations.
- Screens and navigation.
- Manual CRUD.
- Pipeline role settings.
- Pipeline trigger requests.
- Webhook verification and callback handling.
- NIP-98 APIs for Autopilot.
- User-visible records, statuses, drafts, and review workflows.

The WApp does not own:

- Autopilot pipeline definitions.
- Agent execution.
- Long-running web research.
- Pipeline internals or logs for normal users.

## Autopilot Pipeline Scope

Pipelines are Autopilot pipelines. They should be created and improved alongside the WApp build, but they live in Autopilot rather than inside the WApp.

The WApp should specify which pipeline roles it needs and provide the trigger payloads, callback URLs, NIP-98 APIs, and expected output contracts.

At minimum, every configured pipeline role should have a stub pipeline that:

1. Accepts the WApp trigger payload.
2. Returns quickly from the trigger.
3. Posts a valid webhook callback to the WApp.
4. Includes enough structured payload for the WApp to update local state.

After the WApp path is working with stubs, each pipeline can gain real steps for extraction, research, synthesis, scoring, and drafting.

## Required Pipeline Roles

Minimum role set:

- Develop service offering.
- Scan target list.
- Enrich company.
- Draft outreach.

Near-follow role set:

- Resolve duplicates.
- Find people.
- Monitor and score.
- Today's targets.

The minimum role set should be stubbed for the first full-path demo. The near-follow roles can be stubbed or represented by manual/local actions until the workflow reaches them.

Seed Autopilot stubs now exist for the minimum role set:

- `develop_service_offering` -> `kindling-develop-service-offering-stub`
- `scan_target_list` -> `kindling-scan-target-list-stub`
- `enrich_company` -> `kindling-enrich-company-stub`
- `draft_outreach` -> `kindling-draft-outreach-stub`

See [Autopilot Pipeline Contracts](./AutopilotPipelineContracts.md) for trigger payloads, webhook payloads, and stub result shapes.

## First Full-Path Demo

The first demo is successful when:

- The action hub displays the four equal-weight actions.
- Pipeline role settings exist for admins.
- A service-offering interaction creates or updates a market profile version, even if the pipeline is stubbed.
- A target-list request creates a discovery job and one or more company records from a stubbed callback.
- A company can be created manually with only a name.
- The company list can filter by industry, location, data ring, duplicate status, has website, and enrichment status.
- A company profile can be opened and edited.
- An enrichment request updates the company profile through a stubbed callback.
- Today's targets shows a priority-ordered list.
- The Act workflow produces a copyable pitch through a stubbed callback.

## Suggested Implementation Slices

1. Schema foundation: minimal SQLite tables for pipeline roles, pipeline runs, market profiles, companies, sources, activities, discovery jobs, enrichment requests, target rankings, and outreach drafts.
2. Action hub and navigation shell.
3. Admin pipeline settings with role-to-pipeline mapping.
4. Pipeline trigger and webhook callback plumbing.
5. Service offering workspace using stubbed service-offering callback.
6. Target list builder using stubbed scan callback.
7. Company list, filters, manual create, and profile edit.
8. Enrichment request and stubbed enrichment callback.
9. Today's targets priority list.
10. Act workflow and copyable pitch.

Each slice should leave the app usable and reviewable.

## First Schema Direction

Start with only the tables needed for the full thin path:

- `pipeline_roles`: role key, display name, active pipeline slug or ID, enabled state, expected output kind, updated timestamp.
- `kindling_pipeline_runs`: role key, local request ID, Autopilot run ID, status, webhook token, trigger payload JSON, result payload JSON, timestamps.
- `market_profiles`: active profile metadata and current version pointer.
- `market_profile_versions`: version number, structured JSON, summary, rationale, source references, timestamps.
- `companies`: name, optional location, optional industry, optional website, data ring, duplicate status, enrichment status, confidence, timestamps.
- `sources`: company ID, source type, URL or identifier, summary, confidence, timestamps.
- `activities`: target type, target ID, actor, action type, summary, payload JSON, timestamps.
- `discovery_jobs`: free-text industry, free-text location, status, counts, timestamps.
- `enrichment_requests`: company ID, status, request kind, summary, timestamps.
- `target_rankings`: company ID, rank, reason, score JSON, created timestamp.
- `outreach_drafts`: company ID, pitch text, status, source run ID, timestamps.

Keep JSON columns for early flexibility where the exact structure is still evolving.

## Webhook Contract Direction

Use one common callback endpoint shape for all minimum roles. The WApp can branch by `role` and `requestId`.

```json
{
  "requestId": "local-request-id",
  "role": "scan_target_list",
  "status": "ok",
  "stub": true,
  "response": "Short user-facing summary",
  "result": {},
  "metadata": {}
}
```

The WApp should store the Autopilot run ID from the trigger response. The callback does not need to repeat it for the first stub version.

Minimum role outputs:

- `develop_service_offering`: creates a market profile version with structured profile JSON, summary, and rationale.
- `scan_target_list`: updates a discovery job and creates company/source/activity records.
- `enrich_company`: updates company fields, sources, activities, and enrichment status.
- `draft_outreach`: creates an outreach draft with copyable pitch text.

## Remaining Implementation Questions

- Should the existing chat route stay available as a developer/testing surface, or be replaced entirely by Kindling screens?
- Should local WApp mock mode remain available as a development fallback after the Autopilot stubs are configured?
