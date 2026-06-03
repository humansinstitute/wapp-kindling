#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

const TABLES = {
  companies: [
    "id",
    "name",
    "location",
    "industry",
    "website",
    "data_ring",
    "duplicate_status",
    "enrichment_status",
    "confidence",
    "profile_json",
    "created_at",
    "updated_at",
  ],
  sources: ["id", "company_id", "source_type", "url", "summary", "confidence", "created_at"],
  activities: ["id", "target_type", "target_id", "actor", "action_type", "summary", "payload_json", "created_at"],
  discovery_jobs: ["id", "industry", "location", "target_count", "scan_mode", "status", "company_count", "source_count", "summary", "created_at", "updated_at"],
  scan_strategy_attempts: ["id", "discovery_job_id", "industry", "location", "strategy_type", "query", "status", "result_count", "notes", "payload_json", "created_at"],
  enrichment_requests: ["id", "company_id", "status", "request_kind", "summary", "created_at", "updated_at"],
  target_rankings: ["id", "company_id", "rank", "reason", "score_json", "created_at"],
  outreach_drafts: ["id", "company_id", "pitch_text", "status", "source_run_id", "created_at", "updated_at"],
} as const;

function argValue(name: string, fallback: string) {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

const dbPath = argValue("--db", process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite");
const outputPath = resolve(argValue("--out", `data/kindling-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
const db = new Database(dbPath, { readonly: true });
const tables: Record<string, unknown[]> = {};
const counts: Record<string, number> = {};

for (const [table, columns] of Object.entries(TABLES)) {
  const rows = db.query(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];
  tables[table] = rows;
  counts[table] = rows.length;
}

const payload = {
  exportedAt: new Date().toISOString(),
  source: {
    dbPath,
    app: "kindling",
  },
  counts,
  tables,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, counts }, null, 2));
