export const name = "kindling.deliverServiceAssessment";
export const description = "Normalise a Kindling service-fit assessment and deliver it to the configured WApp write API and webhook.";
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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confidence(value: unknown): number {
  return Math.max(0, Math.min(1, numberValue(value, 0.5)));
}

function scoreValue(value: unknown): number {
  return Math.max(0, Math.min(100, numberValue(value, 0)));
}

function collectionValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return [value];
}

function bandValue(value: unknown, score: number): string {
  const band = text(value).toLowerCase();
  if (band) return band;
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function endpointConfig(value: unknown): { url: string; authHeader: string; token: string } | null {
  const endpoint = objectValue(value);
  const url = text(endpoint.url);
  if (!url) return null;
  return {
    url,
    authHeader: text(endpoint.authHeader, "x-kindling-pipeline-token"),
    token: text(endpoint.token),
  };
}

function buildAssessment(input: JsonObject): JsonObject {
  const draft = objectValue(input.assessmentDraft);
  const localContext = objectValue(input.localContext);
  const score = scoreValue(draft.score);
  return {
    outputKind: "service_fit_assessment",
    companyId: text(draft.companyId, text(input.companyId, text(localContext.companyId))),
    serviceOfferingId: text(draft.serviceOfferingId, text(input.serviceOfferingId, text(localContext.serviceOfferingId))),
    marketProfileVersionId: text(draft.marketProfileVersionId, text(input.marketProfileVersionId, text(localContext.marketProfileVersionId))),
    variantKey: text(draft.variantKey, text(objectValue(localContext.serviceOffering).variantKey)),
    score,
    band: bandValue(draft.band, score),
    confidence: confidence(draft.confidence),
    drivers: collectionValue(draft.drivers),
    fitExplanation: text(draft.fitExplanation, text(draft.explanation)),
    evidence: collectionValue(draft.evidence),
    caveats: collectionValue(draft.caveats ?? draft.warnings),
    recommendedAction: text(draft.recommendedAction, text(draft.nextAction)),
    outreachAngleSeed: text(draft.outreachAngleSeed),
    humanReviewRequired: Boolean(draft.humanReviewRequired),
  };
}

async function postJson(endpoint: { url: string; authHeader: string; token: string }, body: JsonObject) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.token) headers[endpoint.authHeader] = endpoint.token;
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const textBody = await response.text().catch(() => "");
    throw new Error(`Kindling service assessment delivery failed (${response.status}): ${textBody.slice(0, 500)}`);
  }
  return response.status;
}

export default async function run(input: JsonObject) {
  const localContext = objectValue(input.localContext);
  const assessment = buildAssessment(input);
  const requestId = text(input.requestId);
  const payload = {
    requestId,
    role: "score_company_service_fit",
    status: "ok",
    stub: false,
    generatedAt: new Date().toISOString(),
    response: text(input.response, `Scored service fit at ${assessment.score}/100.`),
    result: assessment,
    metadata: {
      source: "kindling-service-fit-assessment-pipeline",
      pipelineRole: "score_company_service_fit",
      stub: false,
    },
  };

  const writeApi = endpointConfig(localContext.writeApi);
  let writeStatus: number | "not_configured" = "not_configured";
  if (writeApi) {
    writeStatus = await postJson(writeApi, {
      requestId,
      result: assessment,
    });
  }

  const webhook = endpointConfig(input.webhook);
  let webhookStatus: number | "not_configured" = "not_configured";
  if (webhook) {
    webhookStatus = await postJson(webhook, payload);
  }

  return { ...payload, writeStatus, webhookStatus };
}
