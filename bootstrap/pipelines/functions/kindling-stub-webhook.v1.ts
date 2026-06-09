export const name = "kindling.stubWebhook";
export const description = "Return a Kindling WApp stub result and deliver it to the configured WApp webhook.";
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

function nowIso(): string {
  return new Date().toISOString();
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

function baseResult(input: JsonObject) {
  const role = text(input.pipelineRole, "unknown");
  const requestId = text(input.requestId);
  return {
    requestId,
    role,
    status: "ok",
    stub: true,
    generatedAt: nowIso(),
  };
}

function roleResult(input: JsonObject): JsonObject {
  const base = baseResult(input);
  const role = base.role;
  const localContext = objectValue(input.localContext);

  if (role === "develop_service_offering") {
    return {
      ...base,
      response: "Stub service-offering pipeline accepted the request and returned a profile update placeholder.",
      result: {
        outputKind: "market_profile_update",
        profileVersionPatch: {
          title: text(input.message, "Draft service offering"),
          summary: "Stub profile update. Replace with interview, synthesis, and versioning steps.",
          services: [],
          idealCustomerProfile: {},
          assumptions: [],
          confidence: 0.1,
        },
        nextQuestions: [
          "What customer segment should this offer prioritise first?",
          "What proof or case material should the profile use?",
        ],
      },
    };
  }

  if (role === "scan_target_list") {
    return {
      ...base,
      response: "Stub target-list scan accepted the request and returned a discovery-job placeholder.",
      result: {
        outputKind: "target_scan_result",
        industry: text(input.industry ?? localContext.industry),
        location: text(input.location ?? localContext.location),
        originalRequest: text(input.message),
        normalisedLocations: [],
        coverage: {
          industriesCovered: [],
          locationsCovered: [],
          companiesFound: 0,
        },
        companies: [],
        possibleDuplicates: [],
      },
    };
  }

  if (role === "enrich_company") {
    return {
      ...base,
      response: "Stub enrichment pipeline accepted the request and returned an enrichment placeholder.",
      result: {
        outputKind: "company_enrichment",
        companyId: text(input.companyId),
        companyName: text(input.companyName),
        fieldsUpdated: [],
        sources: [],
        confidence: 0.1,
        gaps: ["Real enrichment steps are not configured yet."],
      },
    };
  }

  if (role === "score_company_service_fit") {
    return {
      ...base,
      response: "Stub service-fit pipeline accepted the request and returned a placeholder assessment.",
      result: {
        outputKind: "service_fit_assessment",
        companyId: text(input.companyId, text(localContext.companyId)),
        serviceOfferingId: text(input.serviceOfferingId, text(localContext.serviceOfferingId)),
        marketProfileVersionId: text(input.marketProfileVersionId, text(localContext.marketProfileVersionId)),
        variantKey: text(objectValue(localContext.serviceOffering).variantKey),
        score: 50,
        band: "medium",
        confidence: 0.1,
        drivers: [{ dimension: "service_fit", score: 50, reason: "Stub output only." }],
        fitExplanation: "Stub service-fit assessment. Replace with evidence-backed company x offering scoring.",
        evidence: [],
        caveats: ["Real service-fit scoring steps are not configured yet."],
        recommendedAction: "Run the real scoring pipeline before using this assessment.",
      },
    };
  }

  if (role === "draft_outreach") {
    const companyName = text(input.companyName, "this company");
    return {
      ...base,
      response: "Stub outreach pipeline accepted the request and returned a copyable draft placeholder.",
      result: {
        outputKind: "outreach_draft",
        companyId: text(input.companyId),
        companyName,
        subject: `Quick idea for ${companyName}`,
        body: `Hi, this is a stub Kindling outreach draft for ${companyName}. Replace this with a profile-aware pitch generated from the selected company record and active service offering.`,
        rationale: "Stub output only. Replace with fit analysis and pitch drafting steps.",
        confidence: 0.1,
      },
    };
  }

  return {
    ...base,
    response: "Stub Kindling pipeline accepted the request.",
    result: {
      outputKind: "generic_stub",
      receivedKeys: Object.keys(input).sort(),
      itemCount: arrayValue(input.items).length,
    },
  };
}

export default async function run(input: JsonObject) {
  const payload = roleResult(input);
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
    body: JSON.stringify({
      ...payload,
      metadata: {
        source: "kindling-stub-pipeline",
        pipelineRole: payload.role,
        stub: true,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kindling webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return {
    ...payload,
    webhookDelivered: true,
    webhookStatus: response.status,
  };
}
