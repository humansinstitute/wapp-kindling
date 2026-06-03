export const name = "kindling.deliverOutreachDraft";
export const description = "Normalise a Kindling outreach-draft agent result and deliver it to the configured WApp webhook.";
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

function buildPayload(input: JsonObject): JsonObject {
  const positioning = objectValue(input.positioning);
  const drafts = [input.draftOne, input.draftTwo, input.draftThree]
    .map((value, index) => normaliseVariant(value, index + 1))
    .filter((variant) => text(variant.body));
  const recommended = drafts[0] ?? normaliseVariant(input.outreachDraft, 1);
  const companyId = text(positioning.companyId, text(input.companyId));
  const companyName = text(positioning.companyName, text(input.companyName));
  const subject = text(recommended.subject, companyName ? `Quick idea for ${companyName}` : "Quick idea");
  const body = text(recommended.body);

  return {
    requestId: text(input.requestId),
    role: "draft_outreach",
    status: "ok",
    stub: false,
    generatedAt: new Date().toISOString(),
    response: text(positioning.response, "Drafted three copyable outreach pitch options."),
    result: {
      outputKind: "outreach_draft",
      companyId,
      companyName,
      positioning: {
        companyOfferingsReview: text(positioning.companyOfferingsReview),
        companyResearchSummary: text(positioning.companyResearchSummary),
        uniqueSellingPoints: stringArray(positioning.uniqueSellingPoints),
        positioningAngles: stringArray(positioning.positioningAngles),
        claimsToAvoid: stringArray(positioning.claimsToAvoid),
        evidenceGaps: stringArray(positioning.evidenceGaps),
        confidence: confidence(positioning.confidence),
      },
      variants: drafts,
      subject,
      body,
      openingLine: text(recommended.openingLine),
      callToAction: text(recommended.callToAction),
      rationale: text(recommended.rationale),
      personalisationInputs: stringArray(positioning.personalisationInputs),
      warnings: [
        ...stringArray(positioning.warnings),
        ...drafts.flatMap((variant) => stringArray(variant.warnings)),
      ],
      confidence: confidence(positioning.confidence),
    },
    metadata: {
      source: "kindling-outreach-draft-pipeline",
      pipelineRole: "draft_outreach",
      stub: false,
    },
  };
}

function normaliseVariant(value: unknown, index: number): JsonObject {
  const draft = objectValue(value);
  return {
    id: text(draft.id, `draft_${index}`),
    label: text(draft.label, `Draft ${index}`),
    strategy: text(draft.strategy),
    subject: text(draft.subject),
    openingLine: text(draft.openingLine),
    body: text(draft.body),
    callToAction: text(draft.callToAction),
    rationale: text(draft.rationale),
    warnings: stringArray(draft.warnings),
    confidence: confidence(draft.confidence),
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
    throw new Error(`Kindling outreach webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return { ...payload, webhookDelivered: true, webhookStatus: response.status };
}
