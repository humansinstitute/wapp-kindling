#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const csvPath = Bun.argv[2];
const db = new Database("data/chat-wapp.sqlite");

function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[™®]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(pty|ltd|limited|inc|llc|group|australia|wa|the|co|company|services|solutions|international|global)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Build lookup of DB companies by normalized name
const companies = db.query("SELECT id, name, location, industry, website, data_ring, enrichment_status, confidence FROM companies").all() as any[];
const byNorm = new Map<string, any[]>();
for (const c of companies) {
  const k = norm(c.name);
  if (!byNorm.has(k)) byNorm.set(k, []);
  byNorm.get(k)!.push(c);
}

const srcCount = new Map<string, number>();
for (const r of db.query("SELECT company_id, COUNT(*) c FROM sources GROUP BY company_id").all() as any[]) srcCount.set(r.company_id, r.c);
const profCount = new Map<string, number>();
for (const r of db.query("SELECT company_id, COUNT(*) c FROM customer_profile_versions GROUP BY company_id").all() as any[]) profCount.set(r.company_id, r.c);
const scored = new Set<string>();
for (const r of db.query("SELECT DISTINCT company_id FROM service_fit_assessments").all() as any[]) scored.add(r.company_id);

const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).slice(1).map(s=>s.trim()).filter(Boolean);
const seen = new Set<string>();
const csvNames: string[] = [];
for (const l of lines) { const k = norm(l); if (seen.has(k)) continue; seen.add(k); csvNames.push(l); }

const matched: any[] = [];
const unmatched: string[] = [];
for (const name of csvNames) {
  const hits = byNorm.get(norm(name)) || [];
  if (hits.length) matched.push({ name, hits });
  else unmatched.push(name);
}

// enrichment quality buckets for matched
let complete=0, notStarted=0, failed=0, otherStatus=0, isScored=0;
const matchedDetail = matched.map(({name, hits}) => {
  const c = hits[0];
  const s = srcCount.get(c.id)||0, p = profCount.get(c.id)||0, sc = scored.has(c.id);
  if (c.enrichment_status==="complete") complete++; else if (c.enrichment_status==="not_started") notStarted++; else if (c.enrichment_status==="failed") failed++; else otherStatus++;
  if (sc) isScored++;
  return { name, dbName: c.name, id: c.id, ring: c.data_ring, status: c.enrichment_status, sources: s, profiles: p, scored: sc, dup: hits.length>1 };
});

console.log("=== ICP LIST MATCH SUMMARY ===");
console.log("CSV rows (raw):", lines.length, " unique:", csvNames.length);
console.log("Matched in DB:", matched.length, " Unmatched:", unmatched.length);
console.log("\n-- Matched enrichment status --");
console.log("complete:", complete, " not_started:", notStarted, " failed:", failed, " other:", otherStatus);
console.log("scored already:", isScored, " unscored (matched):", matched.length-isScored);
console.log("\n-- Matched but NOT enriched (complete) --");
const needEnrich = matchedDetail.filter(m=>m.status!=="complete");
console.log(needEnrich.length, "companies:");
for (const m of needEnrich) console.log(`  [${m.status}/${m.ring}] ${m.name}  ->  ${m.dbName}`);
console.log("\n-- Matched, complete, but NOT scored --");
const completeUnscored = matchedDetail.filter(m=>m.status==="complete" && !m.scored);
console.log(completeUnscored.length, "companies");
console.log("\n-- UNMATCHED (not in DB) --");
console.log(unmatched.length, "companies:");
for (const n of unmatched) console.log("  "+n);

// write json for downstream
Bun.write("data/icp-match-result.json", JSON.stringify({ matchedDetail, unmatched, csvNames }, null, 2));
console.log("\nWrote data/icp-match-result.json");
