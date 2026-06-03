export const name = "kindling.deliverTargetScan";
export const description = "Normalise a Kindling target-scan agent result and deliver it to the configured WApp webhook.";
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

function webhookConfig(input: JsonObject): { url: string; authHeader: string; token: string } | null {
  const webhook = objectValue(input.webhook);
  const url = text(webhook.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(webhook.authHeader, "x-kindling-pipeline-token"),
    token: text(webhook.token),
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
  const sources = arrayValue(company.sources).map(normaliseSource).filter((source) => text(source.url) || text(source.summary));
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

function buildPayload(input: JsonObject): JsonObject {
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
      possibleDuplicates: arrayValue(draft.possibleDuplicates).map(normaliseDuplicate),
      searchSlices: arrayValue(draft.searchSlices).map(objectValue),
      activities: arrayValue(draft.activities).map(objectValue),
      warnings: stringArray(draft.warnings),
      confidence: confidence(draft.confidence),
    },
    metadata: {
      source: "kindling-target-scan-pipeline",
      pipelineRole: "scan_target_list",
      stub: false,
    },
  };
}

export default async function run(input: JsonObject) {
  const payload = buildPayload(input);
  const webhook = webhookConfig(input);

  if (!webhook) {
    return { ...payload, webhookDelivered: false, webhookStatus: "not_configured" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (webhook.token) headers[webhook.authHeader] = webhook.token;

  const response = await fetch(webhook.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kindling target scan webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return { ...payload, webhookDelivered: true, webhookStatus: response.status };
}
