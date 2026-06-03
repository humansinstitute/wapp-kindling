export const name = "kindling.deliverIndustryEnrichmentCompany";
export const description = "Deliver one company result from a Kindling industry enrichment batch to the WApp write API.";
export const version = 1;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
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

function endpointConfig(value: unknown): { url: string; authHeader: string; token: string; batchRequestId: string } | null {
  const endpoint = objectValue(value);
  const url = text(endpoint.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(endpoint.authHeader, "x-kindling-pipeline-token"),
    token: text(endpoint.token),
    batchRequestId: text(endpoint.batchRequestId),
  };
}

async function postJson(endpoint: { url: string; authHeader: string; token: string }, payload: JsonObject) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.token) headers[endpoint.authHeader] = endpoint.token;
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kindling enrichment write failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return response.json().catch(() => null);
}

export default async function run(input: JsonObject) {
  const selected = objectValue(input.selected);
  const company = objectValue(selected.company);
  const draft = objectValue(input.enrichmentDraft);
  const manager = objectValue(input.managerReview);
  const approved = manager.approved !== false;
  const companyId = text(draft.companyId, text(company.id));
  const companyName = text(draft.companyName, text(company.name));
  const profilePatch = objectValue(draft.profilePatch);
  const response = text(
    draft.response,
    approved ? `Enriched ${companyName || companyId}.` : `Enrichment incomplete for ${companyName || companyId}.`,
  );
  const sources = arrayValue(draft.sources).map(normaliseSource).filter((source) => text(source.url) || text(source.summary));
  const strategyCoverage = arrayValue(manager.strategyCoverage).map(objectValue);
  const warnings = [
    ...arrayValue(draft.warnings).map((item) => text(item)).filter(Boolean),
    ...arrayValue(manager.warnings).map((item) => text(item)).filter(Boolean),
  ];
  const gaps = [
    ...arrayValue(draft.gaps).map((item) => text(item)).filter(Boolean),
    ...arrayValue(manager.missingStrategies).map((item) => text(item)).filter(Boolean),
  ];
  const records = {
    company: {
      id: companyId,
      name: companyName,
      website: text(profilePatch.website, text(company.website)),
      dataRing: approved ? "enriched" : text(company.dataRing, "seed"),
      enrichmentStatus: approved ? "complete" : "failed",
      confidence: confidence(draft.confidence),
      profile: {
        ...profilePatch,
        fieldsUpdated: arrayValue(draft.fieldsUpdated).map(objectValue),
        activities: arrayValue(draft.activities).map(objectValue),
        strategyCoverage,
        managerApproved: approved,
        managerSummary: text(manager.summary),
        gaps,
        warnings,
      },
      sources,
      sourceSummary: sources[0] ? text(sources[0].summary, text(sources[0].title)) : response,
    },
  };
  const writeApi = endpointConfig(selected.writeApi ?? input.writeApi);
  let writeResult: unknown = { ok: false, status: "not_configured" };
  if (writeApi) {
    writeResult = await postJson(writeApi, {
      batchRequestId: writeApi.batchRequestId || text(selected.batchId, text(input.requestId)),
      companyId,
      response,
      records,
    });
  }
  return {
    companyId,
    companyName,
    status: approved ? "complete" : "failed",
    approved,
    response,
    sourcesWritten: sources.length,
    strategyCoverage,
    gaps,
    warnings,
    writeResult,
  };
}
