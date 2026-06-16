#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

type Row = Record<string, unknown>;

const EXPORT_VERSION = 1;
const DEFAULT_DB_PATH = "data/chat-wapp.sqlite";

const TABLES: Record<string, string[]> = {
  target_segments: [
    "id",
    "parent_id",
    "label",
    "tier",
    "priority",
    "status",
    "default_geo",
    "default_target_count",
    "default_batch_size",
    "coverage_targets_json",
    "scan_prompts_json",
    "created_at",
    "updated_at",
  ],
  target_geographies: ["id", "parent_id", "label", "kind", "canonical_key", "status", "created_at", "updated_at"],
  coverage_slices: [
    "id",
    "segment_id",
    "geography_id",
    "geography_text",
    "source_family",
    "strategy_type",
    "status",
    "target_counts_json",
    "current_counts_json",
    "yield_metrics_json",
    "last_run_at",
    "next_run_after_at",
    "stalled_reason",
    "created_at",
    "updated_at",
  ],
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
  company_segments: ["company_id", "segment_id", "confidence", "source", "created_at"],
  sources: [
    "id",
    "company_id",
    "source_type",
    "url",
    "title",
    "summary",
    "extracted_data_json",
    "confidence",
    "last_checked_at",
    "last_checked_by_run_id",
    "terms_notes",
    "created_at",
  ],
  customer_profile_versions: [
    "id",
    "company_id",
    "version_number",
    "status",
    "profile_json",
    "change_summary",
    "source_ids_json",
    "activity_ids_json",
    "created_by",
    "created_at",
  ],
  signals: [
    "id",
    "company_id",
    "signal_type",
    "summary",
    "source_id",
    "source_url",
    "observed_date",
    "strength",
    "confidence",
    "adapt_relevance",
    "evidence_json",
    "created_at",
  ],
  discovery_jobs: [
    "id",
    "industry",
    "location",
    "segment_id",
    "geography_id",
    "geography_text",
    "coverage_slice_id",
    "target_count",
    "scan_mode",
    "status",
    "company_count",
    "source_count",
    "summary",
    "created_at",
    "updated_at",
  ],
  scan_strategy_attempts: [
    "id",
    "discovery_job_id",
    "segment_id",
    "geography_id",
    "geography_text",
    "coverage_slice_id",
    "source_family",
    "industry",
    "location",
    "strategy_type",
    "query",
    "status",
    "result_count",
    "notes",
    "payload_json",
    "created_at",
  ],
  activities: ["id", "target_type", "target_id", "actor", "action_type", "summary", "payload_json", "created_at"],
};

const IMPORT_ORDER = [
  "target_segments",
  "target_geographies",
  "coverage_slices",
  "companies",
  "company_segments",
  "sources",
  "customer_profile_versions",
  "signals",
  "discovery_jobs",
  "scan_strategy_attempts",
  "activities",
];

function usage(): never {
  console.error(`Usage:
  bun scripts/client-list-migration.ts export --out data/kindling-client-list.json [--db data/chat-wapp.sqlite]
  bun scripts/client-list-migration.ts import --in data/kindling-client-list.json [--db data/chat-wapp.sqlite] [--replace]

Exports/imports discovered companies and enrichment evidence only.
Does not migrate service offerings, fit scores, rankings, target lists, outreach drafts, work queue, scheduler runs, or pipeline runs.`);
  process.exit(2);
}

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name: string) {
  return Bun.argv.includes(name);
}

function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

function selectRows(db: Database, table: string, where = "") {
  const cols = TABLES[table]!;
  const sql = `SELECT ${cols.join(", ")} FROM ${table}${where ? ` ${where}` : ""}`;
  return db.query(sql).all() as Row[];
}

function countRows(rows: Record<string, Row[]>) {
  return Object.fromEntries(Object.entries(rows).map(([table, tableRows]) => [table, tableRows.length]));
}

function exportClientList() {
  const dbPath = resolve(argValue("--db", DEFAULT_DB_PATH));
  const outPath = resolve(argValue("--out"));
  if (!outPath) usage();

  const db = openDb(dbPath);
  const rows: Record<string, Row[]> = {};
  rows.target_segments = selectRows(db, "target_segments");
  rows.target_geographies = selectRows(db, "target_geographies");
  rows.coverage_slices = selectRows(db, "coverage_slices");
  rows.companies = selectRows(db, "companies");
  rows.company_segments = selectRows(db, "company_segments");
  rows.sources = selectRows(db, "sources");
  rows.customer_profile_versions = selectRows(db, "customer_profile_versions");
  rows.signals = selectRows(db, "signals");
  rows.discovery_jobs = selectRows(db, "discovery_jobs");
  rows.scan_strategy_attempts = selectRows(db, "scan_strategy_attempts");
  rows.activities = selectRows(
    db,
    "activities",
    "WHERE target_type IN ('company', 'source', 'industry', 'discovery_job', 'target_list_run')",
  );

  const payload = {
    kind: "kindling-client-list-export",
    version: EXPORT_VERSION,
    generatedAt: new Date().toISOString(),
    sourceDb: dbPath,
    excluded: [
      "service_offerings",
      "service_fit_assessments",
      "target_rankings",
      "ranking_runs",
      "ranking_items",
      "target_list_runs",
      "target_list_items",
      "outreach_drafts",
      "work_queue",
      "enrichment_requests",
      "scheduler_runs",
      "scheduler_locks",
      "kindling_pipeline_runs",
      "pipeline_runs",
      "chats",
      "messages",
      "sessions",
      "users",
      "access_rules",
    ],
    counts: countRows(rows),
    rows,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ outPath, counts: payload.counts }, null, 2));
}

function loadPayload(path: string) {
  const payload = JSON.parse(readFileSync(path, "utf8")) as {
    kind?: string;
    version?: number;
    rows?: Record<string, Row[]>;
  };
  if (payload.kind !== "kindling-client-list-export") {
    throw new Error(`Unexpected export kind: ${payload.kind || "(missing)"}`);
  }
  if (payload.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${payload.version}`);
  }
  if (!payload.rows || typeof payload.rows !== "object") {
    throw new Error("Export payload has no rows object.");
  }
  return payload.rows;
}

function insertRows(db: Database, table: string, rows: Row[]) {
  if (!rows.length) return;
  const cols = TABLES[table]!;
  const placeholders = cols.map((_, index) => `?${index + 1}`).join(", ");
  const updateCols = cols.map((col) => `${col} = excluded.${col}`).join(", ");
  const stmt = db.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO UPDATE SET ${updateCols}`);
  for (const row of rows) {
    stmt.run(...cols.map((col) => row[col] ?? null));
  }
}

async function initialiseSchema(dbPath: string) {
  process.env.CHAT_WAPP_DB_PATH = dbPath;
  await import("../src/db.ts");
}

async function importClientList() {
  const inputPath = resolve(argValue("--in"));
  const dbPath = resolve(argValue("--db", DEFAULT_DB_PATH));
  if (!inputPath) usage();

  await initialiseSchema(dbPath);
  const db = openDb(dbPath);
  const rows = loadPayload(inputPath);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (hasFlag("--replace")) {
      for (const table of [...IMPORT_ORDER].reverse()) {
        db.query(`DELETE FROM ${table}`).run();
      }
    }
    for (const table of IMPORT_ORDER) {
      insertRows(db, table, rows[table] || []);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const importedRows = Object.fromEntries(IMPORT_ORDER.map((table) => [table, Number(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
  console.log(JSON.stringify({ dbPath, importedRows }, null, 2));
}

const command = Bun.argv[2];
if (command === "export") {
  exportClientList();
} else if (command === "import") {
  await importClientList();
} else {
  usage();
}
