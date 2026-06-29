#!/usr/bin/env bash
# Drain the re-score queue: fire catch-up batches until no enriched company is
# missing an active-version assessment. Uses the corrected callback origin
# (:43000) to bypass the broken in-app loop origin (:3600).
set -u
cd /workspace/athena-kindling
LOG=data/rescore-loop.log
AUTOPILOT=http://localhost:3600
ORIGIN=http://localhost:43000
LIMIT=4
CONC=4
AGENT=claude
MODEL=claude-haiku-4-5-20251001
MAX_ITERS=400

remaining() {
  bun -e "
import {Database} from 'bun:sqlite';
const db=new Database('data/chat-wapp.sqlite',{readonly:true});
const v=String((db.query('SELECT current_version_id v FROM market_profiles ORDER BY created_at ASC LIMIT 1').get()).v);
const r=db.query(\"SELECT COUNT(*) c FROM companies c WHERE c.enrichment_status='complete' AND c.data_ring NOT IN ('parked','contacted') AND NOT EXISTS (SELECT 1 FROM service_fit_assessments s WHERE s.company_id=c.id AND s.market_profile_version_id=?1)\").get(v);
process.stdout.write(String(r.c));
"
}

echo \"[$(date -u +%H:%M:%S)] rescore loop start\" >> \"$LOG\"
for i in $(seq 1 $MAX_ITERS); do
  REM=$(remaining)
  SCORED=$(bun -e "import {Database} from 'bun:sqlite';const db=new Database('data/chat-wapp.sqlite',{readonly:true});const v=String((db.query('SELECT current_version_id v FROM market_profiles ORDER BY created_at ASC LIMIT 1').get()).v);process.stdout.write(String(db.query('SELECT COUNT(*) c FROM service_fit_assessments WHERE market_profile_version_id=?').get(v).c));")
  echo "[$(date -u +%H:%M:%S)] iter $i | scored=$SCORED | remaining=$REM" >> "$LOG"
  if [ "$REM" -le 0 ]; then echo "[$(date -u +%H:%M:%S)] DONE - queue drained" >> "$LOG"; break; fi
  # Self-heal: clear scoring runs orphaned by a WApp restart (stuck 'running'
  # >8min) and release their work_queue locks, so they stop capping fire slots.
  bun -e "
import {Database} from 'bun:sqlite';
const db=new Database('data/chat-wapp.sqlite');const now=Date.now();
const a=db.query(\"UPDATE kindling_pipeline_runs SET status='failed', error=COALESCE(NULLIF(error,''),'orphaned; reconciled by rescore loop'), updated_at=?1 WHERE role_key='score_company_service_fit' AND status='running' AND created_at<?2\").run(now, now-8*60000);
const b=db.query(\"UPDATE work_queue SET status='failed', locked_by_run_id='', updated_at=?1 WHERE kind='service_fit_assessment' AND status='running' AND (locked_by_run_id='' OR locked_by_run_id NOT IN (SELECT id FROM kindling_pipeline_runs WHERE status='running'))\").run(now);
if(a.changes||b.changes) console.log('reconciled orphans: runs='+a.changes+' locks='+b.changes);
" >> "$LOG" 2>&1
  bun scripts/start-scoring-catchup.ts --limit $LIMIT --concurrency $CONC \
    --agent "$AGENT" --model "$MODEL" \
    --autopilot-url "$AUTOPILOT" --origin "$ORIGIN" >> "$LOG" 2>&1
  sleep 75
done
echo "[$(date -u +%H:%M:%S)] rescore loop exit" >> "$LOG"
