// Selection step for the hourly outreach-rewrite trigger.
// Prints, as JSON, the next N highest-ranked call-list companies whose outreach
// still needs (re)writing: either they have NO drafts, or their newest draft set
// predates the move to the paged model + value-first voice guide (the cutoff).
//
// Self-advancing: scripts/apply-outreach-rewrite.ts writes new rows with
// created_at = now (>= cutoff), so a processed company has a fresh draft and
// drops out of the window. Next run returns the following 10.
//
// Usage: bun scripts/outreach-gaps.ts [limit]    (default limit 10)
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

// This script is Step 1 of the hourly outreach-rewrite trigger, which then has an
// agent (over)write /tmp/outreach/results.json in a later step. The harness blocks
// overwriting a file the agent hasn't read this session, so clear any stale
// results file now — that guarantees Step 3's write is a fresh create.
// Override the path with OUTREACH_RESULTS_PATH if the trigger uses a different one.
try { unlinkSync(process.env.OUTREACH_RESULTS_PATH || "/tmp/outreach/results.json"); } catch { /* no stale file */ }

const LIMIT = Math.max(1, Math.min(50, Math.floor(Number(process.argv[2] || 10))));
// Anything drafted before this instant is "old voice" and should be rewritten.
// 29 Jun 2026 00:00 Perth (AWST) — when the paged model + voice guide landed.
const CUTOFF = Number(process.env.OUTREACH_VOICE_CUTOFF_MS) || Date.parse("2026-06-29T00:00:00+08:00");
const db = new Database(process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite", { readonly: true });

const run = db.query(
  `SELECT id FROM target_list_runs WHERE status = 'complete'
   ORDER BY completed_at DESC, created_at DESC, rowid DESC LIMIT 1`,
).get() as { id: string } | null;
if (!run) { console.log(JSON.stringify({ runId: null, cutoff: CUTOFF, count: 0, items: [] })); process.exit(0); }

// Whole call list in rank order, excluding companies already acted on (outreach sent/dismissed).
const rows = db.query(`
  SELECT sfa.score AS score, c.id, c.name, c.website, c.industry, c.location, c.profile_json
  FROM target_list_items tli
  JOIN service_fit_assessments sfa ON sfa.id = tli.service_fit_assessment_id
  JOIN companies c ON c.id = tli.company_id
  WHERE tli.target_list_run_id = ?1
    AND NOT EXISTS (SELECT 1 FROM outreach_results r WHERE r.company_id = tli.company_id)
  ORDER BY sfa.score DESC, tli.rank ASC
`).all(run.id) as any[];

// Does this company already have a fresh-voice draft (created at/after the cutoff)?
const freshDraft = db.query(
  "SELECT 1 FROM outreach_drafts WHERE company_id = ?1 AND created_at >= ?2 LIMIT 1",
);
const anyDraft = db.query("SELECT 1 FROM outreach_drafts WHERE company_id = ?1 LIMIT 1");

const items: any[] = [];
for (const r of rows) {
  if (items.length >= LIMIT) break;
  if (freshDraft.get(r.id, CUTOFF)) continue; // already rewritten — window advances past it

  const has = !!anyDraft.get(r.id);
  const p = r.profile_json ? JSON.parse(r.profile_json) : {};
  const dms = Array.isArray(p.decisionMakers) ? p.decisionMakers.filter((d: any) => d && d.name) : [];
  const primary = dms.find((d: any) => d.tier === "primary") || dms[0] || null;
  const firstName = primary ? String(primary.name).trim().split(/\s+/)[0] : "";

  items.push({
    companyId: r.id,
    name: r.name,
    website: r.website || "",
    score: r.score,
    reason: has ? "stale-pre-cutoff" : "no-outreach",
    primaryContactFirstName: firstName,
  });
}

console.log(JSON.stringify({ runId: run.id, cutoff: CUTOFF, count: items.length, items }, null, 2));
