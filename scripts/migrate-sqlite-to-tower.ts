import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createTowerDbClientFromEnv, initializeTowerDbRuntime, TowerDbError } from "../src/tower-db.ts";

type SqliteValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, SqliteValue>;

const DEFAULT_TABLES = [
  "users",
  "access_rules",
  "app_settings",
  "pipeline_roles",
  "target_segments",
  "target_geographies",
  "companies",
  "company_segments",
  "sources",
  "signals",
  "activities",
  "customer_profile_versions",
  "chats",
  "messages",
  "pipeline_runs",
  "market_profiles",
  "market_profile_versions",
  "service_offerings",
  "kindling_pipeline_runs",
  "enrichment_requests",
  "work_queue",
  "discovery_jobs",
  "coverage_slices",
  "scan_strategy_attempts",
  "ranking_runs",
  "ranking_items",
  "scheduler_settings",
  "scheduler_runs",
  "scheduler_locks",
  "service_fit_assessments",
  "target_list_runs",
  "target_list_items",
  "target_rankings",
  "outreach_drafts",
];

const SKIPPED_VOLATILE_TABLES = new Set(["login_challenges", "sessions"]);

function argValue(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function tableExists(db: Database, table: string) {
  const row = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table);
  return Boolean(row);
}

function sqliteColumns(db: Database, table: string): string[] {
  return db.query(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all()
    .map((row) => String((row as Record<string, unknown>).name))
    .filter(Boolean);
}

function sqliteRows(db: Database, table: string): Row[] {
  return db.query(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all() as Row[];
}

function rowId(table: string, row: Row): string {
  if (typeof row.id === "string" && row.id) return row.id;
  if (table === "users" || table === "login_challenges") return String(row.pubkey || "");
  if (table === "sessions") return String(row.token || "");
  if (table === "app_settings") return String(row.key || "");
  if (table === "access_rules") return `${row.pubkey}:${row.role}`;
  if (table === "pipeline_roles") return String(row.role_key || "");
  if (table === "scheduler_locks") return String(row.lock_key || "");
  if (table === "company_segments") return `${row.company_id}:${row.segment_id}`;
  throw new Error(`Cannot infer Tower row id for ${table}`);
}

function normalizeRow(table: string, row: Row, columns: Set<string>) {
  const id = rowId(table, row);
  if (!id) throw new Error(`Missing id for ${table}`);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "id" && !columns.has("id")) continue;
    if (value instanceof Uint8Array) data[key] = Buffer.from(value).toString("base64");
    else data[key] = value;
  }
  if (columns.has("id")) data.id = id;
  return { id, data };
}

async function copyRow(client: ReturnType<typeof createTowerDbClientFromEnv>, table: string, id: string, data: Record<string, unknown>) {
  try {
    await client.createRow(table, data, id);
    return "created" as const;
  } catch (error) {
    if (error instanceof TowerDbError && error.status === 409) {
      await client.patchRow(table, id, data);
      return "updated" as const;
    }
    throw error;
  }
}

async function main() {
  const dbPath = resolve(argValue("--sqlite", process.env.CHAT_WAPP_DB_PATH || "data/chat-wapp.sqlite"));
  if (!existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const dryRun = hasFlag("--dry-run");
  const includeVolatile = hasFlag("--include-volatile");
  const tables = argValue("--tables")
    ? argValue("--tables").split(",").map((table) => table.trim()).filter(Boolean)
    : DEFAULT_TABLES;

  const db = new Database(dbPath, { readonly: true });
  const client = createTowerDbClientFromEnv();
  await initializeTowerDbRuntime(client, true);

  const summary: Array<{ table: string; rows: number; created: number; updated: number; skipped: number }> = [];
  for (const table of tables) {
    if (!includeVolatile && SKIPPED_VOLATILE_TABLES.has(table)) {
      summary.push({ table, rows: 0, created: 0, updated: 0, skipped: 0 });
      continue;
    }
    if (!tableExists(db, table)) {
      summary.push({ table, rows: 0, created: 0, updated: 0, skipped: 0 });
      continue;
    }
    const columns = new Set(sqliteColumns(db, table));
    const rows = sqliteRows(db, table);
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const { id, data } = normalizeRow(table, row, columns);
      if (dryRun) {
        skipped++;
        continue;
      }
      const result = await copyRow(client, table, id, data);
      if (result === "created") created++;
      else updated++;
    }
    summary.push({ table, rows: rows.length, created, updated, skipped });
    console.log(`${table}: rows=${rows.length} created=${created} updated=${updated} skipped=${skipped}`);
  }

  const totals = summary.reduce((acc, item) => ({
    rows: acc.rows + item.rows,
    created: acc.created + item.created,
    updated: acc.updated + item.updated,
    skipped: acc.skipped + item.skipped,
  }), { rows: 0, created: 0, updated: 0, skipped: 0 });
  console.log(JSON.stringify({ ok: true, dryRun, sqlite: dbPath, totals, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
