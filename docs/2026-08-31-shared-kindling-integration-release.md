# Shared Kindling integration and release handoff

## Outcome

Integrate and publish the three reviewed Kindling work packages, preserving
their histories and proving the requested collaboration flow:

1. Autopilot Tower DB broker and legacy Kindling identity custody migration;
2. Kindling API shared-service contract;
3. Kindling FE browser-authorized sync and CapRover image.

The originating Flight Deck task is `Make Kindling a shared collaborative
service`, task `5ff305ee-b25d-4472-867e-e94a261eb79c`, from Pete message
`609f6d33-5618-4d3a-895f-352336dc0374`.

## Reviewed feature branches

- `/Users/mini/code/wm/autopilot`
  - `feat/wapp-tower-request-broker`
  - broker base commit `9d288f6`
  - a follow-up custody-migration commit will be at branch HEAD before this
    integration starts.
- `/Users/mini/code/kindlingapi`
  - `feat/shared-kindling-service`
  - commit `858728f`
  - independently validated: typecheck and 42/42 tests.
- `/Users/mini/code/kindling-fe`
  - `feat/collaborative-kindling-frontend`
  - commits `a5a05fe`, `863537c`, `e583fe6`, `58e2b58`
  - independently validated: `bun run validate`; 83 pass / 3 inherited full
    suite failures.

## Integration rules

- Fetch first and stop if a remote source branch advanced unexpectedly.
- Preserve all nonignored worktree state. Never reset, rebase, discard, or
  force-push.
- Autopilot: fast-forward `main` from the feature branch, run focused/full
  tests and typecheck, then push `main`. Do **not** update Autopilot `deployed`
  or restart it from the integration worker; Rick owns that final operational
  step after all other work is complete.
- Kindling API: fast-forward `main` from its feature branch, run `bun run check`
  and `bun test`, push `main`, then fast-forward `deployed` from `main` and push
  `deployed`. Return to `main`.
- Kindling FE: create local `main` from `origin/main`, deliberately merge
  `feat/collaborative-kindling-frontend` with a Conventional Commit merge
  message, preserving both divergent histories. Resolve conflicts by retaining
  the current Athena functionality plus the reviewed canonical adapter; never
  choose one whole side. Run `bun run validate` and the full suite.
- Investigate and, if the fixes are small/deterministic and behaviorally
  correct, repair the three inherited FE failures before release:
  `custom_wapps` fixture, top-target caveat ordering, and coverage
  scored/processed counts. Add/update tests and commit any corrections on
  `main` with a Conventional Commit. If a correction would change product
  policy rather than repair an evident defect, leave it classified and report
  it instead of guessing.
- Push FE `main`; create or update `deployed` only by fast-forwarding from
  `main`; push `deployed`; return to `main`.
- Verify `git merge-base --is-ancestor main deployed` and zero uncommitted
  files in each release worktree (except explicitly reported user state).

## Operational boundary

Do not execute the real legacy-key migration, restart Autopilot, mutate Tower,
start KindlingAPI, create/deploy CapRover apps, or alter live app registry
configuration from this integration worker. Rick will perform those steps in
order after the branches are published. Do not print or inspect any signing
secret.

## Required report

Return all final branch/commit hashes, exact test results, remote push results,
FE merge strategy/conflicts, inherited-failure disposition, and clean/ancestry
evidence. Nothing should be claimed deployed merely because `deployed` was
pushed.
