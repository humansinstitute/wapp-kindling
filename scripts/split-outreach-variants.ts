// One-off backfill: split legacy single-blob outreach_drafts rows (one markdown
// containing several options) into one row per variant, tagged with
// variant_index / variant_label. Idempotent: only touches rows where
// variant_index IS NULL. Backs up the whole table first.
//
// Usage: bun scripts/split-outreach-variants.ts
import { Database } from "bun:sqlite";
import { splitPitchVariants } from "../src/outreach-variants.ts";

const DB_PATH = process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite";
const db = new Database(DB_PATH);
const now = Date.now();

// Ensure the new columns exist even if the app hasn't been restarted since the
// schema change (the running server may predate the db.ts migration).
for (const sql of [
  "ALTER TABLE outreach_drafts ADD COLUMN variant_index INTEGER",
  "ALTER TABLE outreach_drafts ADD COLUMN variant_label TEXT",
]) {
  try { db.query(sql).run(); } catch { /* already exists */ }
}

// Backup the full table before mutating.
const allRows = db.query("SELECT * FROM outreach_drafts").all() as Record<string, unknown>[];
const stamp = new Date(now).toISOString().replace(/[:.]/g, "").slice(0, 15);
await Bun.write(`data/outreach-drafts-backup-${stamp}.json`, JSON.stringify(allRows, null, 2));
console.log(`Backed up ${allRows.length} outreach_drafts rows to data/outreach-drafts-backup-${stamp}.json\n`);

const pending = db.query("SELECT * FROM outreach_drafts WHERE variant_index IS NULL").all() as Record<string, unknown>[];
console.log(`${pending.length} rows to process.\n`);

const insert = db.query(`
  INSERT INTO outreach_drafts(id, company_id, pitch_text, status, source_run_id, variant_index, variant_label, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
`);
const setSingle = db.query("UPDATE outreach_drafts SET variant_index = 0, variant_label = ?2, pitch_text = ?3 WHERE id = ?1");
const del = db.query("DELETE FROM outreach_drafts WHERE id = ?1");

let split = 0, single = 0, newRows = 0;
const run = db.transaction(() => {
  for (const row of pending) {
    const variants = splitPitchVariants(String(row.pitch_text ?? ""));
    if (variants.length <= 1) {
      const v = variants[0];
      setSingle.run(String(row.id), v.label, v.body);
      single++;
      continue;
    }
    del.run(String(row.id));
    for (const v of variants) {
      insert.run(
        crypto.randomUUID(), String(row.company_id), v.body, String(row.status ?? "draft"),
        row.source_run_id == null ? null : String(row.source_run_id),
        v.index, v.label,
        Number(row.created_at ?? now), Number(row.updated_at ?? now),
      );
      newRows++;
    }
    split++;
  }
});
run();

console.log(`Split ${split} multi-option rows into ${newRows} variant rows.`);
console.log(`Tagged ${single} single-option rows in place.`);
console.log(`Total outreach_drafts rows now: ${(db.query("SELECT COUNT(*) c FROM outreach_drafts").get() as any).c}`);
db.close();
