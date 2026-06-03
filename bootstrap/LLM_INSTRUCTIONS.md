# Kindling Bootstrap Instructions

You are setting up the Kindling WApp on a Wingman server.

## Goal

Install the WApp source, install the bundled Kindling pipeline definitions/functions into the target Wingman pipeline user namespace, restore the SQLite data artifact if one was provided, and verify that target scans start real Autopilot runs. Do not create mock or fallback company records.

## Source Layout

- `app source`: repository root
- `pipeline definitions`: `bootstrap/pipelines/definitions/kindling-*.json`
- `pipeline functions`: `bootstrap/pipelines/functions/kindling-*.ts`
- `SQLite data`: supplied separately as `chat-wapp.sqlite`; it is not committed to git

## Install Steps

1. Copy or clone this repository to the target machine, for example `~/code/wapp-kindling`.
2. Run:

   ```bash
   cd ~/code/wapp-kindling
   bun install
   cp .env.example .env
   ```

3. Set `.env` for the target server. At minimum:

   ```bash
   WINGMAN_URL=https://<autopilot-public-host>
   CHAT_WAPP_PUBLIC_ORIGIN=https://<kindling-public-host>
   WAPP_OWNER_NPUB=<owner-npub>
   ```

4. Install pipelines into the target user's pipeline namespace:

   ```bash
   TARGET_PIPELINE_ROOT="$HOME/.wingmen/pipelines/users/<target-user-alias>"
   mkdir -p "$TARGET_PIPELINE_ROOT/definitions" "$TARGET_PIPELINE_ROOT/functions"
   cp bootstrap/pipelines/definitions/kindling-* "$TARGET_PIPELINE_ROOT/definitions/"
   cp bootstrap/pipelines/functions/kindling-* "$TARGET_PIPELINE_ROOT/functions/"
   ```

5. Restore data if provided:

   ```bash
   mkdir -p data
   cp /path/to/chat-wapp.sqlite data/chat-wapp.sqlite
   sqlite3 data/chat-wapp.sqlite 'PRAGMA integrity_check;'
   ```

6. Validate locally:

   ```bash
   bun test
   bun run check
   ```

7. Register/start the WApp through the target Wingman app registry. The app start script must honor `PORT`.

8. Open Kindling Settings and set `Autopilot URL` to the target public Autopilot base URL. The app uses this URL exactly. It does not use bearer trigger tokens or remap public URLs to local addresses.

## Verification

Check the saved Autopilot URL:

```bash
sqlite3 data/chat-wapp.sqlite "SELECT key, value FROM app_settings WHERE key='autopilotUrl';"
```

Check recent run trigger URLs and status:

```bash
sqlite3 data/chat-wapp.sqlite \
  "SELECT status, autopilot_run_id, json_extract(trigger_payload_json,'$.url') AS trigger_url, error FROM kindling_pipeline_runs ORDER BY created_at DESC LIMIT 10;"
```

Expected behavior:

- real runs have real Autopilot run ids;
- failed starts are marked `failed` with an error;
- there should be no new `mock-*` run ids;
- target scans must not insert synthetic fallback companies.

## Notes

The database contains business data and should be migrated as a private artifact, not committed to public git history.
