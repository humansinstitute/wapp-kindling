export const name = "kindling.finalizeTargetScan";
export const description = "Finalize a looped Kindling target scan and send one WApp webhook after partial writes complete.";
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

function normaliseStrategy(value: unknown, fallbackStatus = "searched"): JsonObject {
  const strategy = objectValue(value);
  return {
    ...strategy,
    industry: text(strategy.industry),
    location: text(strategy.location),
    strategyType: text(strategy.strategyType ?? strategy.strategy, "search"),
    query: text(strategy.query),
    status: text(strategy.status, fallbackStatus),
    resultCount: numberValue(strategy.resultCount ?? strategy.companiesFound, 0),
    notes: text(strategy.notes),
  };
}

function strategyKey(strategy: JsonObject): string {
  return [
    text(strategy.strategyType).toLowerCase(),
    text(strategy.query).toLowerCase(),
    text(strategy.location).toLowerCase(),
    text(strategy.status).toLowerCase(),
  ].join("|");
}

function uniqueStrategies(values: JsonObject[]): JsonObject[] {
  const seen = new Set<string>();
  const out: JsonObject[] = [];
  for (const value of values) {
    const key = strategyKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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
    throw new Error(`Kindling target scan final webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const body = await response.json().catch(() => null);
  return { delivered: true, status: response.status, body };
}

export default async function run(input: JsonObject) {
  const requestId = text(input.requestId);
  const industry = text(input.industry);
  const location = text(input.location);
  const targetCount = Math.max(1, Math.floor(numberValue(input.targetCount, 25)));
  const historyItems = arrayValue(objectValue(input.scanHistory).items).map(objectValue);
  const summaries = historyItems.map((item) => objectValue(item.summary));
  const drafts = historyItems.map((item) => objectValue(item.scanDraft));
  const deliverySummaries = summaries.length ? summaries : historyItems.map((item) => objectValue(item.delivery));
  const deliveries = historyItems.map((item) => objectValue(item.delivery));
  const lastDraft = drafts.at(-1) ?? {};
  const lastDelivery = deliverySummaries.at(-1) ?? deliveries.at(-1) ?? {};
  const persistence = objectValue(lastDelivery.persistence);
  const iterationsCompleted = historyItems.length;
  const matchingCompanies = numberValue(
    persistence.matchingCompanies ?? lastDelivery.matchingCompanies,
    drafts.reduce((total, draft) => total + arrayValue(draft.companies).length, 0),
  );

  const attemptedStrategies = uniqueStrategies((summaries.length ? summaries : drafts).flatMap((item) =>
    arrayValue(item.searchSlices)
      .map((slice) => normaliseStrategy(slice, "searched"))
      .filter((strategy) => text(strategy.status, "searched") !== "planned"),
  ));
  const plannedNextStrategies = uniqueStrategies((summaries.length ? summaries : drafts).flatMap((item) =>
    arrayValue(item.plannedNextStrategies)
      .map((strategy) => normaliseStrategy(strategy, "planned")),
  ));
  const warnings = Array.from(new Set((summaries.length ? summaries : drafts).flatMap((item) => stringArray(item.warnings))));
  const coverageItems = summaries.length ? summaries : drafts;
  const normalisedLocations = Array.from(new Set(coverageItems.flatMap((item) => stringArray(item.normalisedLocations))));
  const industriesCovered = Array.from(new Set(coverageItems.flatMap((item) => stringArray(objectValue(item.coverage).industriesCovered))));
  const locationsCovered = Array.from(new Set(coverageItems.flatMap((item) => stringArray(objectValue(item.coverage).locationsCovered))));
  const targetAchieved = matchingCompanies >= targetCount;
  const status = targetAchieved ? "ok" : "partial";
  const response = targetAchieved
    ? `Target scan reached ${matchingCompanies} companies for ${industry || "the requested industry"} in ${location || "the requested location"} after ${iterationsCompleted} strategy loops.`
    : `Target scan found ${matchingCompanies} companies for ${industry || "the requested industry"} in ${location || "the requested location"} after ${iterationsCompleted} strategy loops; ${Math.max(0, targetCount - matchingCompanies)} remain against the target.`;

  const payload: JsonObject = {
    requestId,
    role: "scan_target_list",
    status,
    stub: false,
    generatedAt: new Date().toISOString(),
    response,
    result: {
      outputKind: "target_scan_result",
      industry: text(lastDraft.industry, text(lastDelivery.industry, industry)),
      location: text(lastDraft.location, text(lastDelivery.location, location)),
      originalRequest: text(input.message),
      normalisedLocations,
      coverage: {
        industriesCovered: industriesCovered.length ? industriesCovered : (industry ? [industry] : []),
        locationsCovered: locationsCovered.length ? locationsCovered : (location ? [location] : []),
        companiesFound: matchingCompanies,
        strategyLoopsCompleted: iterationsCompleted,
      },
      companies: [],
      possibleDuplicates: drafts.flatMap((draft) => arrayValue(draft.possibleDuplicates).map(objectValue)),
      searchSlices: attemptedStrategies,
      plannedNextStrategies,
      activities: (summaries.length ? summaries : drafts).flatMap((item) => arrayValue(item.activities).map(objectValue)),
      warnings,
      confidence: confidence(lastDraft.confidence ?? lastDelivery.confidence),
    },
    metadata: {
      source: "kindling-target-scan-pipeline",
      pipelineRole: "scan_target_list",
      persistence: "partial-writes-final-webhook",
      looped: true,
      iterationsCompleted,
      targetAchieved,
      stub: false,
    },
  };

  const webhook = endpointConfig(input.webhook);
  if (!webhook) {
    return { ...payload, webhook: { delivered: false, status: "not_configured" } };
  }
  const webhookResult = await postJson(webhook, payload);
  return { ...payload, webhook: webhookResult };
}
