# Kindling Agent Instructions

## Kindling Is A WApp

Kindling must be operated as a Wingman WApp. Do not start or restart Kindling as a direct ad hoc development server during normal operations.

Use the WApp runtime path owned by Wingman/Autopilot so app networking, assigned ports, public URLs, redirects, NIP-98 context, and app-card routing stay coherent. The live WApp is the Autopilot app-card process, not a LaunchAgent fallback.

Local Kindling WApp identity:

- App label: `Kindling`
- App ID: `c8dc3b14-6869-444f-94c3-37ccb2348cc9`
- User alias: `honest-ivory-thicket`
- Autopilot PM2 process name: `honest-ivory-thicket-app-kindling`
- Assigned WApp port: `41004`

For local operational starts/restarts, use the Autopilot app card or Autopilot app lifecycle path for app ID `c8dc3b14-6869-444f-94c3-37ccb2348cc9`. If operating from the terminal, call Autopilot's app process manager or authenticated app lifecycle API; do not bypass it with a raw server command.

```bash
cd /Users/mini/code/wingmanbefree/autopilot
bun -e 'import { appProcessManager } from "./src/apps/app-process-manager.ts"; console.log(await appProcessManager.start("c8dc3b14-6869-444f-94c3-37ccb2348cc9"));'
```

Verify it through the WApp-owned process and environment, not by creating a second raw process:

```bash
pm2 status | rg 'honest-ivory-thicket-app-kindling|wm-ap'
pm2 jlist | jq -r '.[] | select(.name=="honest-ivory-thicket-app-kindling")'
lsof -nP -iTCP:41004 -sTCP:LISTEN
```

Do not run these for normal operations:

```bash
bun src/server.ts
PORT=41033 bun src/server.ts
pm2 start src/server.ts --name kindling
launchctl kickstart -k gui/$(id -u)/com.wingman.kindling-wapp
```

A direct `bun src/server.ts` run is only acceptable for isolated local development/debugging, and only when it uses a non-WApp port and is not pretending to be the live app-card runtime.

When checking health, prefer:

- the WApp card/app URL assigned by Wingman;
- PM2 process `honest-ivory-thicket-app-kindling`;
- Autopilot app registry entry in `/Users/mini/code/wingmanbefree/autopilot/data/apps.json`;
- app logs under Autopilot-managed app logs;
- Autopilot/WApp registry state where applicable.

Autopilot itself may still be restarted with PM2 when needed:

```bash
pm2 restart wm-ap --update-env
```
