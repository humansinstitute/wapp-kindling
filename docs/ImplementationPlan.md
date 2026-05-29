# Implementation Plan

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

## Open Implementation Questions

- What stack changes are needed in the current WApp starter before the first schema migration?
- Which Autopilot pipeline definitions should be created first as stubs?
- What is the exact webhook payload contract for each minimum pipeline role?
