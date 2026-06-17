#!/usr/bin/env bash
# Catch-up scoring loop. Resolves the Kindling app's live port each cycle so
# callbacks keep working even if the platform reassigns the app port on restart.
cd /workspace/athena-kindling || exit 1
while true; do
  date -Iseconds
  pid=$(pgrep -f 'bun src/server.ts' | head -1)
  port=$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep -m1 '^PORT=' | cut -d= -f2)
  origin="http://localhost:${port:-43001}"
  echo "resolved kindling origin: ${origin}"
  bun scripts/start-scoring-catchup.ts \
    --limit 4 --concurrency 4 \
    --autopilot-url http://localhost:3600 \
    --origin "${origin}" || true
  sleep 600
done
