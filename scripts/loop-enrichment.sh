#!/usr/bin/env bash
# Catch-up enrichment loop. Each tick starts the next industry-segment batch
# (up to 21 companies/run); the underlying job skips if a batch is already
# running, so this stays at one batch at a time. Resolves the Kindling app's
# live port each cycle so callbacks keep working across restarts.
cd /workspace/athena-kindling || exit 1
while true; do
  date -Iseconds
  pid=$(pgrep -f 'bun src/server.ts' | head -1)
  port=$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep -m1 '^PORT=' | cut -d= -f2)
  origin="http://localhost:${port:-43001}"
  echo "resolved kindling origin: ${origin}"
  bun scripts/run-auto-enrichment.ts \
    --autopilot-url http://localhost:3600 \
    --origin "${origin}" || true
  sleep 1800
done
