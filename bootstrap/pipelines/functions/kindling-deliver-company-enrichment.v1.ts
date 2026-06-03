export const name = "kindling.deliverCompanyEnrichment";
export const description = "Normalise a Kindling company-enrichment agent result and deliver it to the configured WApp webhook.";
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

function buildPayload(input: JsonObject): JsonObject {
  const draft = objectValue(input.enrichmentDraft);
  const companyId = text(draft.companyId, text(input.companyId));
  const companyName = text(draft.companyName, text(input.companyName));
  const profilePatch = objectValue(draft.profilePatch);
  const fieldsUpdated = arrayValue(draft.fieldsUpdated).map(normaliseFieldUpdate).filter((item) => text(item.field));

  return {
    requestId: text(input.requestId),
    role: "enrich_company",
    status: "ok",
    stub: false,
    generatedAt: new Date().toISOString(),
    response: text(
      draft.response,
      companyName ? `Enriched ${companyName} with ${fieldsUpdated.length} field updates.` : "Completed company enrichment pass.",
    ),
    result: {
      outputKind: "company_enrichment",
      companyId,
      companyName,
      profilePatch,
      fieldsUpdated,
      sources: arrayValue(draft.sources).map(normaliseSource).filter((source) => text(source.url) || text(source.summary)),
      activities: arrayValue(draft.activities).map(objectValue),
      confidence: confidence(draft.confidence),
      gaps: stringArray(draft.gaps),
      warnings: stringArray(draft.warnings),
    },
    metadata: {
      source: "kindling-company-enrichment-pipeline",
      pipelineRole: "enrich_company",
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
    throw new Error(`Kindling enrichment webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return { ...payload, webhookDelivered: true, webhookStatus: response.status };
}
