#!/usr/bin/env bun

import { Database } from "bun:sqlite";

type Row = Record<string, unknown>;

const dbPath = Bun.argv.includes("--db")
  ? Bun.argv[Bun.argv.indexOf("--db") + 1]
  : "data/chat-wapp.sqlite";
const dryRun = Bun.argv.includes("--dry-run");

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function parseJsonObject(value: unknown): Row {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normaliseName(value: unknown) {
  return text(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}

function websiteDomain(value: unknown) {
  const raw = text(value).toLowerCase();
  if (!raw) return "";
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
  }
}

function uniqueTexts(values: unknown[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const next = text(value);
    if (!next) continue;
    const key = next.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

function bestWebsite(rows: Row[]) {
  const websites = uniqueTexts(rows.map((row) => row.website));
  if (websites.length === 0) return "";
  return websites
    .slice()
    .sort((a, b) => {
      const cleanA = a.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
      const cleanB = b.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
      return cleanA.length - cleanB.length || a.localeCompare(b);
    })[0] ?? websites[0];
}

function mergeJson(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    const serialized = new Set<string>();
    const out: unknown[] = [];
    for (const item of [...target, ...source]) {
      const key = JSON.stringify(item);
      if (serialized.has(key)) continue;
      serialized.add(key);
      out.push(item);
    }
    return out;
  }
  if (
    target && source
    && typeof target === "object"
    && typeof source === "object"
    && !Array.isArray(target)
    && !Array.isArray(source)
  ) {
    const out: Row = { ...(target as Row) };
    for (const [key, value] of Object.entries(source as Row)) {
      out[key] = key in out ? mergeJson(out[key], value) : value;
    }
    return out;
  }
  if (target === undefined || target === null || target === "") return source;
  if (source === undefined || source === null || source === "") return target;
  if (JSON.stringify(target) === JSON.stringify(source)) return target;
  return mergeJson(Array.isArray(target) ? target : [target], Array.isArray(source) ? source : [source]);
}

function dataRingRank(value: unknown) {
  return {
    seed: 0,
    found: 1,
    ranked: 2,
    scored: 3,
    enhanced: 4,
    stale: 4,
    outreach_ready: 5,
    contacted: 6,
    processed: 6,
  }[text(value)] ?? 0;
}

function enrichmentRank(value: unknown) {
  return {
    not_started: 0,
    failed: 1,
    complete: 2,
  }[text(value)] ?? 0;
}

type CompanyStats = {
  sources: number;
  profiles: number;
  outreach: number;
  feedback: number;
  alerts: number;
};

function emptyStats(): CompanyStats {
  return { sources: 0, profiles: 0, outreach: 0, feedback: 0, alerts: 0 };
}

function chooseCanonical(rows: Row[], stats: Map<string, CompanyStats>) {
  return rows
    .slice()
    .sort((a, b) => {
      const aStats = stats.get(String(a.id)) ?? emptyStats();
      const bStats = stats.get(String(b.id)) ?? emptyStats();
      const scoreA = (aStats.outreach > 0 ? 1_000_000_000 : 0)
        + enrichmentRank(a.enrichment_status) * 1_000_000
        + dataRingRank(a.data_ring) * 100_000
        + aStats.profiles * 10_000
        + aStats.sources * 100
        + aStats.feedback * 10
        + aStats.alerts
        + numberValue(a.confidence);
      const scoreB = (bStats.outreach > 0 ? 1_000_000_000 : 0)
        + enrichmentRank(b.enrichment_status) * 1_000_000
        + dataRingRank(b.data_ring) * 100_000
        + bStats.profiles * 10_000
        + bStats.sources * 100
        + bStats.feedback * 10
        + bStats.alerts
        + numberValue(b.confidence);
      return scoreB - scoreA
        || numberValue(a.created_at) - numberValue(b.created_at)
        || String(a.id).localeCompare(String(b.id));
    })[0]!;
}

function countByCompany(db: Database, table: string) {
  const rows = db.query(`SELECT company_id, COUNT(*) AS count FROM ${table} GROUP BY company_id`).all() as Row[];
  return new Map(rows.map((row) => [String(row.company_id), Number(row.count)]));
}

function mergeCompanyRow(db: Database, canonical: Row, rows: Row[]) {
  const profiles = rows.map((row) => parseJsonObject(row.profile_json));
  let mergedProfile: unknown = {};
  for (const profile of profiles) mergedProfile = mergeJson(mergedProfile, profile);
  const mergedFrom = rows
    .filter((row) => row.id !== canonical.id)
    .map((row) => ({
      id: row.id,
      name: row.name,
      location: row.location,
      industry: row.industry,
      website: row.website,
      dataRing: row.data_ring,
      enrichmentStatus: row.enrichment_status,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  mergedProfile = mergeJson(mergedProfile, {
    dedupe: {
      strongDuplicateMerge: {
        mergedAt: new Date().toISOString(),
        matchKey: {
          name: normaliseName(canonical.name),
          domain: websiteDomain(canonical.website),
        },
        canonicalId: canonical.id,
        mergedFrom,
      },
    },
  });

  const locations = uniqueTexts(rows.map((row) => row.location)).join(" | ");
  const industries = uniqueTexts(rows.map((row) => row.industry)).join(" | ");
  const dataRing = rows.slice().sort((a, b) => dataRingRank(b.data_ring) - dataRingRank(a.data_ring))[0]?.data_ring ?? canonical.data_ring;
  const enrichmentStatus = rows.slice().sort((a, b) => enrichmentRank(b.enrichment_status) - enrichmentRank(a.enrichment_status))[0]?.enrichment_status ?? canonical.enrichment_status;
  const confidence = Math.max(...rows.map((row) => numberValue(row.confidence)));
  const createdAt = Math.min(...rows.map((row) => numberValue(row.created_at, Date.now())));
  const updatedAt = Math.max(Date.now(), ...rows.map((row) => numberValue(row.updated_at)));

  db.query(`
    UPDATE companies
    SET location = ?1,
        industry = ?2,
        website = ?3,
        data_ring = ?4,
        duplicate_status = 'unknown',
        enrichment_status = ?5,
        confidence = ?6,
        profile_json = ?7,
        created_at = ?8,
        updated_at = ?9
    WHERE id = ?10
  `).run(
    locations || null,
    industries || null,
    bestWebsite(rows) || null,
    dataRing,
    enrichmentStatus,
    confidence,
    JSON.stringify(mergedProfile),
    createdAt,
    updatedAt,
    canonical.id,
  );
}

function mergeCompanySegments(db: Database, canonicalId: string, duplicateIds: string[]) {
  const rows = db.query(`
    SELECT segment_id,
           MAX(confidence) AS confidence,
           group_concat(DISTINCT source) AS sources,
           MIN(created_at) AS created_at
    FROM company_segments
    WHERE company_id IN (${[canonicalId, ...duplicateIds].map(() => "?").join(",")})
    GROUP BY segment_id
  `).all(canonicalId, ...duplicateIds) as Row[];
  db.query(`DELETE FROM company_segments WHERE company_id IN (${duplicateIds.map(() => "?").join(",")})`).run(...duplicateIds);
  for (const row of rows) {
    db.query(`
      INSERT INTO company_segments(company_id, segment_id, confidence, source, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(company_id, segment_id) DO UPDATE SET
        confidence = MAX(company_segments.confidence, excluded.confidence),
        source = excluded.source,
        created_at = MIN(company_segments.created_at, excluded.created_at)
    `).run(canonicalId, row.segment_id, row.confidence ?? 0, text(row.sources, "dedupe"), row.created_at ?? Date.now());
  }
  return rows.length;
}

function updateSimpleCompanyRefs(db: Database, table: string, canonicalId: string, duplicateIds: string[]) {
  if (duplicateIds.length === 0) return 0;
  const result = db.query(`UPDATE ${table} SET company_id = ?1 WHERE company_id IN (${duplicateIds.map(() => "?").join(",")})`)
    .run(canonicalId, ...duplicateIds);
  return result.changes;
}

function updateUniqueCompanyRefs(db: Database, input: {
  table: string;
  uniqueColumn: string;
  canonicalId: string;
  duplicateIds: string[];
  scoreColumn?: string;
}) {
  const ids = input.duplicateIds;
  if (ids.length === 0) return { updated: 0, deleted: 0 };
  let deleted = 0;
  let updated = 0;

  // Get all rows from duplicate companies
  const rows = db.query(`SELECT * FROM ${input.table} WHERE company_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];

  // Group by unique column value to find conflicts
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = String(row[input.uniqueColumn]);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  // Process each unique column value group
  for (const [uniqueValue, groupRows] of grouped) {
    // Check if canonical already has an entry for this unique value
    const existing = db.query(`SELECT * FROM ${input.table} WHERE company_id = ?1 AND ${input.uniqueColumn} = ?2`)
      .get(input.canonicalId, uniqueValue) as Row | null;

    if (!existing) {
      // No conflict: keep the best duplicate row and update it to canonical
      const best = groupRows.slice().sort((a, b) => {
        if (input.scoreColumn) {
          return numberValue(b[input.scoreColumn]) - numberValue(a[input.scoreColumn]);
        }
        return 0;
      })[0]!;
      db.query(`UPDATE ${input.table} SET company_id = ?1 WHERE id = ?2`).run(input.canonicalId, best.id);
      updated += 1;
      // Delete the rest
      for (const row of groupRows) {
        if (row.id !== best.id) {
          db.query(`DELETE FROM ${input.table} WHERE id = ?1`).run(row.id);
          deleted += 1;
        }
      }
    } else {
      // Conflict exists: keep canonical or best duplicate, delete the rest
      const allRows = [existing, ...groupRows];
      const best = allRows.slice().sort((a, b) => {
        // Canonical always wins if no score column
        if (!input.scoreColumn) {
          if (String(a.company_id) === input.canonicalId) return -1;
          if (String(b.company_id) === input.canonicalId) return 1;
          return 0;
        }
        return numberValue(b[input.scoreColumn]) - numberValue(a[input.scoreColumn]);
      })[0]!;

      // Delete all except the best
      for (const row of allRows) {
        if (row.id !== best.id) {
          db.query(`DELETE FROM ${input.table} WHERE id = ?1`).run(row.id);
          deleted += 1;
        }
      }

      // If best is not canonical, update it
      if (String(best.company_id) !== input.canonicalId) {
        db.query(`UPDATE ${input.table} SET company_id = ?1 WHERE id = ?2`).run(input.canonicalId, best.id);
        updated += 1;
      }
    }
  }

  return { updated, deleted };
}

function updateServiceFitRefs(db: Database, canonicalId: string, duplicateIds: string[]) {
  if (duplicateIds.length === 0) return { updated: 0, deleted: 0 };
  let deleted = 0;
  const rows = db.query(`SELECT * FROM service_fit_assessments WHERE company_id IN (${duplicateIds.map(() => "?").join(",")})`)
    .all(...duplicateIds) as Row[];
  for (const row of rows) {
    const existing = db.query(`
      SELECT * FROM service_fit_assessments
      WHERE company_id = ?1
        AND service_offering_id = ?2
        AND market_profile_version_id = ?3
        AND source_run_id = ?4
    `).get(canonicalId, row.service_offering_id, row.market_profile_version_id, row.source_run_id) as Row | null;
    if (!existing) continue;
    const keepDuplicate = numberValue(row.score) > numberValue(existing.score)
      || (numberValue(row.score) === numberValue(existing.score) && numberValue(row.confidence) > numberValue(existing.confidence));
    if (keepDuplicate) {
      db.query("DELETE FROM service_fit_assessments WHERE id = ?1").run(existing.id);
      deleted += 1;
    } else {
      db.query("DELETE FROM service_fit_assessments WHERE id = ?1").run(row.id);
      deleted += 1;
    }
  }
  const updated = updateSimpleCompanyRefs(db, "service_fit_assessments", canonicalId, duplicateIds);
  return { updated, deleted };
}

function updateCompanyActivities(db: Database, canonicalId: string, duplicateIds: string[]) {
  return db.query(`UPDATE activities SET target_id = ?1 WHERE target_type = 'company' AND target_id IN (${duplicateIds.map(() => "?").join(",")})`)
    .run(canonicalId, ...duplicateIds).changes;
}

function updateWorkQueue(db: Database, canonicalId: string, duplicateIds: string[]) {
  return db.query(`UPDATE work_queue SET target_id = ?1, updated_at = ?2 WHERE target_type = 'company' AND target_id IN (${duplicateIds.map(() => "?").join(",")})`)
    .run(canonicalId, Date.now(), ...duplicateIds).changes;
}

function outreachRank(row: Row) {
  const stateRank: Record<string, number> = {
    meeting: 6,
    waiting: 5,
    on_deck: 4,
    rejected: 3,
    no_response: 2,
  };
  return (stateRank[text(row.state)] ?? 1) * 1_000_000_000
    + numberValue(row.response_at) * 100
    + numberValue(row.outreach_at) * 10
    + numberValue(row.updated_at);
}

function mergeOutreachResults(db: Database, canonicalId: string, duplicateIds: string[]) {
  const ids = [canonicalId, ...duplicateIds];
  const rows = db.query(`SELECT * FROM outreach_results WHERE company_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
  if (rows.length === 0) return { updated: 0, deleted: 0 };
  const best = rows.slice().sort((a, b) => outreachRank(b) - outreachRank(a))[0]!;
  db.query(`DELETE FROM outreach_results WHERE company_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.query(`
    INSERT INTO outreach_results(
      id, company_id, state, channel, outreach_at, response_at, outcome, reason, reason_category,
      dismissed_from, fit_band, fit_score, notes, prev_data_ring, created_at, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
  `).run(
    best.id,
    canonicalId,
    text(best.state, "waiting"),
    best.channel ?? null,
    best.outreach_at ?? null,
    best.response_at ?? null,
    best.outcome ?? null,
    best.reason ?? null,
    best.reason_category ?? null,
    best.dismissed_from ?? null,
    best.fit_band ?? null,
    best.fit_score ?? null,
    best.notes ?? null,
    best.prev_data_ring ?? null,
    best.created_at ?? Date.now(),
    best.updated_at ?? Date.now(),
  );
  return {
    updated: String(best.company_id) === canonicalId && rows.length === 1 ? 0 : 1,
    deleted: rows.length - 1,
  };
}

function mergeCompanyFeedback(db: Database, canonicalId: string, duplicateIds: string[]) {
  const ids = [canonicalId, ...duplicateIds];
  const rows = db.query(`SELECT * FROM company_feedback WHERE company_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
  if (rows.length === 0) return { updated: 0, deleted: 0 };
  const best = rows.slice()
    .sort((a, b) => numberValue(b.updated_at) - numberValue(a.updated_at) || numberValue(b.created_at) - numberValue(a.created_at))[0]!;
  const labels = uniqueTexts(rows.flatMap((row) => parseJsonArray(row.labels_json)));
  const notes = uniqueTexts(rows.map((row) => row.note)).join(" | ");
  db.query(`DELETE FROM company_feedback WHERE company_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  db.query(`
    INSERT INTO company_feedback(company_id, verdict, labels_json, note, actor, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).run(
    canonicalId,
    best.verdict ?? null,
    JSON.stringify(labels),
    notes || best.note || null,
    best.actor ?? null,
    Math.min(...rows.map((row) => numberValue(row.created_at, Date.now()))),
    Math.max(...rows.map((row) => numberValue(row.updated_at, Date.now()))),
  );
  return {
    updated: String(best.company_id) === canonicalId && rows.length === 1 ? 0 : 1,
    deleted: rows.length - 1,
  };
}

const db = new Database(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 10000");

const companies = db.query("SELECT * FROM companies").all() as Row[];
const sourceCounts = countByCompany(db, "sources");
const profileCounts = countByCompany(db, "customer_profile_versions");
const outreachCounts = countByCompany(db, "outreach_results");
const feedbackCounts = countByCompany(db, "company_feedback");
const alertCounts = countByCompany(db, "alert_hits");
const stats = new Map<string, CompanyStats>();
for (const company of companies) {
  const id = String(company.id);
  stats.set(id, {
    sources: sourceCounts.get(id) ?? 0,
    profiles: profileCounts.get(id) ?? 0,
    outreach: outreachCounts.get(id) ?? 0,
    feedback: feedbackCounts.get(id) ?? 0,
    alerts: alertCounts.get(id) ?? 0,
  });
}

const groups = new Map<string, Row[]>();
for (const company of companies) {
  const name = normaliseName(company.name);
  const domain = websiteDomain(company.website);
  if (!name || !domain) continue;
  const key = `${name}|${domain}`;
  const rows = groups.get(key) ?? [];
  rows.push(company);
  groups.set(key, rows);
}

const duplicateGroups = [...groups.entries()]
  .filter(([, rows]) => rows.length > 1)
  .sort(([a], [b]) => a.localeCompare(b));

const plan = duplicateGroups.map(([key, rows]) => {
  const canonical = chooseCanonical(rows, stats);
  return {
    key,
    canonicalId: String(canonical.id),
    duplicateIds: rows.filter((row) => row.id !== canonical.id).map((row) => String(row.id)),
  };
});

const summary: Row = {
  dbPath,
  dryRun,
  duplicateGroups: plan.length,
  duplicateRowsRemoved: plan.reduce((sum, item) => sum + item.duplicateIds.length, 0),
  merged: {
    companySegments: 0,
    sources: 0,
    customerProfileVersions: 0,
    signals: 0,
    enrichmentRequests: 0,
    outreachDrafts: 0,
    outreachResults: { updated: 0, deleted: 0 },
    companyFeedback: { updated: 0, deleted: 0 },
    alertHits: 0,
    rankingItems: { updated: 0, deleted: 0 },
    serviceFitAssessments: { updated: 0, deleted: 0 },
    targetListItems: { updated: 0, deleted: 0 },
    targetRankings: 0,
    activities: 0,
    workQueue: 0,
  },
};

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

db.exec("BEGIN IMMEDIATE");
try {
  for (const item of plan) {
    const rows = companies.filter((company) => String(company.id) === item.canonicalId || item.duplicateIds.includes(String(company.id)));
    const canonical = rows.find((row) => String(row.id) === item.canonicalId)!;
    mergeCompanyRow(db, canonical, rows);
    (summary.merged as Row).companySegments = numberValue((summary.merged as Row).companySegments) + mergeCompanySegments(db, item.canonicalId, item.duplicateIds);

    (summary.merged as Row).sources = numberValue((summary.merged as Row).sources) + updateSimpleCompanyRefs(db, "sources", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).customerProfileVersions = numberValue((summary.merged as Row).customerProfileVersions) + updateSimpleCompanyRefs(db, "customer_profile_versions", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).signals = numberValue((summary.merged as Row).signals) + updateSimpleCompanyRefs(db, "signals", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).enrichmentRequests = numberValue((summary.merged as Row).enrichmentRequests) + updateSimpleCompanyRefs(db, "enrichment_requests", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).outreachDrafts = numberValue((summary.merged as Row).outreachDrafts) + updateSimpleCompanyRefs(db, "outreach_drafts", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).alertHits = numberValue((summary.merged as Row).alertHits) + updateSimpleCompanyRefs(db, "alert_hits", item.canonicalId, item.duplicateIds);
    (summary.merged as Row).activities = numberValue((summary.merged as Row).activities) + updateCompanyActivities(db, item.canonicalId, item.duplicateIds);
    (summary.merged as Row).workQueue = numberValue((summary.merged as Row).workQueue) + updateWorkQueue(db, item.canonicalId, item.duplicateIds);

    const outreach = mergeOutreachResults(db, item.canonicalId, item.duplicateIds);
    const feedback = mergeCompanyFeedback(db, item.canonicalId, item.duplicateIds);
    const ranking = updateUniqueCompanyRefs(db, {
      table: "ranking_items",
      uniqueColumn: "ranking_run_id",
      canonicalId: item.canonicalId,
      duplicateIds: item.duplicateIds,
      scoreColumn: "score",
    });
    const targetList = updateUniqueCompanyRefs(db, {
      table: "target_list_items",
      uniqueColumn: "target_list_run_id",
      canonicalId: item.canonicalId,
      duplicateIds: item.duplicateIds,
      scoreColumn: "score",
    });
    const fit = updateServiceFitRefs(db, item.canonicalId, item.duplicateIds);
    (summary.merged as Row).outreachResults = {
      updated: numberValue(((summary.merged as Row).outreachResults as Row).updated) + outreach.updated,
      deleted: numberValue(((summary.merged as Row).outreachResults as Row).deleted) + outreach.deleted,
    };
    (summary.merged as Row).companyFeedback = {
      updated: numberValue(((summary.merged as Row).companyFeedback as Row).updated) + feedback.updated,
      deleted: numberValue(((summary.merged as Row).companyFeedback as Row).deleted) + feedback.deleted,
    };
    (summary.merged as Row).rankingItems = {
      updated: numberValue(((summary.merged as Row).rankingItems as Row).updated) + ranking.updated,
      deleted: numberValue(((summary.merged as Row).rankingItems as Row).deleted) + ranking.deleted,
    };
    (summary.merged as Row).targetListItems = {
      updated: numberValue(((summary.merged as Row).targetListItems as Row).updated) + targetList.updated,
      deleted: numberValue(((summary.merged as Row).targetListItems as Row).deleted) + targetList.deleted,
    };
    (summary.merged as Row).serviceFitAssessments = {
      updated: numberValue(((summary.merged as Row).serviceFitAssessments as Row).updated) + fit.updated,
      deleted: numberValue(((summary.merged as Row).serviceFitAssessments as Row).deleted) + fit.deleted,
    };

    db.query(`DELETE FROM companies WHERE id IN (${item.duplicateIds.map(() => "?").join(",")})`).run(...item.duplicateIds);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(JSON.stringify(summary, null, 2));
