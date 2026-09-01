# Kindling SaaS frontend implementation handoff

## Goal

Convert `kindling-fe` from a server-side SQLite/Tower materialised company replica into an API-driven frontend for the hosted `kindling-be`, while retaining a bounded disposable browser cache for responsive list/detail navigation.

This work is tracked on @[Make Kindling a shared collaborative service](mention:task:5ff305ee-b25d-4472-867e-e94a261eb79c) and originated in Flight Deck thread `f8284d92-772c-437c-9703-5499643cf5a2`. The durable architecture is `/Users/mini/wingmen/wingman21/mynotes/kindling-saas-architecture-discussion.md` and Flight Deck document @[Kindling SaaS Architecture Discussion](mention:document:83a96b56-d1cf-4f73-b87a-cabfc240136e). Read it and this repo's `AGENTS.md` before changing code.

## Current state

- Repo: `/Users/mini/code/kindling-fe`
- Source branch: `main`; deploy branch: `deployed`
- Local `main`/`deployed` are at `af35525`, one reviewed commit ahead of `origin/main`/`origin/deployed`; preserve and include it.
- Current production at `https://kindling-fe.a.otherstuff.ai` uses a server-side SQLite cache containing 6,832 companies synced from the Tower-backed API. That full replica and required sync cursor are being superseded.
- Existing UI is mostly vanilla browser JS plus a Bun server. Do not perform a cosmetic rewrite that loses current Kindling navigation or company UX. It is acceptable to use framework-agnostic TanStack Query Core instead of rewriting the entire app to React if that is the safer incremental path.

## Required implementation

Work directly on `main`. Preserve concurrent changes. Commit every nonignored tested change in this worktree using Conventional Commits. Do not reset, rebase, force-push, restart Autopilot, or restart unrelated apps.

1. Make `kindling-be` the sole authority for company list/detail/count and related new SaaS records. The frontend/server must not require its SQLite company mirror, a full snapshot, or a change cursor before displaying data.
2. Retain a same-origin frontend API proxy or safe runtime-configured direct API client so CapRover production can point at the new backend without embedding secrets. The browser should use a secure human session; never add a raw Nostr private key to the frontend server.
3. Introduce a real server-state query layer:
   - TanStack Query/Query Core for request deduplication, paging, background refetch and in-memory caching;
   - an IndexedDB persister for a bounded working set (recent list pages, company details, target lists/query metadata), not the whole company corpus;
   - React/Zustand/component state only for UI state if those libraries are introduced—do not use them as a hand-built server replica.
4. Cache keys must include user, organisation/workspace, API/schema version and query/filter/sort parameters. Cached values include freshness/version metadata such as ETag, `row_version` or `updated_at`.
5. Use stale-while-revalidate only after authentication/workspace resolution. Eligible cached data may render immediately but must revalidate with `kindling-be`.
6. Purge or make cache unreadable on logout, workspace switch, membership/role loss, 401/403, and incompatible schema version. Never persist session tokens, NIP-98 events, integration credentials or private keys in the application cache.
7. Writes always go to the backend. Optimistic in-memory UI updates may roll back; no durable offline mutation queue in this release. The app must remain correct with IndexedDB disabled, empty, stale or deleted.
8. Replace misleading health fields tied to server replication. `/api/health` should report frontend/build/API configuration and backend reachability; browser diagnostics may report query-cache availability without treating cached rows as authority.
9. Keep server `/data` persistence unnecessary for the new production image. Remove the CapRover persistent volume assumption from source/deployment documentation/config.
10. Update tests to prove:
   - first render comes from live API without a completed sync;
   - cached page renders then revalidates;
   - cache isolation between workspace/user keys;
   - cache purge on logout/workspace/auth/schema changes;
   - 401/403 never leaks stale cross-tenant rows;
   - paging/list/detail remain functional and a cache deletion causes no data loss.
11. Update Docker/captain-definition/runtime docs for the new backend URL and health checks. Do not deploy yet; the manager will integrate backend origin and deploy both services together.

## Compatibility contract

Coordinate against both the new documented company endpoints and the current `/api/v1/targets` compatibility routes. Keep the backend base URL runtime-configurable. If the backend worker has not finished, implement a typed adapter with explicit response contracts and mock/fixture tests rather than coupling to undocumented fields.

## Acceptance evidence

- Typecheck/tests/build pass.
- No production code path needs `bun:sqlite` or a server-side company cache to list/detail companies.
- Browser persistence is bounded and tenant-scoped; it is disposable without loss of correctness.
- Docker image builds and honours `PORT` plus the runtime backend origin.
- `main` is committed and pushed. Do not update `deployed`; the manager will use an integration/deployment session after backend compatibility is validated.

## Report

Return the commit SHA, API adapter contract, cache design/limits/purge behaviour, exact tests/builds, and any backend compatibility requirement through the supervised dispatch callback. Do not post directly to Pete or Flight Deck; the manager session owns that handoff.
