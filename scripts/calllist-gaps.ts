// Selection step for the hourly call-list enrichment trigger.
// Prints, as JSON, the next N highest-ranked call-list companies that still
// need outreach details (no website, no company call data, or no reachable
// decision-maker) AND have not yet been attempted by an enrichment pass.
//
// "Attempted" = profile_json.contactEnrichment.capturedAt is set. This makes the
// window self-advance: once the top 25 are done, the next run returns 26-35.
//
// Usage: bun scripts/calllist-gaps.ts [limit]   (default limit 10)
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

// Step 1 of the hourly contacts catch-up trigger, which later has an agent
// (over)write /tmp/research/results.json. The harness blocks overwriting an
// unread file, so clear any stale results file now to keep the write a fresh
// create. Override with RESEARCH_RESULTS_PATH if the trigger uses another path.
try { unlinkSync(process.env.RESEARCH_RESULTS_PATH || "/tmp/research/results.json"); } catch { /* no stale file */ }

const LIMIT = Math.max(1, Math.min(50, Math.floor(Number(process.argv[2] || 10))));
const db = new Database(process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite", { readonly: true });

const run = db.query(
  `SELECT id FROM target_list_runs WHERE status = 'complete'
   ORDER BY completed_at DESC, created_at DESC, rowid DESC LIMIT 1`,
).get() as { id: string } | null;
if (!run) { console.log(JSON.stringify({ runId: null, items: [] })); process.exit(0); }

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

const items: any[] = [];
for (const r of rows) {
  if (items.length >= LIMIT) break;
  const p = r.profile_json ? JSON.parse(r.profile_json) : {};
  const attempted = !!p?.contactEnrichment?.capturedAt;
  if (attempted) continue; // window advances past already-attempted companies

  const dms = Array.isArray(p.decisionMakers) ? p.decisionMakers.filter((d: any) => d && d.name) : [];
  const reachable = dms.filter((d: any) => String(d.email || "").trim() || String(d.phone || "").trim() || String(d.linkedin || d.linkedinUrl || "").trim()).length;
  const contact = p.contact || {};
  const hasWebsite = !!String(r.website || "").trim();
  const hasCompanyCall = !!String(contact.phone || "").trim() || !!String(contact.email || "").trim();

  const needsWork = !hasWebsite || !hasCompanyCall || reachable < 1;
  if (!needsWork) continue; // already complete (e.g. pre-enriched) — skip without an attempt

  items.push({
    companyId: r.id,
    name: r.name,
    website: r.website || "",
    location: r.location || "",
    industry: r.industry || "",
    score: r.score,
    gaps: { website: !hasWebsite, companyCall: !hasCompanyCall, reachablePeople: reachable },
  });
}

console.log(JSON.stringify({ runId: run.id, count: items.length, items }, null, 2));
