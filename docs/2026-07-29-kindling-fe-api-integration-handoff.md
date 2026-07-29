# Kindling FE + Kindling API integration handoff

## Goal

Deliver a new local Wingman WApp named **Kindling FE** from the latest Athena Kindling frontend (`origin/adp` at dispatch), integrated with the canonical Kindling API rather than using its own company database as the authority.

Originating Flight Deck work:

- Task: @[Create local Kindling FE backed by Kindling API](mention:task:dac09fe9-718a-4a7c-842f-3d8600223552)
- Pete request: @[Create Kindling FE](mention:message:6faafeb2-37ad-4436-840a-c2a4182868e3)

## Current source state

- Repo: `/Users/mini/code/kindling-fe`
- Remote: `https://github.com/humansinstitute/wapp-kindling.git`
- Requested source branch: `adp`
- HEAD at clone: `bed30fcfcf454b14ef702610366449e4690e3810`
- This is a fresh sibling checkout. Do not modify or replace `/Users/mini/code/wapp-kindling`.
- Kindling API is currently registered locally at `https://late-cup-crab.rick.runwingman.com` and its repo is `/Users/mini/code/kindlingapi`.

## Required frontend behavior

1. Preserve the Athena Kindling user experience and workflow features.
2. Treat Kindling API `/api/v1` as the source of truth for canonical company identity and enrichment facts.
3. Authenticate frontend-to-API requests through the supported NIP-98 flow. Do not copy the Kindling API `WAPP_NSEC` into this frontend.
4. Add/configure a `KINDLING_API_URL` (or an equally explicit name) that can be injected by the Autopilot app card and defaults safely for local development.
5. Company list/detail reads should use API routes such as bootstrap, targets, bulk targets, and changes. Preserve local workflow data (offer-specific score, lists, notes, outreach/campaign state) keyed by canonical API company ID.
6. If the current frontend cannot be switched atomically, add a narrow adapter and explicit compatibility path; do not silently mix canonical API rows and local SQLite company rows.
7. Provide a health/status surface that proves which Kindling API base URL and sync cursor/source are active without revealing secrets.

## App registration/runtime

- Register a new Autopilot web app named `Kindling FE` pointing at `/Users/mini/code/kindling-fe`.
- Use the local `$WINGMAN_URL` and `appctl`; never hand-edit app registry JSON.
- Run setup/build through the app lifecycle as supported, then start the new app through Autopilot.
- Record app ID, assigned port, generated subdomain URL, running status, and `/api/health` response.
- Update `AGENTS.md` after registration so it describes the new app rather than the pre-existing Kindling app.
- Do not restart Autopilot or unrelated registered apps.

## Validation

- `bun install`
- `bun run check`
- `bun test`
- Focused tests for API URL/config, NIP-98 request preparation, company mapping, and sync-cursor behavior.
- Runtime health through the Autopilot-managed local port and public subdomain.
- Browser/API smoke evidence showing Kindling FE can read canonical company summaries/details from Kindling API.

## Git/worktree rules

- Work on the requested `adp` branch unless live evidence requires a safer local branch; explain any deviation.
- Preserve concurrent work. Do not reset, discard, or overwrite changes you do not understand.
- Commit all nonignored tested state in this checkout when ready. Do not push unless the manager explicitly requests it after review.
- Keep secrets out of git.

## Reporting

Report implementation path, changed files, validation output, app registry/runtime evidence, remaining API gaps, and commit hash back to the supervising session. Do not post directly to Flight Deck; Rick will review and post the durable handoff.

## Implementation result (2026-07-29)

- Added an explicit canonical API adapter in `src/canonical-api.ts` with NIP-98 request preparation using Kindling FE's own `WAPP_NSEC`.
- Added bootstrap plus monotonic change-cursor sync and a separate `canonical_company_cache` authority marker. The existing `companies` table is now only a compatibility projection for Athena workflow foreign keys when canonical mode is active.
- Company list/detail reads sync/fetch from Kindling API. Canonical identity and enrichment fields are read-only in FE; local workflow state remains keyed by canonical company ID.
- Added non-secret health/UI status for API URL, source, cursor, cache, signer readiness, and signer npub.
- Registered managed app `19a94999-012a-4c19-a80c-9367da344674` on port `41039` at `https://keen-rye-stem.rick.runwingman.com` and ran setup/build/start through `appctl`.
- The FE runtime is healthy locally and publicly. Its signer npub is `npub1nl0hac57enc56zzrsdzreff0ze23eu0p5l5zsx5zlyunmckwxv8qytsp8f`.
- Runtime canonical reads are currently blocked upstream: Kindling API returns `workspace app not found (404)` from Tower. API logs show this recurring since 2026-07-08. A supported Tower registration attempt returned `403 Not authorized to manage this workspace`, so Rick workspace authority is required to restore the API app registration.
- `bun run check`, lifecycle build, and the four focused canonical adapter tests pass. The inherited full suite has 80 passing and 3 pre-existing failing assertions unrelated to this adapter (service-offering seed expectation, top-target ordering expectation, and coverage-count expectation).
