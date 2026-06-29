// Replace the top-25 companies' outreach drafts with newly written, value-first
// variants (see docs/outreach-voice-guide.md). Each company's existing drafts
// are backed up then deleted, and three new variant rows are inserted (one per
// option), grouped under a fresh source_run_id. Non-destructive to other data.
//
// Usage: bun scripts/apply-outreach-rewrite.ts [results.json]
import { Database } from "bun:sqlite";

const DB_PATH = process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite";
const RESULTS_PATH = process.argv[2] || "/tmp/outreach/results.json";
const db = new Database(DB_PATH);
const now = Date.now();
const results = JSON.parse(await Bun.file(RESULTS_PATH).text()) as any[];

// Make sure the variant columns exist (in case the app hasn't restarted).
for (const sql of [
  "ALTER TABLE outreach_drafts ADD COLUMN variant_index INTEGER",
  "ALTER TABLE outreach_drafts ADD COLUMN variant_label TEXT",
]) {
  try { db.query(sql).run(); } catch { /* already exists */ }
}

// Decode the handful of HTML entities that can sneak into transcribed copy.
function decodeEntities(s: string): string {
  return String(s ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

// Back up every existing draft for the affected companies before deleting.
const companyIds = results.map((r) => String(r.companyId));
const backupRows: any[] = [];
const selExisting = db.query("SELECT * FROM outreach_drafts WHERE company_id = ?1");
for (const id of companyIds) backupRows.push(...(selExisting.all(id) as any[]));
const stamp = new Date(now).toISOString().replace(/[:.]/g, "").slice(0, 15);
await Bun.write(`data/outreach-rewrite-backup-${stamp}.json`, JSON.stringify(backupRows, null, 2));
console.log(`Backed up ${backupRows.length} existing drafts across ${companyIds.length} companies to data/outreach-rewrite-backup-${stamp}.json\n`);

const del = db.query("DELETE FROM outreach_drafts WHERE company_id = ?1");
const insert = db.query(`
  INSERT INTO outreach_drafts(id, company_id, pitch_text, status, source_run_id, variant_index, variant_label, created_at, updated_at)
  VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?7)
`);
const insertActivity = db.query(`
  INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
  VALUES (?1, 'company', ?2, 'user:outreach-rewrite', 'outreach_drafted', ?3, ?4, ?5)
`);

let companies = 0, rows = 0;
const run = db.transaction(() => {
  for (const r of results) {
    const companyId = String(r.companyId);
    const variants = Array.isArray(r.variants) ? r.variants : [];
    if (!variants.length) { console.log(`!! ${r.company}: no variants, skipped`); continue; }
    del.run(companyId);
    const runId = crypto.randomUUID();
    variants.forEach((v: any, index: number) => {
      const label = decodeEntities(v.label || `Option ${index + 1}`);
      const subject = decodeEntities(v.subject || "");
      const body = decodeEntities(v.body || "");
      const pitch = subject ? `**Subject:** ${subject}\n\n${body}` : body;
      insert.run(crypto.randomUUID(), companyId, pitch, runId, index, label, now);
      rows++;
    });
    insertActivity.run(
      crypto.randomUUID(), companyId,
      `Rewrote outreach: ${variants.length} value-first variants (free-diagnostic led)`,
      JSON.stringify({ variantCount: variants.length, sourceRunId: runId, guide: "docs/outreach-voice-guide.md" }),
      now,
    );
    companies++;
    console.log(`${String(r.company).padEnd(34)} ${variants.length} variants`);
  }
});
run();

console.log(`\nRewrote ${companies} companies, ${rows} variant rows.`);
db.close();
