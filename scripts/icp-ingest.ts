#!/usr/bin/env bun
// Phase 1: ingest the Adapt ICP "known good fit" list.
// - Ensures a dedicated target_segment exists for the cohort.
// - Inserts any CSV company not already in the DB (data_ring='found', not_started).
// - Links every matched + inserted company to the ICP segment via company_segments.
// Idempotent: re-running only fills gaps. Use --dry-run to preview.
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const csvPath = Bun.argv[2];
const dryRun = Bun.argv.includes("--dry-run");
if (!csvPath) { console.error("usage: bun scripts/icp-ingest.ts <csv> [--dry-run]"); process.exit(2); }

const db = new Database("data/chat-wapp.sqlite");
db.exec("PRAGMA foreign_keys = ON");

const SEGMENT_ID = "adapt-icp-known-good-fit";
const SEGMENT_LABEL = "Adapt ICP: known good-fit clients";
const SOURCE = "adapt_icp_list";

function norm(s: string) {
  return String(s || "").toLowerCase().replace(/[™®]/g, "").replace(/&/g, " and ")
    .replace(/\b(pty|ltd|limited|inc|llc|group|australia|wa|the|co|company|services|solutions|international|global)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const companies = db.query("SELECT id, name FROM companies").all() as any[];
const byNorm = new Map<string, any>();
for (const c of companies) { const k = norm(c.name); if (!byNorm.has(k)) byNorm.set(k, c); }

const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1).map(s => s.trim()).filter(Boolean);
const seen = new Set<string>();
const names: string[] = [];
for (const l of lines) { const k = norm(l); if (seen.has(k)) continue; seen.add(k); names.push(l); }

const toInsert: string[] = [];
const toLink: string[] = []; // company ids
for (const name of names) {
  const hit = byNorm.get(norm(name));
  if (hit) toLink.push(hit.id);
  else toInsert.push(name);
}

const now = Date.now();
const alreadyLinked = new Set((db.query("SELECT company_id FROM company_segments WHERE segment_id = ?1").all(SEGMENT_ID) as any[]).map(r => r.company_id));

console.log(JSON.stringify({
  uniqueNames: names.length,
  willInsert: toInsert.length,
  willLinkExisting: toLink.length,
  alreadyLinked: alreadyLinked.size,
}, null, 2));

if (dryRun) { console.log("\n-- would insert --"); for (const n of toInsert) console.log("  " + n); process.exit(0); }

db.exec("BEGIN IMMEDIATE");
try {
  // segment
  db.query(`INSERT INTO target_segments(id,parent_id,label,tier,priority,status,default_geo,default_target_count,default_batch_size,coverage_targets_json,scan_prompts_json,created_at,updated_at)
    VALUES (?1,NULL,?2,1,1,'active','Western Australia',0,21,'[]','[]',?3,?3)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at`).run(SEGMENT_ID, SEGMENT_LABEL, now);

  const insStmt = db.query(`INSERT INTO companies(id,name,location,industry,website,data_ring,duplicate_status,enrichment_status,confidence,profile_json,created_at,updated_at)
    VALUES (?1,?2,'','','','found','unique','not_started',0,'{}',?3,?3)`);
  const linkStmt = db.query(`INSERT INTO company_segments(company_id,segment_id,confidence,source,created_at)
    VALUES (?1,?2,1.0,?3,?4) ON CONFLICT(company_id,segment_id) DO UPDATE SET source=excluded.source`);

  const insertedIds: string[] = [];
  for (const name of toInsert) {
    const id = crypto.randomUUID();
    insStmt.run(id, name, now);
    insertedIds.push(id);
  }
  for (const id of [...toLink, ...insertedIds]) linkStmt.run(id, SEGMENT_ID, SOURCE, now);
  db.exec("COMMIT");
  console.log(JSON.stringify({ inserted: insertedIds.length, linked: toLink.length + insertedIds.length }, null, 2));
} catch (e) { db.exec("ROLLBACK"); throw e; }
