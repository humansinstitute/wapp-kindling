# Collaborative Kindling frontend and CapRover handoff

## Goal

Make Kindling FE deployable to CapRover as the shared UI while Pete and Andy
can each run local Autopilot development copies from feature branches against
the same public Kindling API/Tower company database.

Flight Deck task: `Make Kindling a shared collaborative service`, originating
from message `609f6d33-5618-4d3a-895f-352336dc0374`.

## Architecture

- The public Kindling API is authoritative for company identity/enrichment and
  stores its app namespace in Tower Postgres.
- Each frontend/local agent keeps offer-specific scoring, ranking, notes,
  outreach, and workflow state locally, keyed by canonical company id.
- The CapRover frontend and local Pete/Andy frontends are consumers of the same
  API, not additional company authorities.
- Consumer browser/users and agents use their own NIP-98 identities. The
  CapRover frontend must not contain Kindling API's private key or a cloned
  local WApp key.

## Confirmed state

- Repo `/Users/mini/code/kindling-fe`, branch `adp` at `df4dae3`, three local
  commits ahead of latest pushed Athena `origin/adp` (`bed30fc`).
- `origin/main` is a divergent older line. Integration must be deliberate; do
  not reset/force it.
- `AGENTS.md` has a concurrent local modification and must be preserved.
- Current canonical adapter signs server-to-server reads with `WAPP_NSEC`.
- Live FE has a 6,832-company cache but reports `signerReady: false`.
- Typecheck passes; the canonical adapter tests pass; the inherited full suite
  is 81 pass / 3 pre-existing failures.
- Dockerfile and `captain-definition` exist, but collaborative/production
  config, health behavior, and branch docs are incomplete.

## Required implementation

1. Remove the CapRover/frontend-server dependency on a raw private signing key.
   Use browser-mediated NIP-98 for canonical API requests or another reviewed
   mechanism that preserves the user's/agent's own identity and works from
   CapRover and local Autopilot. Never embed or proxy-export a private key.
2. Keep local cached company projection behavior and cursor safety, but make
   sync authorization explicit and recoverable in the UI. Do not silently
   present a stale cache as live current data.
3. Configure the API base URL from runtime environment and document local Pete,
   local Andy, and CapRover values. Avoid build-time hardcoding.
4. Add API CORS/client contract requirements to the handoff if the backend must
   change; coordinate exact headers/routes through the callback.
5. Ensure `PORT` is honored, `/api/health` is useful for CapRover, and Docker
   deployment excludes local SQLite/runtime state and secrets.
6. Add a durable collaborative development guide:
   - clone repository locally on each Wingman;
   - register an Autopilot app card per machine;
   - use `feature/<person>-<topic>` branches;
   - run checks/tests/build before handoff;
   - integration agent reviews and merges into `main`;
   - `deployed` fast-forwards from `main` only;
   - no force pushes, resets, or secrets in Git;
   - CapRover smoke check after deployment.
7. Add a concise integration-agent prompt/checklist and a deterministic
   validation command or script.
8. Prepare the current branch for deliberate integration into `main`; document
   the branch divergence and expected merge strategy. Do not rewrite history.

## Validation

- Typecheck and focused canonical/auth/client tests.
- Full suite with any remaining failures classified and ideally corrected if
  they are deterministic regressions within scope.
- Docker image/build contract and local non-live test on an isolated port if
  needed; do not bypass the live app card for production validation.
- Health must distinguish API reachable/sync authorized/current cache from
  stale/offline cache.
- No signing secrets in tracked files, image layers, browser bundle, or runtime
  health output.

## Git and reporting

- Create `feat/collaborative-kindling-frontend` from current `adp`/`df4dae3`.
- Preserve the modified `AGENTS.md` and all concurrent state; do not reset,
  rebase, discard, or overwrite.
- Commit all tested nonignored state relevant to the task with Conventional
  Commits.
- Do not push, merge main/deployed, start/restart apps, or deploy. Rick will
  perform reviewed integration and production operations.
- Report commit, tests, auth flow, CapRover assumptions, branch integration
  notes, and any backend dependency.

## Implemented handoff contract

The reviewed frontend mechanism is same-origin browser-mediated NIP-98
forwarding. The server prepares only the exact canonical bootstrap, snapshot,
change, and target-detail GET URLs; the current browser actor signs each request
and the server verifies and forwards that event. No frontend signing-key
environment or persistent delegated credential is used.

Kindling API must grant `read` to each Pete/Andy/user/agent npub that will sync.
The forwarded headers are `accept: application/json` and `authorization: Nostr
<event>`. No CORS change is required because the browser calls the same-origin
frontend coordinator. Direct cross-origin browser access would require a later
backend change for explicit allowed origins, `GET, OPTIONS`, and the
`Authorization` header; wildcard origins and credential cookies are not part of
this contract.

Operational values, cache/health semantics, Docker assumptions, branch
divergence, smoke commands, and the collaborative workflow are durable in
`docs/CollaborativeDevelopment.md`; the integration prompt is in
`docs/IntegrationAgentChecklist.md`.

Read-only verification on 2026-08-31 found the configured public API origin
returning HTTP `404` with `reason: app_not_running` and status `idle` for app
`64765f89-035a-4832-acba-b633068ba2e0`, including `/api/v1/bootstrap`. Rick must
restore that managed API app through its normal app lifecycle and grant the
consumer npubs `read` before end-to-end sync can pass. This frontend task did
not start or restart it.
