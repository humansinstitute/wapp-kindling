#!/usr/bin/env bun

import { TowerDbClient, TowerDbError, initializeTowerDbRuntime } from "../src/tower-db.ts";

type Row = Record<string, unknown>;
type QueryInput = {
  select?: string[];
  where?: Record<string, Record<string, unknown>>;
  order?: Array<{ field: string; dir?: "asc" | "desc" }>;
  limit?: number;
  offset?: number;
};

type SuiteConfig = {
  towerUrl: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  appNsec: string;
};

type TableSummary = {
  table: string;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
};

const PAGE_SIZE = 500;
const IN_CHUNK_SIZE = 100;
const DEFAULT_FOUND_RINGS = ["found", "seed", "manual", "discovered"];
const COPY_ORDER = [
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
] as const;

function usage(): never {
  console.error(`Usage:
  bun scripts/seed-found-companies-to-tower.ts --target-tower-url <url> --target-workspace-owner-npub <npub> --target-app-npub <npub> --target-app-nsec <nsec>

Source defaults to SOURCE_* env vars, then the current Kindling env:
  SOURCE_TOWER_URL or TOWER_URL
  SOURCE_WORKSPACE_OWNER_NPUB or WORKSPACE_OWNER_NPUB
  SOURCE_APP_NPUB or APP_NPUB
  SOURCE_APP_NSEC or APP_NSEC

Target can be passed by args or TARGET_* env vars:
  TARGET_TOWER_URL
  TARGET_WORKSPACE_OWNER_NPUB
  TARGET_APP_NPUB
  TARGET_APP_NSEC

Options:
  --rings found,seed,manual,discovered   Company data_ring values to copy
  --all-companies                        Copy every company, regardless of data_ring
  --companies-only                       Copy only companies, not sources/evidence/context
  --skip-provision                       Do not provision/migrate target before copying
  --dry-run                              Read source and report what would be copied
`);
  process.exit(2);
}

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name: string) {
  return Bun.argv.includes(name);
}

function envValue(name: string, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function readSuiteConfig(kind: "source" | "target"): SuiteConfig {
  const prefix = kind === "source" ? "SOURCE" : "TARGET";
  const fallbackPrefix = kind === "source" ? "" : "TARGET";
  const value = (key: string) => {
    const argName = `--${kind}-${key.toLowerCase().replaceAll("_", "-")}`;
    const envName = `${prefix}_${key}`;
    const fallbackEnvName = fallbackPrefix ? "" : key;
    return argValue(argName, envValue(envName, fallbackEnvName ? envValue(fallbackEnvName) : ""));
  };
  return {
    towerUrl: value("TOWER_URL").replace(/\/$/, ""),
    workspaceOwnerNpub: value("WORKSPACE_OWNER_NPUB"),
    appNpub: value("APP_NPUB"),
    appNsec: value("APP_NSEC"),
  };
}

function assertConfig(label: string, config: SuiteConfig) {
  const missing = Object.entries(config)
    .filter(([, value]) => !String(value || "").trim())
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`${label} config is missing: ${missing.join(", ")}`);
  }
}

function createClient(config: SuiteConfig) {
  return new TowerDbClient({
    towerUrl: config.towerUrl,
    workspaceOwnerNpub: config.workspaceOwnerNpub,
    appNpub: config.appNpub,
    appNsec: config.appNsec,
  });
}

async function pageRows(client: TowerDbClient, table: string, input: QueryInput = {}) {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const payload = await client.queryRows(table, {
      ...input,
      limit: PAGE_SIZE,
      offset,
    });
    const page = rowsFromPayload(payload);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function rowsWhereIn(client: TowerDbClient, table: string, field: string, values: string[]) {
  const rows: Row[] = [];
  const uniqueValues = [...new Set(values.filter(Boolean))];
  for (let index = 0; index < uniqueValues.length; index += IN_CHUNK_SIZE) {
    const chunk = uniqueValues.slice(index, index + IN_CHUNK_SIZE);
    rows.push(...await pageRows(client, table, { where: { [field]: { in: chunk } } }));
  }
  return rows;
}

function rowsFromPayload(payload: unknown): Row[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rows = (payload as Row).rows;
  return Array.isArray(rows) ? rows.filter(isRow) : [];
}

function isRow(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rowId(table: string, row: Row) {
  const id = String(row.id ?? "").trim();
  if (id) return id;
  if (table === "company_segments") return `${String(row.company_id ?? "")}:${String(row.segment_id ?? "")}`;
  if (table === "scheduler_locks") return String(row.lock_key ?? "");
  if (table === "access_rules") return `${String(row.pubkey ?? "")}:${String(row.role ?? "")}`;
  if (table === "app_settings") return String(row.key ?? "");
  if (table === "pipeline_roles") return String(row.role_key ?? "");
  throw new Error(`Cannot infer row id for ${table}`);
}

function uniqueRows(table: string, rows: Row[]) {
  const byId = new Map<string, Row>();
  for (const row of rows) {
    const id = rowId(table, row);
    if (id) byId.set(id, row);
  }
  return [...byId.values()];
}

function sortTargetSegments(rows: Row[]) {
  const byId = new Map(rows.map((row) => [String(row.id ?? ""), row]));
  const ordered: Row[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (row: Row) => {
    const id = String(row.id ?? "");
    if (!id || seen.has(id)) return;
    if (visiting.has(id)) {
      seen.add(id);
      ordered.push(row);
      return;
    }
    visiting.add(id);
    const parentId = String(row.parent_id ?? "");
    const parent = parentId ? byId.get(parentId) : null;
    if (parent) visit(parent);
    visiting.delete(id);
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(row);
    }
  };
  for (const row of rows) visit(row);
  return ordered;
}

function cleanRow(row: Row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

async function copyRow(client: TowerDbClient, table: string, row: Row) {
  const id = rowId(table, row);
  const data = cleanRow({ ...row, id });
  try {
    await client.createRow(table, data, id);
    return "created" as const;
  } catch (error) {
    if (error instanceof TowerDbError && error.status === 409) {
      const { id: _id, ...set } = data;
      await client.patchRow(table, id, set);
      return "updated" as const;
    }
    throw error;
  }
}

async function copyTable(client: TowerDbClient, table: string, rows: Row[], dryRun: boolean): Promise<TableSummary> {
  const inputRows = table === "target_segments" ? sortTargetSegments(uniqueRows(table, rows)) : uniqueRows(table, rows);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of inputRows) {
    if (dryRun) {
      skipped += 1;
      continue;
    }
    const result = await copyRow(client, table, row);
    if (result === "created") created += 1;
    else updated += 1;
  }
  return { table, rows: inputRows.length, created, updated, skipped };
}

async function collectRows(source: TowerDbClient, options: { allCompanies: boolean; rings: string[]; companiesOnly: boolean }) {
  const tables: Record<string, Row[]> = Object.fromEntries(COPY_ORDER.map((table) => [table, []]));
  const companyQuery: QueryInput = {
    order: [{ field: "updated_at", dir: "desc" }, { field: "name", dir: "asc" }],
  };
  if (!options.allCompanies) {
    companyQuery.where = { data_ring: { in: options.rings } };
  }
  tables.companies = await pageRows(source, "companies", companyQuery);

  const companyIds = tables.companies.map((row) => String(row.id ?? "")).filter(Boolean);
  if (!companyIds.length || options.companiesOnly) return tables;

  const [targetSegments, targetGeographies, coverageSlices, companySegments, sources, profiles, signals, discoveryJobs, scanAttempts] = await Promise.all([
    pageRows(source, "target_segments", { order: [{ field: "tier", dir: "asc" }, { field: "priority", dir: "asc" }, { field: "label", dir: "asc" }] }),
    pageRows(source, "target_geographies", { order: [{ field: "label", dir: "asc" }] }),
    pageRows(source, "coverage_slices", { order: [{ field: "updated_at", dir: "desc" }] }),
    rowsWhereIn(source, "company_segments", "company_id", companyIds),
    rowsWhereIn(source, "sources", "company_id", companyIds),
    rowsWhereIn(source, "customer_profile_versions", "company_id", companyIds),
    rowsWhereIn(source, "signals", "company_id", companyIds),
    pageRows(source, "discovery_jobs", { order: [{ field: "updated_at", dir: "desc" }] }),
    pageRows(source, "scan_strategy_attempts", { order: [{ field: "created_at", dir: "desc" }] }),
  ]);

  tables.target_segments = targetSegments;
  tables.target_geographies = targetGeographies;
  tables.coverage_slices = coverageSlices;
  tables.company_segments = companySegments;
  tables.sources = sources;
  tables.customer_profile_versions = profiles;
  tables.signals = signals;
  tables.discovery_jobs = discoveryJobs;
  tables.scan_strategy_attempts = scanAttempts;

  const sourceIds = sources.map((row) => String(row.id ?? "")).filter(Boolean);
  const discoveryJobIds = discoveryJobs.map((row) => String(row.id ?? "")).filter(Boolean);
  const activityRows = [
    ...await rowsWhereIn(source, "activities", "target_id", companyIds),
    ...await rowsWhereIn(source, "activities", "target_id", sourceIds),
    ...await rowsWhereIn(source, "activities", "target_id", discoveryJobIds),
    ...await pageRows(source, "activities", { where: { target_type: { eq: "industry" } } }),
  ];
  tables.activities = activityRows.filter((row) => {
    const targetType = String(row.target_type ?? "");
    if (targetType === "company") return companyIds.includes(String(row.target_id ?? ""));
    if (targetType === "source") return sourceIds.includes(String(row.target_id ?? ""));
    if (targetType === "discovery_job") return discoveryJobIds.includes(String(row.target_id ?? ""));
    return targetType === "industry";
  });

  return tables;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const sourceConfig = readSuiteConfig("source");
  const targetConfig = readSuiteConfig("target");
  assertConfig("source", sourceConfig);
  assertConfig("target", targetConfig);

  const dryRun = hasFlag("--dry-run");
  const allCompanies = hasFlag("--all-companies");
  const companiesOnly = hasFlag("--companies-only");
  const rings = argValue("--rings", DEFAULT_FOUND_RINGS.join(","))
    .split(",")
    .map((ring) => ring.trim())
    .filter(Boolean);
  if (!allCompanies && !rings.length) throw new Error("At least one ring is required unless --all-companies is set.");

  const source = createClient(sourceConfig);
  const target = createClient(targetConfig);

  if (!dryRun && !hasFlag("--skip-provision")) {
    await initializeTowerDbRuntime(target, true);
  }

  const rowsByTable = await collectRows(source, { allCompanies, rings, companiesOnly });
  const summaries: TableSummary[] = [];
  for (const table of COPY_ORDER) {
    const rows = rowsByTable[table] || [];
    if (companiesOnly && table !== "companies") continue;
    const summary = await copyTable(target, table, rows, dryRun);
    summaries.push(summary);
    console.log(`${table}: rows=${summary.rows} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped}`);
  }

  const totals = summaries.reduce((acc, item) => ({
    rows: acc.rows + item.rows,
    created: acc.created + item.created,
    updated: acc.updated + item.updated,
    skipped: acc.skipped + item.skipped,
  }), { rows: 0, created: 0, updated: 0, skipped: 0 });

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    allCompanies,
    rings: allCompanies ? [] : rings,
    companiesOnly,
    source: {
      towerUrl: sourceConfig.towerUrl,
      workspaceOwnerNpub: sourceConfig.workspaceOwnerNpub,
      appNpub: sourceConfig.appNpub,
    },
    target: {
      towerUrl: targetConfig.towerUrl,
      workspaceOwnerNpub: targetConfig.workspaceOwnerNpub,
      appNpub: targetConfig.appNpub,
    },
    totals,
    summaries,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
