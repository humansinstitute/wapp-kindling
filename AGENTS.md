# Kindling FE Agent Instructions

## Kindling FE Is A WApp

Kindling FE must be operated as a Wingman WApp. Do not start or restart it as a direct ad hoc development server during normal operations.

Use the WApp runtime path owned by Wingman/Autopilot so app networking, assigned ports, public URLs, redirects, NIP-98 context, and app-card routing stay coherent. The live WApp is the Autopilot app-card process.

Local Kindling FE WApp identity:

- App label: `Kindling FE`
- App ID: `19a94999-012a-4c19-a80c-9367da344674`
- User alias: `honest-ivory-thicket`
- Autopilot PM2 process name: `honest-ivory-thicket-app-kindling-fe`
- Assigned WApp port: `41039`
- Public URL: `https://keen-rye-stem.rick.runwingman.com`
- Canonical API URL: `https://late-cup-crab.rick.runwingman.com`

For local operational starts/restarts, use the Autopilot app card or Autopilot app lifecycle path for app ID `19a94999-012a-4c19-a80c-9367da344674`. If operating from the terminal, use `appctl`; do not bypass it with a raw server command.

```bash
cd /Users/mini/code/wingmanbefree/autopilot
bun clis/appctl.ts status 19a94999-012a-4c19-a80c-9367da344674 --url "${WINGMAN_URL:-http://localhost:3256}"
bun clis/appctl.ts start 19a94999-012a-4c19-a80c-9367da344674 --url "${WINGMAN_URL:-http://localhost:3256}"
```

Verify it through the WApp-owned process and environment, not by creating a second raw process:

```bash
pm2 status | rg 'honest-ivory-thicket-app-kindling-fe|wm-ap'
pm2 jlist | jq -r '.[] | select(.name=="honest-ivory-thicket-app-kindling-fe")'
lsof -nP -iTCP:41039 -sTCP:LISTEN
curl -fsS http://127.0.0.1:41039/api/health
curl -fsS https://keen-rye-stem.rick.runwingman.com/api/health
```

Do not run these for normal operations:

```bash
bun src/server.ts
PORT=41039 bun src/server.ts
pm2 start src/server.ts --name kindling-fe
```

A direct `bun src/server.ts` run is acceptable only for isolated local development/debugging on a non-WApp port, and it must not pretend to be the live app-card runtime.

Kindling API `/api/v1` is the authority for company identity and enrichment facts. Kindling FE uses its own app-card-injected `WAPP_NSEC` to sign NIP-98 requests. Never copy Kindling API's `WAPP_NSEC` into this app. Local workflow state remains keyed by canonical company ID.

When checking health, prefer:

- the WApp card/public URL;
- PM2 process `honest-ivory-thicket-app-kindling-fe`;
- authenticated `appctl status`;
- `/api/health`, which reports the non-secret API base URL, company source, sync cursor, cache state, and signer readiness;
- Autopilot-managed app logs.

Do not restart Autopilot, Kindling API, the older Kindling app, or unrelated registered apps while operating Kindling FE unless a task explicitly requires it.
