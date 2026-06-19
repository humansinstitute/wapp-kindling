# Ticket: Migrate Kindling to Tower WApp DB

Date: 2026-06-19
Repo: `/Users/mini/code/wapp-kindling`

## Goal

Make Kindling the reference WApp for the Tower-backed WApp DB runtime.

Kindling currently stores application state in local SQLite through `src/db.ts` and `CHAT_WAPP_DB_PATH`. The platform slice now supports Tower-owned WApp DB namespaces, app registration, migrations, CRUD, and constrained query APIs. Kindling should be able to run as a Tower-backed WApp using the app identity and Tower binding injected by Autopilot, without receiving a Postgres URL and without Tower-specific Kindling code.

## References

- Tower WApp DB contract: `/Users/mini/code/wingmanbefree/wingman-tower/docs/API-Wap-Access.md`
- Autopilot runtime contract: `/Users/mini/code/wingmanbefree/autopilot/docs/wapp-tower-db-runtime.md`
- Kindling WApp instructions: `/Users/mini/code/wapp-kindling/AGENTS.md`

Relevant platform commits already present locally:

- Tower: `da4962c Implement Tower WApp DB API`
- Tower: `13d92f3 Harden WApp migration SQL sandbox`
- Autopilot: `ca5f361 Add WApp Tower runtime bindings`
- Autopilot: `036095c Prevent WApp app key replacement`
- Autopilot: `f98ecc3 Register Tower-backed WApp app npubs`
- Autopilot: `52cf8f6 Register Tower WApps before lifecycle actions`
- Autopilot: `9343852 Secure WApp PM2 runtime secret injection`

## Runtime Model

When Tower-backed mode is enabled, Kindling receives these env vars from Autopilot:

```txt
APP_ID=
APP_LABEL=
APP_NPUB=
APP_NSEC=
TOWER_URL=
WORKSPACE_OWNER_NPUB=
USER_ALIAS=
PORT=
```

Kindling should:

1. Provision its namespace with Tower:
   `POST /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/provision`
2. Run Kindling-owned migrations with app-signed NIP-98:
   `POST /api/v4/workspaces/:workspaceOwnerNpub/apps/:appNpub/db/migrations`
3. Read/write application tables through Tower generic table/query APIs.
4. Keep browser/user auth and Kindling domain APIs in Kindling.

Do not use direct Postgres URLs. Do not make agents or Autopilot bypass the Kindling API for normal app operations.

## Important Constraint

Tower v1 migration SQL is deliberately stricter than SQLite:

- No `CREATE TABLE ... AS SELECT`
- No `CREATE TABLE ... LIKE`
- No functions/triggers
- No cross-schema references
- Foreign key `REFERENCES` targets must be schema-qualified to the allocated app schema
- Migration SQL must avoid SQLite-specific syntax

Kindling's current startup schema in `src/db.ts` is SQLite-oriented. The worker should convert it into a Tower/Postgres migration set for Tower mode, while preserving local SQLite behavior for existing tests and local fallback.

## Suggested Implementation Shape

Prefer a small, explicit data-access boundary rather than an all-at-once rewrite hidden inside `src/server.ts`.

Likely files:

- `src/config.ts`
- `src/db.ts`
- `src/server.ts`
- `src/auth.ts`
- `src/auto-enrichment-job.ts`
- `src/tower-db.ts` or `src/db/tower-client.ts`
- `src/db/migrations/*.sql`
- `tests/kindling-api.test.ts`
- new focused Tower DB client tests
- `.env.example`
- `README.md`

Recommended steps:

1. Add runtime detection:
   - Tower mode is active only when `APP_NSEC`, `APP_NPUB`, `TOWER_URL`, and `WORKSPACE_OWNER_NPUB` are present, or when an explicit `KINDLING_DB_MODE=tower` is set.
   - SQLite remains the default for tests and direct developer runs.

2. Add a Tower WApp DB client:
   - Signs requests using `APP_NSEC` with NIP-98 kind `27235`.
   - Supports provision, migrations, table CRUD, table list/query, and descriptor/state calls needed by Kindling.
   - Centralizes URL construction and response error handling.
   - Never logs or serializes `APP_NSEC`.

3. Move Kindling schema to migrations:
   - Keep SQLite startup schema for local/test mode.
   - Add Tower/Postgres migration files for Kindling tables.
   - Convert SQLite syntax to Tower-safe Postgres DDL.
   - Make migrations idempotent and ordered.

4. Introduce a data access facade:
   - Avoid exposing `bun:sqlite` as the only application DB interface in Tower mode.
   - Start with the routes/workflows needed for smoke tests and the existing API tests.
   - Preserve current API response shapes.

5. Startup behavior:
   - In Tower mode, provision namespace and apply migrations before reporting readiness.
   - If Tower provisioning or migrations fail, expose a clear health/setup error and fail loudly enough for the WApp app-card lifecycle.
   - Do not silently fall back to SQLite when Tower mode was explicitly selected.

6. Tests:
   - Existing `bun test` should keep passing in SQLite mode.
   - Add focused tests for Tower client request signing/path/body behavior using fetch mocks.
   - Add a Tower-mode startup test with mocked provision/migration success/failure.
   - If practical, add a live smoke helper script for local Tower/Autopilot once processes are restarted.

## Acceptance Criteria

- Kindling can start in SQLite mode exactly as before; existing tests pass.
- Kindling can start in Tower mode with Autopilot-provided `APP_NSEC`, `APP_NPUB`, `TOWER_URL`, and `WORKSPACE_OWNER_NPUB`.
- Tower mode provisions the namespace and runs Kindling migrations through Tower's WApp DB API.
- Tower mode does not use `CHAT_WAPP_DB_PATH` as the authoritative application database.
- `APP_NSEC` is not logged, written to disk, or embedded in generated output.
- Kindling domain routes still own user/session/access logic; browser clients never call Tower DB directly.
- Focused Tower client/startup tests pass.
- `bun run check` and `bun test` pass, or any unrelated failures are clearly documented.
- Work is committed on `main`; include all nonignored tested state in the commit.

## Out Of Scope

- Do not change Tower or Autopilot in this repo.
- Do not restart live Kindling, Autopilot, or Tower from the worker unless explicitly instructed by Pete in the active conversation.
- Do not migrate production SQLite data into Tower unless the migration path is explicitly requested as a separate step. This ticket is code/runtime readiness first.
- Do not remove SQLite fallback in this pass.

## Validation Commands

```bash
bun run check
bun test
```

If a live smoke is added, document the exact command and required env vars, but do not run it against the live app-card process without explicit restart/test approval.
