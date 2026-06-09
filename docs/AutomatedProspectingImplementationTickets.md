# Automated Prospecting Implementation Tickets

Date: 2026-06-09

Status: implementation planning document. This is not product code and does not apply migrations, pipeline changes, or UI changes.

Source design: [AutomatedProspectingLoopDesign.md](./AutomatedProspectingLoopDesign.md)

## Answer

Three broad workstreams are not enough to close the gaps in the design. The design introduces state normalization, editable segment hierarchy, coverage accounting, scheduler state, queue state, structured enrichment evidence, service-specific scoring, top-target aggregation, outreach versioning, feedback, and UI surfaces. Those need to be implemented as ordered tickets so each change can be reviewed and validated independently.

The recommended implementation backlog is 18 tickets. Tickets 1-6 create the durable WApp foundation, tickets 7-10 automate acquisition and enrichment, tickets 11-14 add scoring and top-target generation, tickets 15-16 add outreach review, and tickets 17-18 close the feedback/review loop.

## Ticket 1: Normalize Prospect State Vocabulary

Goal: align company rings, queue statuses, and UI/API labels before adding more automation.

Depends on: design approval.

Scope:

- Define canonical `companies.data_ring` values.
- Define execution statuses separately from data maturity.
- Add compatibility mapping for existing values such as `seed`, `manual`, `discovered`, and `enriched`.
- Update docs and tests for expected transitions.

Acceptance:

- Existing company list and filters still work.
- Existing scan, enrichment, and outreach tests pass.
- No existing record disappears because of state naming.
- State transitions are documented in `docs/DataModel.md` or a linked migration note.

Closes design gaps:

- Company state machine.
- Status normalization.

## Ticket 2: Add Target Segment Hierarchy Schema

Goal: store Adapt's target hierarchy as editable WApp state instead of free-text industry only.

Depends on: Ticket 1.

Scope:

- Add `target_segments`.
- Add `company_segments`.
- Support parent/child hierarchy, priority, active/parked status, scan prompts, and coverage targets.
- Seed the Perth-first Adapt hierarchy from the design.

Acceptance:

- Seeded hierarchy includes Tier 1 SME advisory segments.
- Companies can be assigned to one or more segments with confidence.
- Existing `industry` text remains available during transition.

Closes design gaps:

- Editable industry/segment hierarchy.
- Segment membership.

## Ticket 3: Add Segment APIs

Goal: expose segment hierarchy through Kindling APIs.

Depends on: Ticket 2.

Scope:

- Add `GET /api/kindling/target-segments`.
- Add create/update endpoints for segment label, parent, priority, status, prompts, and targets.
- Add API shape for company segment membership.

Acceptance:

- Segment tree can be read and edited through API tests.
- Invalid parent loops are rejected.
- Segment updates do not break existing company APIs.

Closes design gaps:

- Target segment API gap.

## Ticket 4: Add Coverage Slice Schema

Goal: persist coverage by segment, geography, source family, and strategy beyond individual scan jobs.

Depends on: Tickets 2-3.

Scope:

- Add `coverage_slices`.
- Add optional `target_geographies` or a transitional geography text field.
- Link `discovery_jobs` and `scan_strategy_attempts` to segment and coverage slice.
- Store current counts, target counts, yield metrics, last run, next run, and stalled reason.

Acceptance:

- Existing scan strategy attempts can roll up into coverage.
- Coverage slices survive multiple scan jobs.
- Planned-next strategies are not counted as executed attempts.

Closes design gaps:

- Persistent coverage.
- Geography hierarchy or transitional geography model.

## Ticket 5: Add Coverage APIs and Summary Counts

Goal: make coverage visible to scheduler and UI.

Depends on: Ticket 4.

Scope:

- Add `GET /api/kindling/coverage-slices`.
- Add `PATCH /api/kindling/coverage-slices/:id`.
- Add coverage totals to `/api/kindling/summary`.
- Add query helpers for found, unique, duplicate, weak-source, enriched, scored, outreach-ready, parked, and stale counts.

Acceptance:

- API returns counts by segment and geography.
- Counts match SQLite records in tests.
- Coverage summary distinguishes executed attempts from recommendations.

Closes design gaps:

- Coverage model.
- Coverage health surface backend.

## Ticket 6: Add Scheduler Settings, Locks, and Run Log

Goal: give Kindling durable scheduler state before enabling automated pipeline triggers.

Depends on: Tickets 1-5.

Scope:

- Add `scheduler_settings`.
- Add `scheduler_runs`.
- Add scheduler lock or lease table.
- Store target pool size, enriched floor, top-target count, per-role concurrency, cooldowns, and enabled/disabled flags.

Acceptance:

- Settings survive restart.
- Scheduler run log explains selected action or skip reason.
- Locks prevent duplicate concurrent scheduler runs.

Closes design gaps:

- Scheduler config.
- Scheduler run state.

## Ticket 7: Add Scheduler Dry-Run Endpoint

Goal: validate scheduler decisions before any pipeline is triggered automatically.

Depends on: Ticket 6.

Scope:

- Add `POST /api/kindling/scheduler/run-once?dryRun=true`.
- Compute next acquisition/enrichment/scoring/outreach action.
- Return chosen queue item or segment plus reason.
- Do not trigger Autopilot in dry-run mode.

Acceptance:

- Dry-run is deterministic for a fixed database state.
- Dry-run explains why no work is available.
- Dry-run respects disabled scheduler and concurrency limits.

Closes design gaps:

- Scheduled operating model validation.

## Ticket 8: Implement Scheduled Acquisition Selector

Goal: select the next under-covered segment/geography slice for acquisition.

Depends on: Tickets 4-7.

Scope:

- Compute segment deficits against coverage targets.
- Penalize stale low-yield slices.
- Prefer active Tier 1 Perth segments.
- Create a scheduler run record with selected acquisition work.

Acceptance:

- Selector picks highest-priority under-covered segment.
- Parked segments are skipped.
- Low-yield slices respect cooldown.

Closes design gaps:

- Scheduled target acquisition loop.
- Coverage-based work selection.

## Ticket 9: Trigger Acquisition Pipeline from Scheduler

Goal: automate company acquisition using the existing target scan pipeline contract.

Depends on: Ticket 8.

Scope:

- Trigger existing `scan_target_list` role from scheduler.
- Include segment, coverage slice, prior executed strategies, target count, write API, and webhook.
- Update coverage from partial writes and final webhook.

Acceptance:

- Run-once starts one acquisition job when dry-run is false.
- Partial writes still use `pipeline-write/target-scan` or NIP-98 scan results.
- Final webhook closes the scheduler run.
- Failed acquisition leaves retryable state.

Closes design gaps:

- Acquisition pipeline contract.
- Scheduler to Autopilot integration.

## Ticket 10: Add Rich Enrichment Queue State

Goal: replace blunt industry enrichment with a prioritized queue.

Depends on: Tickets 1-6.

Scope:

- Add `work_queue` or role-specific enrichment queue fields.
- Store kind, target type, target id, segment, priority, reason, attempts, next run time, lock/run id, error, and context.
- Keep existing `enrichment_requests` compatible or migrate it into the new queue.

Acceptance:

- Queue can represent company enrichment work with priority and retry.
- Failed or timed-out jobs can be retried.
- Existing manual enrichment endpoint still works.

Closes design gaps:

- Queue state.
- Enrichment queue.

## Ticket 11: Persist Structured Enrichment Evidence

Goal: make enrichment outputs usable for scoring and outreach reasoning.

Depends on: Ticket 10.

Scope:

- Add or align `customer_profile_versions`.
- Add richer `sources` fields from `docs/DataModel.md`.
- Add `signals`.
- Add `people` if caller view requires public decision-maker records in this phase.
- Update enrichment write API to persist profile versions, signals, sources, gaps, confidence, and activities.

Acceptance:

- Enrichment write creates source-backed structured records.
- Every signal has source evidence or an explicit low-confidence marker.
- Company detail returns profile versions, signals, and evidence.

Closes design gaps:

- Structured enrichment shape.
- Signals.
- Evidence linkage.
- Profile versions.

## Ticket 12: Add Initial Ranking Runs

Goal: rank enhanced companies cheaply before expensive company x offering scoring.

Depends on: Ticket 11.

Scope:

- Add `ranking_runs` and `ranking_items`, or extend `target_rankings` with run/type fields.
- Implement ranking based on source quality, segment priority, geography, owner-led hints, triggers, reachability, freshness, and missing-field risk.
- Add API to run/rebuild initial ranking.

Acceptance:

- Enhanced companies receive an initial rank.
- Ranking reason and score JSON are stored.
- Ranking can be rebuilt without losing old run history.

Closes design gaps:

- Initial ranking.
- Target ranking history.

## Ticket 13: Extract or Stabilize Service Offerings for Scoring

Goal: provide stable service-offering identities for company x offering assessments.

Depends on: Ticket 12.

Scope:

- Decide whether scoring reads active market-profile JSON or extracted rows.
- If extracted rows are chosen, add `service_offerings`.
- Include service lines and variants: AI consulting, Wingman implementations, custom WApps, training, scale, exit, succession, handover, maximizing value, reducing owner dependence.
- Add API to list active scoring offerings.

Acceptance:

- Each offering has a stable id/key for scoring.
- Offering versioning is tied to `market_profile_version_id`.
- Old assessment rows remain interpretable after profile changes.

Closes design gaps:

- Service offerings.
- Multiple Adapt service-offering scoring.

## Ticket 14: Add Service Fit Assessment Contract and Persistence

Goal: score one company against one Adapt service offering.

Depends on: Ticket 13.

Scope:

- Add pipeline role `score_company_service_fit`.
- Add `service_fit_assessments`.
- Add trigger builder for one company x one offering.
- Add `POST /api/kindling/pipeline-write/service-assessment`.
- Store score, band, confidence, drivers, fit explanation, evidence, caveats, recommended action, and source run.

Acceptance:

- 10 companies x 5 offerings can create 50 queue items.
- Assessment writes are idempotent by company, offering, profile version, and run.
- Evidence and caveats persist with the score.

Closes design gaps:

- Scoring pipeline contract.
- Service assessment rows.

## Ticket 15: Build Top-Target Aggregation

Goal: turn service assessments into the prioritized target list.

Depends on: Ticket 14.

Scope:

- Add `target_list_runs` and `target_list_items`, or extend `target_rankings` with list/run metadata.
- Compute best offering, best variant, why now, caveats, evidence quality, next action, and rank.
- Add `GET /api/kindling/top-targets`.
- Keep `/api/kindling/todays-targets` compatible or alias it.

Acceptance:

- Top-target list can be rebuilt from stored assessments.
- Each row has a reason, best offering, confidence, caveats, and next action.
- Low-confidence or high-caveat records are penalized or flagged.

Closes design gaps:

- Prioritized top-target list.
- Top-target snapshots.

## Ticket 16: Add Outreach Opportunity and Version Schema

Goal: support structured outreach review instead of one markdown draft only.

Depends on: Ticket 15.

Scope:

- Add `outreach_opportunities`.
- Add `outreach_versions`.
- Link opportunity to company, service assessment, market profile version, and top-target item.
- Store draft fields separately from reasoning JSON and evidence ids.
- Keep `outreach_drafts` compatible during transition.

Acceptance:

- One top target can have multiple outreach versions.
- Original AI draft and human edits are preserved.
- Outreach status can move through draft, reviewed, contacted, retry, closed.

Closes design gaps:

- Outreach versions.
- Outreach review persistence.

## Ticket 17: Add Structured Outreach Pipeline Write

Goal: let Autopilot return a pitch plus reasoning for the two-column review surface.

Depends on: Ticket 16.

Scope:

- Extend `draft_outreach` or add `prepare_outreach`.
- Add `POST /api/kindling/pipeline-write/outreach-version`.
- Include left-column draft fields and right-column reasoning/evidence/caveats.
- Store backward-compatible `outreach_drafts.pitch_text` if needed.

Acceptance:

- High-scoring target can generate outreach version.
- Evidence links and claims-to-avoid are stored.
- Draft review can show pitch and reasoning separately.

Closes design gaps:

- Outreach pipeline contract.
- Pitch/reasoning review surface backend.

## Ticket 18: Build Automated Prospecting UI Surfaces

Goal: expose the loop to users without requiring them to understand pipeline internals.

Depends on: Tickets 5, 7, 10, 15, 17.

Scope:

- Coverage health view.
- Scheduler/queue health view.
- Top targets view.
- Outreach review view with draft left and reasoning right.
- Feedback actions: call, email, defer, dismiss, park, contacted.

Acceptance:

- User can inspect coverage and backlog.
- User can review top targets and understand why they rank.
- User can review outreach with evidence before acting.
- Feedback changes status and future ranking inputs.

Closes design gaps:

- UI surfaces.
- Human review loop.

## Ticket 19: Add Outreach Feedback and Review Metrics

Goal: close the learning loop for weekly reviews.

Depends on: Ticket 18.

Scope:

- Add or align `outreach_feedback`.
- Add weekly metrics for lead quality, scoring accuracy, enrichment gaps, caller usefulness, segment yield, and UX friction.
- Feed feedback into ranking and segment-priority review.

Acceptance:

- Feedback can be captured with minimal fields.
- Weekly review can report segment yield and lead quality.
- Parked and stale records have revisit rules.

Closes design gaps:

- Feedback loop.
- Validation cadence.

## Recommended Delivery Batches

Batch 1: Foundation

- Ticket 1
- Ticket 2
- Ticket 3
- Ticket 4
- Ticket 5
- Ticket 6
- Ticket 7

Batch 2: Acquisition and Enrichment Automation

- Ticket 8
- Ticket 9
- Ticket 10
- Ticket 11
- Ticket 12

Batch 3: Scoring and Top Targets

- Ticket 13
- Ticket 14
- Ticket 15

Batch 4: Outreach Review and Feedback

- Ticket 16
- Ticket 17
- Ticket 18
- Ticket 19

## Minimum Viable Review Cut

If Pete wants the smallest useful implementation pass, do not reduce this to three tickets. Use this smaller first cut instead:

1. Ticket 1: Normalize state vocabulary.
2. Ticket 2: Add target segment hierarchy schema.
3. Ticket 4: Add coverage slice schema.
4. Ticket 6: Add scheduler settings, locks, and run log.
5. Ticket 7: Add scheduler dry-run endpoint.
6. Ticket 8: Implement scheduled acquisition selector.
7. Ticket 9: Trigger acquisition pipeline from scheduler.

That cut would validate the acquisition side of the automated loop only. It would not close enrichment evidence, service scoring, top-target review, outreach versioning, or feedback gaps.

## Coverage Against Design Gaps

| Design gap | Ticket coverage |
| --- | --- |
| State machine and status normalization | 1 |
| Editable segment hierarchy | 2, 3 |
| Coverage model | 4, 5 |
| Scheduler state | 6, 7 |
| Scheduled acquisition loop | 8, 9 |
| Enrichment queue | 10 |
| Structured enrichment shape | 11 |
| Initial ranking | 12 |
| Service offering scoring | 13, 14 |
| Top-target list | 15 |
| Outreach review and versioning | 16, 17, 18 |
| Schema/API gaps | 1-17 |
| Pipeline contracts | 9, 11, 14, 17 |
| UI surfaces | 18 |
| Validation and review loop | 19 |
| Not-yet scope guardrails | All tickets exclude email sending, LinkedIn automation, paid data providers, CRM sync, autonomous outreach, and direct SQLite access by agents. |
