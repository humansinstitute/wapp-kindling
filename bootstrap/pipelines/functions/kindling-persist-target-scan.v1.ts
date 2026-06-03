import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "kindling.persistTargetScan";
export const description = "Persist a Kindling target-scan companies JSON artifact and deliver records to the WApp write/webhook path.";
export const version = 1;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function confidence(value: unknown): number {
  return Math.max(0, Math.min(1, numberValue(value, 0.5)));
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).map((item) => text(item)).filter(Boolean);
}

function endpointConfig(value: unknown, fallbackAuthHeader: string): { url: string; authHeader: string; token: string } | null {
  const endpoint = objectValue(value);
  const url = text(endpoint.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(endpoint.authHeader, fallbackAuthHeader),
    token: text(endpoint.token),
  };
}

function normaliseSource(value: unknown): JsonObject {
  const source = objectValue(value);
  return {
    type: text(source.type, "web"),
    url: text(source.url),
    title: text(source.title),
    summary: text(source.summary),
    confidence: confidence(source.confidence),
  };
}

function normaliseCompany(value: unknown, fallbackIndustry: string, fallbackLocation: string): JsonObject | null {
  const company = objectValue(value);
  const name = text(company.name);
  if (!name) return null;
  const sources = arrayValue(company.sources)
    .map(normaliseSource)
    .filter((source) => text(source.url) || text(source.summary));
  return {
    name,
    website: text(company.website),
    industry: text(company.industry, fallbackIndustry),
    location: text(company.location, fallbackLocation),
    dataRing: text(company.dataRing, "discovered"),
    duplicateStatus: text(company.duplicateStatus, "unreviewed"),
    summary: text(company.summary),
    evidence: text(company.evidence),
    sources,
    confidence: confidence(company.confidence),
  };
}

function normaliseDuplicate(value: unknown): JsonObject {
  const duplicate = objectValue(value);
  return {
    companyName: text(duplicate.companyName),
    possibleMatchName: text(duplicate.possibleMatchName),
    reason: text(duplicate.reason),
    confidence: confidence(duplicate.confidence),
  };
}

function artifactPath(requestId: string, suffix = ""): string {
  const safeRequestId = requestId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || `scan-${Date.now()}`;
  const safeSuffix = suffix
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const root = text(
    process.env.KINDLING_PIPELINE_ARTIFACT_DIR,
    join(homedir(), ".wingmen/pipelines/users/honest-ivory-thicket/artifacts/kindling/target-scans"),
  );
  return join(root, `${safeRequestId}${safeSuffix ? `.${safeSuffix}` : ""}.companies.json`);
}

async function postJson(endpoint: { url: string; authHeader: string; token: string }, payload: JsonObject): Promise<{ delivered: boolean; status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.token) headers[endpoint.authHeader] = endpoint.token;
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kindling target scan delivery failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const body = await response.json().catch(() => null);
  return { delivered: true, status: response.status, body };
}

function buildPayload(input: JsonObject, companiesArtifact: JsonObject): JsonObject {
  const draft = objectValue(input.scanDraft);
  const industry = text(draft.industry, text(input.industry));
  const location = text(draft.location, text(input.location));
  const companies = arrayValue(draft.companies)
    .map((company) => normaliseCompany(company, industry, location))
    .filter((company): company is JsonObject => Boolean(company));
  const normalisedLocations = stringArray(draft.normalisedLocations);
  const industriesCovered = stringArray(objectValue(draft.coverage).industriesCovered);
  const locationsCovered = stringArray(objectValue(draft.coverage).locationsCovered);

  return {
    requestId: text(input.requestId),
    role: "scan_target_list",
    status: "ok",
    stub: false,
    generatedAt: new Date().toISOString(),
    response: text(
      draft.response,
      companies.length
        ? `Found ${companies.length} candidate companies for ${industry || "the requested industry"} in ${location || "the requested location"}.`
        : "Prepared a target scan result. No source-backed companies were returned in this pass.",
    ),
    result: {
      outputKind: "target_scan_result",
      industry,
      location,
      originalRequest: text(input.message),
      normalisedLocations,
      coverage: {
        industriesCovered: industriesCovered.length ? industriesCovered : (industry ? [industry] : []),
        locationsCovered: locationsCovered.length ? locationsCovered : (location ? [location] : []),
        companiesFound: companies.length,
      },
      companies,
      companiesArtifact,
      possibleDuplicates: arrayValue(draft.possibleDuplicates).map(normaliseDuplicate),
      searchSlices: arrayValue(draft.searchSlices).map((slice) => {
        const value = objectValue(slice);
        return {
          ...value,
          strategyType: text(value.strategyType ?? value.strategy, "search"),
          resultCount: numberValue(value.resultCount ?? value.companiesFound, 0),
        };
      }).filter((slice) => text(slice.status, "searched") !== "planned"),
      plannedNextStrategies: arrayValue(draft.plannedNextStrategies).map((slice) => {
        const value = objectValue(slice);
        return {
          ...value,
          strategyType: text(value.strategyType ?? value.strategy, "search"),
          status: "planned",
          resultCount: numberValue(value.resultCount ?? value.companiesFound, 0),
        };
      }),
      activities: arrayValue(draft.activities).map(objectValue),
      warnings: stringArray(draft.warnings),
      confidence: confidence(draft.confidence),
    },
    metadata: {
      source: "kindling-target-scan-pipeline",
      pipelineRole: "scan_target_list",
      persistence: "companies-json-and-wapp-callback",
      stub: false,
    },
  };
}

export default async function run(input: JsonObject) {
  const requestId = text(input.requestId);
  const draft = objectValue(input.scanDraft);
  const industry = text(draft.industry, text(input.industry));
  const location = text(draft.location, text(input.location));
  const loop = objectValue(input.loop);
  const loopIteration = Math.max(1, Math.floor(numberValue(loop.iteration, 1)));
  const targetCount = Math.max(1, Math.floor(numberValue(input.targetCount, 25)));
  const maxSearchLoops = Math.max(loopIteration, Math.floor(numberValue(input.maxSearchLoops, numberValue(loop.total, 21))));
  const deliveryMode = text(input.deliveryMode, "final");
  const companies = arrayValue(draft.companies)
    .map((company) => normaliseCompany(company, industry, location))
    .filter((company): company is JsonObject => Boolean(company));
  const path = artifactPath(requestId, deliveryMode === "partial" ? `iteration-${loopIteration}` : "");
  await mkdir(join(path, ".."), { recursive: true });
  const companiesArtifact = {
    path,
    count: companies.length,
    writtenAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify({
    requestId,
    industry,
    location,
    companies,
    possibleDuplicates: arrayValue(draft.possibleDuplicates).map(normaliseDuplicate),
    searchSlices: arrayValue(draft.searchSlices).map(objectValue),
    warnings: stringArray(draft.warnings),
  }, null, 2)}\n`);

  const payload = buildPayload(input, companiesArtifact);
  const writeApi = endpointConfig(input.writeApi ?? objectValue(input.localContext).writeApi, "x-kindling-pipeline-token");
  let writeApiResult: JsonObject = { delivered: false, status: "not_configured", body: null };
  if (writeApi) {
    writeApiResult = await postJson(writeApi, {
      requestId,
      role: "scan_target_list",
      artifact: companiesArtifact,
      companies,
      result: payload.result,
      response: payload.response,
    });
  }
  const persisted = objectValue(objectValue(writeApiResult.body).persisted);
  const matchingCompanies = numberValue(persisted.matchingCompanies, companies.length);
  const targetAchieved = matchingCompanies >= targetCount;
  const nextLoopLimit = targetAchieved ? loopIteration : maxSearchLoops;
  const persistence = {
    companiesArtifact,
    writeApi: writeApiResult,
    webhook: { delivered: false, status: deliveryMode === "partial" ? "deferred" : "not_configured" },
    matchingCompanies,
    targetAchieved,
    nextLoopLimit,
  };

  if (deliveryMode === "partial") {
    return {
      ...payload,
      status: "running",
      deliveryMode,
      persistence,
      matchingCompanies,
      targetAchieved,
      nextLoopLimit,
    };
  }

  const webhook = endpointConfig(input.webhook, "x-kindling-pipeline-token");
  if (!webhook) {
    return { ...payload, persistence };
  }
  const webhookResult = await postJson(webhook, payload);
  return { ...payload, persistence: { ...persistence, webhook: webhookResult } };
}
