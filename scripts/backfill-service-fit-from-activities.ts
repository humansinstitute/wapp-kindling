import { createHash } from "node:crypto";
import { initializeTowerDbRuntime } from "../src/tower-db.ts";
import { getTowerStore } from "../src/tower-store.ts";

type Row = Record<string, unknown>;

const ENRICHED_STATUSES = new Set(["enriched", "complete", "processed"]);
const SCORING_DATA_RINGS = new Set(["scored", "outreach_ready", "outreach", "contacted"]);

function jsonParse(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function scoreBand(score: number) {
  if (score >= 75) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function assessmentId(companyId: string, serviceOfferingId: string, marketProfileVersionId: string, sourceRunId: string) {
  const hash = createHash("sha256")
    .update(`${companyId}:${serviceOfferingId}:${marketProfileVersionId}:${sourceRunId}`)
    .digest("hex")
    .slice(0, 24);
  return `service_fit_assessment:${hash}`;
}

async function pageRows(table: string, input: Row = {}) {
  const store = getTowerStore();
  const rows: Row[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await store.query(table, { ...input, limit: pageSize, offset });
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await initializeTowerDbRuntime(undefined, true);
  const store = getTowerStore();

  const companies = await pageRows("companies", { select: ["id", "enrichment_status", "data_ring"] });
  const companiesById = new Map(companies.map((row) => [String(row.id), row]));
  const offeringIds = new Set((await pageRows("service_offerings", { select: ["id"] })).map((row) => String(row.id)));
  const versionIds = new Set((await pageRows("market_profile_versions", { select: ["id"] })).map((row) => String(row.id)));
  const existingIds = new Set((await pageRows("service_fit_assessments", { select: ["id"] })).map((row) => String(row.id)));

  const activities = await pageRows("activities", {
    where: { action_type: { eq: "service_fit_assessed" } },
    order: [{ field: "created_at", dir: "asc" }],
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const scoredCompanies = new Set<string>();

  for (const activity of activities) {
    const companyId = String(activity.target_id ?? "");
    const company = companiesById.get(companyId);
    if (!company || !ENRICHED_STATUSES.has(String(company.enrichment_status ?? ""))) {
      skipped++;
      continue;
    }

    const payload = jsonParse(activity.payload_json);
    const serviceOfferingId = String(payload.serviceOfferingId ?? "");
    const marketProfileVersionId = String(payload.marketProfileVersionId ?? "");
    if (!offeringIds.has(serviceOfferingId) || !versionIds.has(marketProfileVersionId)) {
      skipped++;
      continue;
    }

    const score = Number(payload.score ?? 0);
    const sourceRunId = String(payload.runId ?? payload.requestId ?? activity.id ?? "legacy_import");
    const id = assessmentId(companyId, serviceOfferingId, marketProfileVersionId, sourceRunId);
    const createdAt = Number(activity.created_at ?? Date.now());
    const summary = String(activity.summary ?? "");
    const band = String(payload.band ?? scoreBand(score));
    const row = {
      id,
      company_id: companyId,
      service_offering_id: serviceOfferingId,
      market_profile_version_id: marketProfileVersionId,
      score,
      band,
      confidence: Number(payload.confidence ?? 0),
      drivers_json: JSON.stringify([{ dimension: "legacy_import", score, reason: summary }]),
      fit_explanation: summary,
      evidence_json: JSON.stringify([]),
      caveats_json: JSON.stringify([]),
      recommended_action: String(payload.recommendedAction ?? ""),
      source_run_id: sourceRunId,
      assessment_json: JSON.stringify({ source: "activity_import", activityId: activity.id, payload }),
      created_at: createdAt,
      updated_at: createdAt,
    };

    if (!dryRun) {
      if (existingIds.has(id)) {
        const { id: _id, ...patch } = row;
        await store.patch("service_fit_assessments", id, patch);
        updated++;
      } else {
        await store.create("service_fit_assessments", row, id);
        existingIds.add(id);
        created++;
      }

      if (!SCORING_DATA_RINGS.has(String(company.data_ring ?? ""))) {
        await store.patch("companies", companyId, { data_ring: "scored", updated_at: Date.now() });
      }
    }
    scoredCompanies.add(companyId);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    activities: activities.length,
    created,
    updated,
    skipped,
    scoredCompanies: scoredCompanies.size,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
