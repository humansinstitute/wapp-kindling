#!/usr/bin/env bun
// One monitoring tick for the Adapt ICP enrichment+scoring pipeline.
// Reports cohort progress, recent pipeline failures, and whether the loops
// are alive. Exits 0 always; prints a compact status line plus alerts.
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

const SEG = "adapt-icp-known-good-fit";
const db = new Database("data/chat-wapp.sqlite");
const q = (s: string, ...a: any[]) => db.query(s).all(...a) as any[];
const one = (s: string, ...a: any[]) => db.query(s).get(...a) as any;

const status = Object.fromEntries(q(`SELECT c.enrichment_status s, COUNT(*) n FROM company_segments cs JOIN companies c ON c.id=cs.company_id WHERE cs.segment_id=?1 GROUP BY 1`, SEG).map(r => [r.s, r.n]));
const total = one(`SELECT COUNT(*) n FROM company_segments WHERE segment_id=?1`, SEG).n;
const scored = one(`SELECT COUNT(DISTINCT sfa.company_id) n FROM service_fit_assessments sfa JOIN company_segments cs ON cs.company_id=sfa.company_id WHERE cs.segment_id=?1`, SEG).n;

const since = Date.now() - 60 * 60 * 1000;
const runs = q(`SELECT role_key, status, COUNT(*) n FROM kindling_pipeline_runs WHERE updated_at>?1 GROUP BY 1,2 ORDER BY 1,2`, since);

function loopAlive(name: string) {
  const r = spawnSync("pgrep", ["-f", name], { encoding: "utf8" });
  return (r.stdout || "").trim().length > 0;
}
const enrichAlive = loopAlive("loop-enrichment.sh");
const scoreAlive = loopAlive("loop-scoring.sh");

const ts = spawnSync("date", ["-Iseconds"], { encoding: "utf8" }).stdout.trim();
console.log(`[${ts}] ICP ${total} total | enriched=${(status.complete||0)} running=${(status.enrichment_status==="running"?0:status.running)||status.running||0} queued=${status.queued||0} not_started=${status.not_started||0} failed=${status.failed||0} | scored=${scored}`);
console.log(`  loops: enrichment=${enrichAlive?"UP":"DOWN"} scoring=${scoreAlive?"UP":"DOWN"}`);
const runline = runs.map(r => `${r.role_key}:${r.status}=${r.n}`).join("  ");
console.log(`  runs(60m): ${runline || "none"}`);

const alerts: string[] = [];
if (!enrichAlive) alerts.push("ENRICHMENT LOOP DOWN");
if (!scoreAlive) alerts.push("SCORING LOOP DOWN");
const recentFails = runs.filter(r => r.status === "failed").reduce((a, r) => a + r.n, 0);
if (recentFails >= 5) alerts.push(`${recentFails} pipeline failures in last 60m`);
if (alerts.length) console.log("  ALERT: " + alerts.join("; "));

// done when every ICP company is scored
if (scored >= total) console.log("  ALL ICP COMPANIES SCORED ✅");
