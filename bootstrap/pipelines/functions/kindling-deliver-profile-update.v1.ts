export const name = "kindling.deliverProfileUpdate";
export const description = "Normalise a Kindling profile-update agent result and deliver it to the configured WApp webhook.";
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

function normaliseService(value: unknown): JsonObject {
  const service = objectValue(value);
  return {
    name: text(service.name, "Service"),
    description: text(service.description),
    benefits: stringArray(service.benefits),
    proofPoints: stringArray(service.proofPoints),
    targetSegments: stringArray(service.targetSegments),
  };
}

function normaliseAssumption(value: unknown): JsonObject {
  const assumption = objectValue(value);
  return {
    statement: text(assumption.statement),
    confidence: confidence(assumption.confidence),
    needsEvidence: assumption.needsEvidence === true,
  };
}

function normaliseProfilePatch(input: JsonObject, draft: JsonObject): JsonObject {
  const patch = objectValue(draft.profileVersionPatch);
  const localContext = objectValue(input.localContext);
  const activeProfile = objectValue(localContext.activeProfileVersion ?? localContext.activeProfile);
  const sourcePatch = Object.keys(patch).length > 0 ? patch : activeProfile;

  return {
    title: text(sourcePatch.title, text(input.message, "Kindling market profile")),
    summary: text(sourcePatch.summary, "Updated market profile from Kindling service-offering pipeline."),
    positioningStatement: text(sourcePatch.positioningStatement),
    services: arrayValue(sourcePatch.services).map(normaliseService),
    idealCustomerProfile: objectValue(sourcePatch.idealCustomerProfile),
    problemsSolved: stringArray(sourcePatch.problemsSolved),
    buyingTriggers: stringArray(sourcePatch.buyingTriggers),
    differentiators: stringArray(sourcePatch.differentiators),
    outreachVoice: objectValue(sourcePatch.outreachVoice),
    exclusions: stringArray(sourcePatch.exclusions),
    assumptions: arrayValue(sourcePatch.assumptions).map(normaliseAssumption).filter((item) => text(item.statement)),
    confidence: confidence(sourcePatch.confidence ?? draft.confidence),
  };
}

function buildPayload(input: JsonObject): JsonObject {
  const draft = objectValue(input.profileDraft);
  const localContext = objectValue(input.localContext);
  const profileVersionPatch = normaliseProfilePatch(input, draft);
  const response = text(
    draft.response,
    "I updated the service offering profile draft and noted the next questions to tighten it further.",
  );

  return {
    requestId: text(input.requestId),
    role: "develop_service_offering",
    status: "ok",
    stub: false,
    generatedAt: new Date().toISOString(),
    response,
    result: {
      outputKind: "market_profile_update",
      marketProfileId: text(localContext.marketProfileId),
      activeProfileVersionId: text(localContext.activeProfileVersionId),
      profileVersionPatch,
      changeSummary: text(draft.changeSummary, response),
      rationaleNotes: stringArray(draft.rationaleNotes),
      nextQuestions: stringArray(draft.nextQuestions).slice(0, 5),
      evidence: arrayValue(draft.evidence).map(objectValue),
      warnings: stringArray(draft.warnings),
      confidence: confidence(draft.confidence ?? profileVersionPatch.confidence),
    },
    metadata: {
      source: "kindling-profile-update-pipeline",
      pipelineRole: "develop_service_offering",
      stub: false,
    },
  };
}

export default async function run(input: JsonObject) {
  const payload = buildPayload(input);
  const webhook = webhookConfig(input);

  if (!webhook) {
    return {
      ...payload,
      webhookDelivered: false,
      webhookStatus: "not_configured",
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (webhook.token) headers[webhook.authHeader] = webhook.token;

  const response = await fetch(webhook.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kindling profile webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return {
    ...payload,
    webhookDelivered: true,
    webhookStatus: response.status,
  };
}
