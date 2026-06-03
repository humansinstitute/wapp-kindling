export const name = "kindling.finalizeIndustryEnrichmentBatch";
export const description = "Send a final webhook summary for a Kindling industry enrichment batch.";
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

function endpointConfig(value: unknown): { url: string; authHeader: string; token: string } | null {
  const webhook = objectValue(value);
  const url = text(webhook.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(webhook.authHeader, "x-kindling-pipeline-token"),
    token: text(webhook.token),
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
    throw new Error(`Kindling industry enrichment webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return response.status;
}

export default async function run(input: JsonObject) {
  const historyItems = arrayValue(objectValue(input.batchHistory).items).map(objectValue);
  const completed = historyItems.filter((item) => objectValue(item.delivery).status === "complete").length;
  const failed = historyItems.filter((item) => objectValue(item.delivery).status === "failed").length;
  const industry = text(input.industry, "industry segment");
  const batchSize = historyItems.length || arrayValue(input.companies).length;
  const payload = {
    requestId: text(input.requestId),
    role: "enrich_industry_segment",
    status: "complete",
    response: `Industry enrichment batch processed ${batchSize} ${industry} companies: ${completed} complete, ${failed} failed.`,
    result: {
      outputKind: "industry_enrichment_batch",
      industry,
      batchSize,
      completed,
      failed,
      companies: historyItems,
    },
    metadata: {
      source: "kindling-industry-enrichment-pipeline",
      pipelineRole: "enrich_industry_segment",
    },
  };
  const webhook = endpointConfig(input.webhook);
  if (!webhook) return { ...payload, webhookDelivered: false };
  const webhookStatus = await postJson(webhook, payload);
  return { ...payload, webhookDelivered: true, webhookStatus };
}
