#!/usr/bin/env bun
// Approach 1 re-score prep: back up + delete the STALE service-fit assessments
// that were computed against the previous Adapt offering text (same active
// version, edited in place), and reset those companies so the catch-up scorer
// re-picks them. Keeps any assessments created during the current re-score
// (created_at >= cutoff) so the validation pilot isn't wiped.
import { Database } from "bun:sqlite";

const DB_PATH = process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite";
const apply = process.argv.includes("--apply");
// Stale = older than 10 minutes ago. Last real stale score was 08:04; the
// validation pilot is minutes old, so this cleanly separates them.
const cutoff = Date.now() - 10 * 60 * 1000;
const db = new Database(DB_PATH);
db.run("PRAGMA foreign_keys = ON");

const ACTIVE = String(
  (db.query("SELECT current_version_id v FROM market_profiles ORDER BY created_at ASC LIMIT 1").get() as any)?.v ?? "",
);
if (!ACTIVE) throw new Error("no active market profile version");

const stale = db.query(
  "SELECT id, company_id FROM service_fit_assessments WHERE market_profile_version_id = ?1 AND created_at < ?2",
).all(ACTIVE, cutoff) as Array<{ id: string; company_id: string }>;
const staleCompanies = [...new Set(stale.map((r) => r.company_id))];

const resettable = db.query(
  `SELECT COUNT(*) c FROM companies WHERE id IN (${staleCompanies.map(() => "?").join(",") || "''"})
     AND data_ring = 'scored'`,
).get(...staleCompanies) as any;

console.log("active version:", ACTIVE);
console.log("cutoff:", new Date(cutoff).toISOString());
console.log("stale assessment rows:", stale.length, "| distinct companies:", staleCompanies.length);
console.log("companies that will reset 'scored'->'enhanced':", resettable.c, "(parked/contacted left as-is)");

if (!apply) {
  console.log("\nDry run. Re-run with --apply to back up, delete, and reset.");
  process.exit(0);
}

const ts = new Date(cutoff).toISOString().replace(/[:.]/g, "-");
const backup = db.query(
  "SELECT * FROM service_fit_assessments WHERE market_profile_version_id = ?1 AND created_at < ?2",
).all(ACTIVE, cutoff);
const backupPath = `data/rescore-backup-${ts}.json`;
require("fs").writeFileSync(backupPath, JSON.stringify({ activeVersion: ACTIVE, cutoff, assessments: backup }, null, 2));
console.log("backed up", backup.length, "assessments ->", backupPath);

const tx = db.transaction(() => {
  const now = Date.now();
  // Remove target-list items referencing the stale assessments, then the rows.
  const delItems = db.query(
    "DELETE FROM target_list_items WHERE service_fit_assessment_id IN (SELECT id FROM service_fit_assessments WHERE market_profile_version_id = ?1 AND created_at < ?2)",
  ).run(ACTIVE, cutoff);
  const delAsmt = db.query(
    "DELETE FROM service_fit_assessments WHERE market_profile_version_id = ?1 AND created_at < ?2",
  ).run(ACTIVE, cutoff);
  const reset = db.query(
    `UPDATE companies SET data_ring = 'enhanced', updated_at = ?1
       WHERE id IN (${staleCompanies.map(() => "?").join(",")}) AND data_ring = 'scored'`,
  ).run(now, ...staleCompanies);
  return { items: delItems.changes, asmt: delAsmt.changes, reset: reset.changes };
});
const res = tx();
console.log(`deleted ${res.asmt} stale assessments (+${res.items} target-list items); reset ${res.reset} companies to 'enhanced'.`);
console.log("DONE");
