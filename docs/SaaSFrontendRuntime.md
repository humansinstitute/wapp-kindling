# SaaS frontend runtime and API contract

Kindling FE calls `kindling-be` through same-origin routes. Set these at container runtime:

```text
KINDLING_API_URL=https://kindling-be.example
KINDLING_API_VERSION=v1
KINDLING_SCHEMA_VERSION=1
KINDLING_API_COMPATIBILITY=auto
BUILD_VERSION=<image-or-git-version>
PORT=80
```

`KINDLING_API_COMPATIBILITY=auto` first uses the documented workspace routes and falls back on 404/405 to the current target routes:

```text
POST   /api/v1/auth/challenge
POST   /api/v1/auth/session
DELETE /api/v1/auth/session
GET    /api/v1/me
GET    /api/v1/workspaces/:workspaceId/companies
GET    /api/v1/workspaces/:workspaceId/companies/:companyId
POST   /api/v1/workspaces/:workspaceId/companies
PATCH  /api/v1/workspaces/:workspaceId/companies/:companyId
GET    /api/v1/workspaces/:workspaceId/target-lists
GET    /api/v1/workspaces/:workspaceId/value-propositions
GET    /api/v1/workspaces/:workspaceId/assessment-campaigns
GET    /api/v1/workspaces/:workspaceId/signals

GET    /api/v1/targets
GET    /api/v1/targets/:companyId
POST   /api/v1/targets
PATCH  /api/v1/targets/:companyId
```

List responses may use `companies`, `targets`, or `items`, plus `total`/`count`, `limit`, `offset`, `cursor`, `next_cursor`, `schema_version`, and optional `band_counts`. Company identity accepts documented snake_case fields and current target camelCase fields. The adapter returns the existing UI shape and preserves raw canonical data under `canonical`.

The backend should return an HTTP-only, Secure, same-site session cookie from `POST /api/v1/auth/session`. It must enforce membership on every request and return 401/403 immediately after logout, role loss or membership revocation. FE forwards `Cookie`, `Set-Cookie`, CSRF, ETag and request ID headers; it does not hold a signing key or backend secret.

`GET /healthz` is the backend reachability check used by frontend `/api/health`. Frontend health reports build, non-secret API origin/version/schema, reachability, and `serverPersistenceRequired: false`; it does not report replica rows or sync cursors.

The production container runs `src/saas-server.ts`, honours `PORT`, uses `/api/health` for its Docker health check, has no SQLite/Tower import, has no `/data` volume and needs no persistent filesystem. Do not deploy this branch independently of the matching backend session and company contracts.
