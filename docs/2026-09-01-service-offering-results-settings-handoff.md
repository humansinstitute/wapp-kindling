# Kindling SaaS frontend contract bug implementation handoff

## Objective

Restore the Service Offering and Results screens and add secure backend selection in Admin/Settings. Work on `/Users/mini/code/kindling-fe` `main` for Flight Deck task `Restore Kindling service offerings, backend settings and results` (`a0d11029-8d6f-4ca0-b105-4aed49f2791d`).

Screenshots:

- Service Offering: `/Users/mini/code/wm/autopilot/tmp/uploads/images/npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy/codex/66f455f9-bfa2-4d07-b71c-08fb75e1da2a.png`
- Results: `/Users/mini/code/wm/autopilot/tmp/uploads/images/npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy/codex/42c42009-d6b6-4643-b8ee-97375b756380.png`

The frontend is intentionally stateless on the server. Do not reintroduce SQLite, Tower company storage or a server-side company replica.

## Backend API contract

Coordinate to this agreed `kindling-be` contract:

- `GET/POST /api/v1/workspaces/{workspaceId}/value-propositions`
- `GET/PATCH /api/v1/workspaces/{workspaceId}/value-propositions/{id}`
- `GET /api/v1/workspaces/{workspaceId}/outreach/results`
- `POST /api/v1/workspaces/{workspaceId}/outreach/{sent|undo|dismiss|respond|snooze}`

Value propositions contain `{id,name,active,currentVersion,version:{version,specification,approvalState,createdAt}}`. Results retain the existing UI shape `{tab,items,total,returned,limit,offset,counts}` and existing item/action fields. The backend handoff in the sibling repository has the full contract.

## Required frontend work

### Service Offering

- Replace the missing `/api/kindling/profile` and `/api/kindling/service-offering` gap with SaaS proxy adapters to the value-proposition endpoints.
- Preserve compatibility for existing UI consumers where useful, but make the Service Offering page genuinely support multiple workspace value propositions rather than fabricating one legacy profile.
- Show a clear empty state with an authorised create form. Allow owner/admin/contributor users to create an offering and save a new immutable version. Disable mutations for viewers.
- A free-text offering brief may be stored truthfully as a draft specification (for example `summary`/`sourcePrompt`) but must not be presented as AI-enriched structured output unless a backend AI job actually produced it.
- Load current offerings, allow selection, render the selected current version, and give actionable field validation/errors.

### Results

- Proxy the list and all existing result actions to the workspace-scoped outreach endpoints.
- Preserve current tabs, counts, pagination, search and row actions. An empty backend result must render the existing useful empty state, never a route-contract error.

### Admin backend URL

- Add a Backend URL field to Admin/Settings. Show the managed default `KINDLING_API_URL` and allow owner/admin users to select `https://kindling-be.a.otherstuff.ai` without editing the Autopilot app registry. Contributors/viewers must not see an enabled admin control.
- Keep backend calls same-origin through `saas-server.ts`. Add `KINDLING_API_ALLOWED_URLS` (comma-separated HTTPS origins) and always include the default `KINDLING_API_URL`. The browser sends its chosen URL in a dedicated header; the server canonicalises it to an origin and rejects any value not in the trusted set before making a request. Reject credentials, paths, query strings, fragments, non-HTTPS production targets and arbitrary hosts. This is an SSRF boundary, not merely form validation.
- `/api/runtime-config` may expose the non-secret default and allowed origins. Never expose secrets or auth cookies.
- Persist the selection in bounded browser state scoped by authenticated workspace identity. Do not let a selection bleed between workspaces. The default still works before login. Workspace switch/logout must not activate another workspace's saved target.
- Ensure all proxied auth, company, value proposition, outreach and health requests use the selected trusted target consistently. Preserve backend `Set-Cookie`, CSRF, request ID and NIP-98 semantics.

## Validation

- Add adapter/server tests for every new proxy route and every backend-target rejection case, including an SSRF regression suite.
- Add UI tests for offering empty/load/create/version update and role gating; results empty/load/error/actions; settings default/select/persist/workspace isolation/role gating.
- Keep the IndexedDB cache bounded and tenant-scoped. Backend selection must be part of the query/cache namespace so two backends cannot share cached results.
- Run `bun run check`, `bun test`, `bun run build`, and deployment-contract validation.

## Git and reporting

Preserve concurrent changes. Do not reset, rebase, force-push, or discard unfamiliar work. Commit all nonignored tested state on `main` with Conventional Commits and push `origin/main`. Do not touch `deployed`, deploy CapRover, restart the local WApp or any managed service. Report the commit, files and exact tests to the supervising dispatch callback; do not post directly to Flight Deck.
