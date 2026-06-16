# Automated Prospecting Batch 3 Dispatch Plan

Date: 2026-06-09

Status: batch 3 implementation pipelines complete.

Source ticket plan: [AutomatedProspectingImplementationTickets.md](./AutomatedProspectingImplementationTickets.md)

## Batch 3 Completion Target

Batch 3 is complete when tickets 1-15 from the implementation ticket plan have passed worker implementation and manager review.

The target includes:

- Batch 1: foundation tickets 1-7.
- Batch 2: acquisition and enrichment automation tickets 8-12.
- Batch 3: scoring and top-target tickets 13-15.

Out of scope for this batch:

- Ticket 16: outreach opportunity/version schema.
- Ticket 17: structured outreach write API.
- Ticket 18: automated prospecting UI surfaces.
- Ticket 19: outreach feedback and review metrics.

## Dispatch Policy

Run tickets sequentially by default. Do not run adjacent schema/API tickets in parallel against the same repository because they are likely to touch `src/db.ts`, `src/server.ts`, docs, and API tests.

Each ticket should use `software-implementation-review-loop` with:

- `workingDirectory`: `/Users/mini/code/wapp-kindling`
- `designDocumentUrl`: `/Users/mini/code/wapp-kindling/docs/AutomatedProspectingImplementationTickets.md`
- `relevantContext`: `/Users/mini/code/wapp-kindling/docs/AutomatedProspectingLoopDesign.md`
- `maxReviewIterations`: `3`
- worker/manager/reporter agent: `codex`

Before starting the next ticket:

1. Confirm the previous pipeline run is complete.
2. Confirm manager review reports `done: true`.
3. Confirm repo validation evidence exists.
4. Inspect `git status --short`.
5. If the previous run left unresolved pickups, do not dispatch the next ticket.

## Ordered Ticket Runs

| Order | Ticket | Batch | Dispatch status | Pipeline run id | Notes |
| --- | --- | --- | --- | --- |
| 1 | Ticket 1: Normalize Prospect State Vocabulary | 1 | complete | `47456bf6-313d-4fe7-a824-a3960d606677` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. Earlier direct shared run `31c4b72b-2d3c-4ddb-bf52-454295545437` was stopped as superseded because it lacked dispatch workPlan input. |
| 2 | Ticket 2: Add Target Segment Hierarchy Schema | 1 | complete | `7d93f592-ff87-4c1b-8bc3-450fb1f1d6fc` | Completed after 1 review iteration. Validation: `bun run check`, `bun test tests/kindling-api.test.ts`, `bun test`. |
| 3 | Ticket 3: Add Segment APIs | 1 | complete | `e769454f-b112-42a8-acf6-9ff0c92f75b2` | Completed after 1 review iteration. Validation: `bun run check`, `bun test tests/kindling-api.test.ts`, `bun test`. |
| 4 | Ticket 4: Add Coverage Slice Schema | 1 | complete | `02ad97a2-c588-4168-b722-e15fc18e2a51` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. |
| 5 | Ticket 5: Add Coverage APIs and Summary Counts | 1 | complete | `7beea6fc-20da-45ad-ba25-dc3a98d38684` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. |
| 6 | Ticket 6: Add Scheduler Settings, Locks, and Run Log | 1 | complete | `f83e92bd-b122-4946-ab93-f10d64732d48` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. Manager noted minor future naming risk around expired `activeLock`, not a blocker. |
| 7 | Ticket 7: Add Scheduler Dry-Run Endpoint | 1 | complete | `e788def8-c97e-4df6-8574-2996c1241452` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. |
| 8 | Ticket 8: Implement Scheduled Acquisition Selector | 2 | complete | `a638f388-f194-47f8-98fc-8259f7741a99` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. Initial run `27602735-50a4-41ce-b323-5c41d22002d7` was superseded after optional MCP startup wedged before code work. |
| 9 | Ticket 9: Trigger Acquisition Pipeline from Scheduler | 2 | complete | `acaafbbf-e3d9-438c-a5a0-284f37af96d7` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. Manager pickup added direct non-deferred Autopilot trigger/failure coverage. |
| 10 | Ticket 10: Add Rich Enrichment Queue State | 2 | complete | `5e902d84-e2f6-4527-b707-0a498003ddfc` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. Manager pickup integrated legacy automatic enrichment queue lifecycle, locked queue skip, and compatibility coverage. |
| 11 | Ticket 11: Persist Structured Enrichment Evidence | 2 | complete | `5ab6e39b-c39b-4135-ba55-316ed0367d83` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. People records intentionally deferred. |
| 12 | Ticket 12: Add Initial Ranking Runs | 2 | complete | `13ed4182-96f4-4bae-abdc-03d30e5e4d59` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. Manager noted minor non-blocking no-segment explanation risk. |
| 13 | Ticket 13: Extract or Stabilize Service Offerings for Scoring | 3 | complete | `b7697a17-ee75-488c-ba17-3e9f0bb8430d` | Completed after 1 review iteration. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, `git diff --check`. |
| 14 | Ticket 14: Add Service Fit Assessment Contract and Persistence | 3 | complete | `2b6585fc-95dc-4152-9b3b-44f0ca298d72` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`, bootstrap function checks, pipeline definition JSON parse checks, `git diff --check`. Manager pickup fixed token-scope identity binding and offering-version context. |
| 15 | Ticket 15: Build Top-Target Aggregation | 3 | complete | `b72cee77-26eb-40cb-ab75-9512b1668bad` | Completed after 2 review iterations. Validation: `bun test tests/kindling-api.test.ts`, `bun run check`, `bun test`. Manager pickup fixed complete source assessment rebuilds, prevented `outreach_ready` promotion, and aligned `/todays-targets` docs. |

## Current Orchestration State

Tickets 1 through 15 are complete. Ticket 1 completed as pipeline `47456bf6-313d-4fe7-a824-a3960d606677` after two review iterations. Ticket 2 completed as pipeline `7d93f592-ff87-4c1b-8bc3-450fb1f1d6fc` after one review iteration. Ticket 3 completed as pipeline `e769454f-b112-42a8-acf6-9ff0c92f75b2` after one review iteration. Ticket 4 completed as pipeline `02ad97a2-c588-4168-b722-e15fc18e2a51` after two review iterations. Ticket 5 completed as pipeline `7beea6fc-20da-45ad-ba25-dc3a98d38684` after one review iteration. Ticket 6 completed as pipeline `f83e92bd-b122-4946-ab93-f10d64732d48` after one review iteration. Ticket 7 completed as pipeline `e788def8-c97e-4df6-8574-2996c1241452` after one review iteration. Ticket 8 completed as replacement pipeline `a638f388-f194-47f8-98fc-8259f7741a99` after one review iteration; initial Ticket 8 pipeline `27602735-50a4-41ce-b323-5c41d22002d7` was stopped and marked errored because the worker wedged during optional MCP startup before code work. Ticket 9 completed as pipeline `acaafbbf-e3d9-438c-a5a0-284f37af96d7` after two review iterations. Ticket 10 completed as pipeline `5e902d84-e2f6-4527-b707-0a498003ddfc` after two review iterations. Ticket 11 completed as pipeline `5ab6e39b-c39b-4135-ba55-316ed0367d83` after one review iteration. Ticket 12 completed as pipeline `13ed4182-96f4-4bae-abdc-03d30e5e4d59` after one review iteration. Ticket 13 completed as pipeline `b7697a17-ee75-488c-ba17-3e9f0bb8430d` after one review iteration. Ticket 14 completed as pipeline `2b6585fc-95dc-4152-9b3b-44f0ca298d72` after two review iterations. Ticket 15 completed as pipeline `b72cee77-26eb-40cb-ab75-9512b1668bad` after two review iterations. Batch 3 is complete. Superseded direct shared-pipeline run `31c4b72b-2d3c-4ddb-bf52-454295545437` was stopped and marked errored because it was launched through the task-backed shared definition without dispatch workPlan input.
