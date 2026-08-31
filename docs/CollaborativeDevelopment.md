# Collaborative Kindling frontend development and deployment

## Operating model

Kindling API is the only authority for company identity and enrichment. Every
Kindling FE clone keeps its own SQLite workflow state (offer scoring, rankings,
notes, outreach, and run history) keyed by canonical company ID. Pete's local
frontend, Andy's local frontend, and the CapRover frontend all consume the same
public API; none is a second company authority.

Canonical API access is browser-mediated. The frontend server returns the exact
allowlisted API request, the signed-in user authorizes that URL with NIP-98, and
the server forwards the short-lived event. The server verifies the event's
signature, actor, URL, method, and age first. Private keys never leave the
browser signer and there is no frontend server signing-key environment.

## Runtime values

| Runtime | Source checkout / process | `KINDLING_API_URL` | `PORT` | SQLite |
| --- | --- | --- | --- | --- |
| Pete local | `/Users/mini/code/kindling-fe`; Autopilot app `Kindling FE` / `honest-ivory-thicket-app-kindling-fe` | `https://late-cup-crab.rick.runwingman.com` | Autopilot-assigned `41039` | Machine-local path injected by the app card |
| Andy local | Andy's own clone and separately registered Autopilot app card | `https://late-cup-crab.rick.runwingman.com` | A distinct Autopilot-assigned port | Andy-machine-local path injected by his app card |
| CapRover | reviewed `deployed` commit | `https://late-cup-crab.rick.runwingman.com` | `80` inside the container | `/data/kindling-fe.sqlite` on a persistent volume |

All three use `KINDLING_COMPANY_SOURCE=canonical-api` and normally
`KINDLING_CACHE_MAX_AGE_MS=900000`. Set `CHAT_WAPP_PUBLIC_ORIGIN` to each app
card's public URL or the CapRover HTTPS URL. Configure frontend owner/allowed
npubs and webhook secrets in that runtime, not in Git. Do not configure a raw
canonical API signing key.

The current Pete app-card identity and health commands remain in `AGENTS.md`.
Andy must clone the repository on his Wingman and register a new Autopilot app
card that points to his clone. App IDs, aliases, assigned ports, local SQLite,
and app-card credentials are machine-specific and must not be copied from Pete.

## Canonical API client contract

The frontend forwards only these NIP-98 signed reads to the runtime
`KINDLING_API_URL`:

```text
GET /api/v1/bootstrap
GET /api/v1/targets?limit=499[&cursor=<opaque>]
GET /api/v1/targets/changes?since=<cursor>&limit=499&include=summary
GET /api/v1/targets/:companyId
```

Forwarded headers are exactly:

```text
accept: application/json
authorization: Nostr <base64-json-kind-27235-event>
```

Kindling API must grant `read` to Pete's, Andy's, and each approved agent's own
npub through `WAPP_ALLOWED_NPUBS_JSON` or an `access_rules` row. The API must not
grant consumers its Tower app identity, database credentials, or private key.
An API `401`/`403` is surfaced as authorization denied and is recoverable by
fixing the actor's read grant and choosing **Authorize API sync** again.

Operational observation (2026-08-31): the configured public API origin returned
`404 app_not_running` with managed app status `idle`. Rick must restore that API
through its normal app-card lifecycle before frontend sync or the CapRover smoke
can become live-current; frontend operators must not bypass the managed runtime.

No backend CORS change is required for this implementation: browsers call the
same-origin Kindling FE coordinator and the FE server performs the restricted
forward. If the design later moves to direct cross-origin browser fetches, the
API must add explicit CORS for each Pete/Andy/CapRover HTTPS origin, allow
`GET, OPTIONS`, allow the `Authorization` header, and avoid wildcard origins or
cookie credentials. That is a reviewed backend contract change, not a frontend
workaround.

## Cache and health contract

Sync is explicit; page loads never attempt hidden server-signed synchronization.
Bootstrap stores the API cursor only after every snapshot page is applied.
Incremental sync commits each change page before advancing the cursor. Failed
or denied sync leaves cached records readable and labelled stale.

`GET /api/health` always reports process health separately from data readiness:

- `ok` / `ready`: the frontend process can serve requests;
- `dataReady`: local mode or at least one cached canonical company exists;
- `liveCurrent`: API reachable, latest NIP-98 authorization accepted, and the
  completed cache sync is within `KINDLING_CACHE_MAX_AGE_MS`;
- `canonicalApi.apiReachable`, `syncAuthorized`, `cacheState`, `lastSyncAt`,
  `cachedCompanies`, `syncCursor`, and `lastError`: dependency detail without
  a credential or signed event.

CapRover should health-check `/api/health` for process readiness and alert on
`liveCurrent=false`; it should not restart a healthy frontend merely because
the upstream API is temporarily offline or awaits a user signature.

## Collaborative branch workflow

1. Clone the repository independently on each Wingman; never share a working
   tree or runtime SQLite file.
2. Register one Autopilot app card per machine and keep its app ID, alias, port,
   public URL, and local data path local to that machine.
3. Start new work from the reviewed `main` with
   `feature/<person>-<topic>` (for example `feature/andy-company-filter`). The
   current `feat/collaborative-kindling-frontend` name is the explicitly
   requested integration-preparation branch.
4. Before handoff run `bun run validate`, `bun test`, and the Docker build/smoke
   commands below. Report any full-suite baseline failures exactly.
5. Push only the feature branch when a reviewer authorizes pushing. An
   integration agent reviews the diff and validation, then merges deliberately
   into `main`.
6. `deployed` fast-forwards from reviewed `main` only. Never merge feature
   branches directly into `deployed` and never create merge commits on it.
7. Never force-push, reset shared history, commit `.env`/SQLite/secrets, or copy
   another Wingman's app identity.
8. After Rick deploys, smoke-check the CapRover HTTPS `/api/health`, sign in,
   authorize canonical sync, confirm `liveCurrent=true`, and open a canonical
   company without exposing a signing value in health, logs, or browser assets.

## Branch divergence and integration

This feature branch was created from local `adp` at `df4dae3`, three commits
ahead of `origin/adp` at `bed30fc`. At branch creation, `origin/main` and
`df4dae3` shared merge base `cb72ea99c7dce28d9642141be55ad5316ecf2830` but
had 19 main-only and 42 adp-only commits. `main` therefore cannot be updated by
a feature fast-forward.

The remote currently advertises `main` and `adp` but no `deployed` branch. Rick
must create/configure `deployed` only after the reviewed `main` integration;
from then on it remains a fast-forward deployment pointer to `main`, never a
feature integration branch.

The integration agent should start from current `main`, fetch both sides, and
perform a deliberate non-rebase merge of this feature branch with `--no-commit`
first. Review Tower-mode/main changes against the canonical-adapter line,
resolve conflicts by contract rather than choosing one whole side, rerun all
validation, then create the merge commit. Do not reset, rebase, or force either
history. See [IntegrationAgentChecklist.md](IntegrationAgentChecklist.md).

## Deterministic validation and Docker smoke

Scoped validation:

```bash
bun run validate
```

Full inherited suite:

```bash
bun test
```

The inherited starting baseline is 81 pass / 3 deterministic pre-existing
failures. This branch adds two passing health/coordinator tests, so its full run
is 83 pass / 3 fail. The failures are: service-offering fixture expects
`custom_wapps`, top-target caveat ordering differs, and coverage fixture
scored/processed counts differ. They are outside the canonical auth/deployment
scope and must be reported until corrected on their owning line; the focused
canonical suite is part of `bun run validate`.

Build and smoke without touching the live WApp card:

```bash
docker build -t kindling-fe:collaborative .
docker run --rm -d --name kindling-fe-collaborative-smoke \
  -p 127.0.0.1:43179:80 \
  -e KINDLING_API_URL=https://late-cup-crab.rick.runwingman.com \
  -e KINDLING_COMPANY_SOURCE=canonical-api \
  -e CHAT_WAPP_DB_PATH=/data/kindling-fe.sqlite \
  kindling-fe:collaborative
curl -fsS http://127.0.0.1:43179/api/health
docker stop kindling-fe-collaborative-smoke
```

Use another isolated host port if `43179` is occupied. This container smoke is
not the live app-card process and must never bind the WApp-owned port `41039`.
For CapRover use one instance and a persistent `/data` mapping; local databases,
WAL/SHM files, `.env`, Git metadata, dependencies, logs, and MCP config are
excluded from the Docker context.
