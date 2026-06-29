/**
 * Prune historical bloat from the Kindling SQLite DB and reclaim free space.
 *
 * Three sources dominate the file (see `why is the deck slow` investigation):
 *   - kindling_pipeline_runs.trigger_payload_json / result_payload_json
 *   - work_queue.context_json
 *   - superseded target_list_runs + their target_list_items
 * On top of that, deleted rows leave free pages behind until a VACUUM rewrites
 * the file — at last check ~72% of the 1.6 GB file was free space.
 *
 * Safe by default: prints what it WOULD delete and exits. Pass --apply to
 * actually delete + VACUUM. Run with the app stopped (VACUUM takes an exclusive
 * lock and needs ~live-size free disk).
 *
 *   bun scripts/prune-history.ts                 # dry run, 30-day retention
 *   bun scripts/prune-history.ts --days 14       # dry run, 14-day retention
 *   bun scripts/prune-history.ts --apply         # delete + VACUUM
 *   bun scripts/prune-history.ts --apply --no-vacuum
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "../src/config.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const skipVacuum = args.includes("--no-vacuum");
const daysIdx = args.indexOf("--days");
const RETENTION_DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 30;
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

const db = new Database(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

function fileGB() {
  const ps = (db.query("PRAGMA page_size").get() as any).page_size;
  const pc = (db.query("PRAGMA page_count").get() as any).page_count;
  const fl = (db.query("PRAGMA freelist_count").get() as any).freelist_count;
  return {
    file: (ps * pc) / 1073741824,
    free: (ps * fl) / 1073741824,
  };
}

function count(sql: string, ...p: any[]) {
  return Number((db.query(sql).get(...p) as any)?.n ?? 0);
}

// Always keep the most recent COMPLETE target-list run (the deck reads it),
// regardless of age, plus any run created inside the retention window.
const keepRunId =
  (db.query(
    `SELECT id FROM target_list_runs WHERE status='complete'
     ORDER BY completed_at DESC, created_at DESC, rowid DESC LIMIT 1`,
  ).get() as any)?.id ?? "";

const targets = {
  pipelineRuns: {
    label: "kindling_pipeline_runs (terminal, older than cutoff)",
    where: `status IN ('ok','failed','complete','partial','partial_failed') AND created_at < ?1`,
    table: "kindling_pipeline_runs",
  },
  workQueue: {
    label: "work_queue (terminal, older than cutoff)",
    where: `status IN ('complete','failed') AND created_at < ?1`,
    table: "work_queue",
  },
  listRuns: {
    label: "target_list_runs (superseded, older than cutoff)",
    where: `created_at < ?1 AND id <> ?2`,
    table: "target_list_runs",
  },
};

console.log(`DB: ${DB_PATH}`);
const before = fileGB();
console.log(`Size: ${before.file.toFixed(2)} GB  (free ${before.free.toFixed(2)} GB)`);
console.log(`Retention: ${RETENTION_DAYS} days (cutoff ${new Date(cutoff).toISOString()})`);
console.log(`Keeping latest complete run: ${keepRunId || "(none)"}\n`);

const nPipeline = count(`SELECT COUNT(*) n FROM kindling_pipeline_runs WHERE ${targets.pipelineRuns.where}`, cutoff);
const nWork = count(`SELECT COUNT(*) n FROM work_queue WHERE ${targets.workQueue.where}`, cutoff);
const nListRuns = count(`SELECT COUNT(*) n FROM target_list_runs WHERE ${targets.listRuns.where}`, cutoff, keepRunId);
const nListItems = count(
  `SELECT COUNT(*) n FROM target_list_items WHERE target_list_run_id IN
     (SELECT id FROM target_list_runs WHERE ${targets.listRuns.where})`,
  cutoff,
  keepRunId,
);

console.log(`Would delete:`);
console.log(`  ${String(nPipeline).padStart(7)}  ${targets.pipelineRuns.label}`);
console.log(`  ${String(nWork).padStart(7)}  ${targets.workQueue.label}`);
console.log(`  ${String(nListRuns).padStart(7)}  ${targets.listRuns.label}`);
console.log(`  ${String(nListItems).padStart(7)}  target_list_items (belonging to those runs)`);

if (!apply) {
  console.log(`\nDry run. Re-run with --apply to delete and reclaim space.`);
  process.exit(0);
}

console.log(`\nApplying...`);
const tx = db.transaction(() => {
  db.query(`DELETE FROM target_list_items WHERE target_list_run_id IN
     (SELECT id FROM target_list_runs WHERE ${targets.listRuns.where})`).run(cutoff, keepRunId);
  db.query(`DELETE FROM target_list_runs WHERE ${targets.listRuns.where}`).run(cutoff, keepRunId);
  db.query(`DELETE FROM kindling_pipeline_runs WHERE ${targets.pipelineRuns.where}`).run(cutoff);
  db.query(`DELETE FROM work_queue WHERE ${targets.workQueue.where}`).run(cutoff);
});
tx();
console.log(`Rows deleted.`);

if (!skipVacuum) {
  console.log(`Checkpointing WAL + VACUUM (this can take a while)...`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
}

const after = fileGB();
console.log(`\nDone. Size: ${before.file.toFixed(2)} GB -> ${after.file.toFixed(2)} GB`);
