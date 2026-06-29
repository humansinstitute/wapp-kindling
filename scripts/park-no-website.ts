#!/usr/bin/env bun
// One-off backfill: park existing companies that have no website.
// Parking (data_ring = 'parked') keeps them out of the active pool, enrichment
// and scoring selectors while staying queryable so we can revisit them later.
// Skips anything already contacted / outreach-ready or with outreach drafts so
// we never disturb in-flight work. Reversible: set data_ring back to 'found'.
import { Database } from "bun:sqlite";

const DB_PATH = process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite";
const apply = process.argv.includes("--apply");
const db = new Database(DB_PATH);
const now = Date.now();

const WHERE = `
  COALESCE(TRIM(website), '') = ''
  AND data_ring NOT IN ('parked', 'contacted', 'outreach_ready')
  AND NOT EXISTS (SELECT 1 FROM outreach_drafts od WHERE od.company_id = companies.id)
`;

const candidates = db.query(`SELECT COUNT(*) AS c FROM companies WHERE ${WHERE}`).get() as { c: number };
console.log(`Companies with no website eligible for parking: ${candidates.c}`);

if (!apply) {
  console.log("Dry run. Re-run with --apply to park them.");
  process.exit(0);
}

const res = db.query(`
  UPDATE companies
  SET data_ring = 'parked',
      profile_json = json_set(COALESCE(NULLIF(profile_json, ''), '{}'), '$.parkedReason', 'no_website'),
      updated_at = ?1
  WHERE ${WHERE}
`).run(now);
console.log(`Parked ${res.changes} companies (data_ring = 'parked', parkedReason = 'no_website').`);
