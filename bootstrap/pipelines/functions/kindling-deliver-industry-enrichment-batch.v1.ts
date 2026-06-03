export const name = "kindling.deliverIndustryEnrichmentBatch";
export const description = "Deliver a Kindling industry-enrichment batch, writing each completed company back to the WApp as soon as it is ready.";
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

function endpointConfig(value: unknown, fallbackAuthHeader: string): { url: string; authHeader: string; token: string; batchRequestId: string } | null {
  const endpoint = objectValue(value);
  const url = text(endpoint.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(endpoint.authHeader, fallbackAuthHeader),
    token: text(endpoint.token),
    batchRequestId: text(endpoint.batchRequestId),
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

function normaliseFieldUpdate(value: unknown): JsonObject {
  const update = objectValue(value);
  return {
    field: text(update.field),
    value: update.value ?? "",
    previousValue: update.previousValue ?? null,
    confidence: confidence(update.confidence),
    sourceUrl: text(update.sourceUrl),
    reason: text(update.reason),
  };
}

function normaliseEnrichment(value: unknown, fallbackIndustry: string): JsonObject | null {
  const enrichment = objectValue(value);
  const companyId = text(enrichment.companyId ?? enrichment.id);
  if (!companyId) return null;
  const companyName = text(enrichment.companyName ?? enrichment.name);
  const profilePatch = objectValue(enrichment.profilePatch ?? enrichment.profile);
  return {
    companyId,
    companyName,
    response: text(enrichment.response, companyName ? `Enriched ${companyName}.` : "Company enrichment complete."),
    company: {
      id: companyId,
      name: companyName,
      website: text(profilePatch.website ?? enrichment.website),
      dataRing: "enriched",
      enrichmentStatus: "complete",
      confidence: confidence(enrichment.confidence),
      profile: {
        ...profilePatch,
        industry: text(profilePatch.industry, fallbackIndustry),
        fieldsUpdated: arrayValue(enrichment.fieldsUpdated).map(normaliseFieldUpdate).filter((item) => text(item.field)),
        gaps: stringArray(enrichment.gaps),
        warnings: stringArray(enrichment.warnings),
        strategiesCompleted: stringArray(enrichment.strategiesCompleted),
      },
      sources: arrayValue(enrichment.sources).map(normaliseSource).filter((source) => text(source.url) || text(source.summary)),
      sourceSummary: stringArray(enrichment.gaps)[0] || text(enrichment.response),
    },
    strategiesCompleted: stringArray(enrichment.strategiesCompleted),
    gaps: stringArray(enrichment.gaps),
    warnings: stringArray(enrichment.warnings),
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
  const body = await response.json().catch(async () => response.text().catch(() => null));
  if (!response.ok) {
    throw new Error(`Kindling industry enrichment delivery failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`);
  }
  return { delivered: true, status: response.status, body };
}

export default async function run(input: JsonObject) {
  const localContext = objectValue(input.localContext);
  const industry = text(input.industry, text(localContext.industry));
  const batchId = text(input.batchId, text(localContext.batchId, text(input.requestId)));
  const draft = objectValue(input.enrichmentDraft);
  const enrichments = arrayValue(draft.enrichments)
    .map((item) => normaliseEnrichment(item, industry))
    .filter((item): item is JsonObject => Boolean(item));
  const writeApi = endpointConfig(input.writeApi ?? localContext.writeApi, "x-kindling-pipeline-token");

  const deliveredCompanies: JsonObject[] = [];
  if (writeApi) {
    for (const enrichment of enrichments) {
      const company = objectValue(enrichment.company);
      const delivery = await postJson(writeApi, {
        batchRequestId: writeApi.batchRequestId || batchId,
        companyId: text(company.id),
        response: text(enrichment.response),
        company,
      });
      deliveredCompanies.push({
        companyId: text(company.id),
        companyName: text(company.name),
        delivery,
      });
    }
  }

  const payload = {
    requestId: text(input.requestId, batchId),
    role: "enrich_industry_segment",
    roleKey: "enrich_industry_segment",
    status: "complete",
    response: text(
      draft.response,
      `Completed enrichment for ${deliveredCompanies.length || enrichments.length} ${industry || "industry"} companies.`,
    ),
    result: {
      outputKind: "industry_enrichment_batch",
      batchId,
      industry,
      requestedCompanies: arrayValue(localContext.companies).length,
      enrichedCompanies: enrichments.length,
      deliveredCompanies: deliveredCompanies.length,
      managerReview: objectValue(draft.managerReview),
      gaps: stringArray(draft.gaps),
      warnings: stringArray(draft.warnings),
    },
    metadata: {
      source: "kindling-industry-enrichment-pipeline",
      pipelineRole: "enrich_industry_segment",
      stub: false,
    },
  };

  const webhook = endpointConfig(input.webhook, "x-kindling-pipeline-token");
  const webhookResult = webhook ? await postJson(webhook, payload) : { delivered: false, status: "not_configured", body: null };
  return {
    ...payload,
    writeApi: writeApi ? { deliveredCompanies } : { delivered: false, status: "not_configured" },
    webhook: webhookResult,
  };
}
