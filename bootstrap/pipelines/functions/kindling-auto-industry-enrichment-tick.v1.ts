export const name = "kindling.autoIndustryEnrichmentTick";
export const description = "Select the next Kindling industry batch and start the industry enrichment pipeline.";
export const version = 1;

type JsonObject = Record<string, unknown>;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown): string | undefined {
  const next = text(value);
  return next || undefined;
}

function numberValue(value: unknown): number | undefined {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

export default async function run(input: JsonObject) {
  const { runAutoEnrichNextIndustry } = await import("/Users/mini/code/wapp-kindling/src/auto-enrichment-job.ts");
  const result = await runAutoEnrichNextIndustry({
    batchLimit: numberValue(input.batchLimit ?? input.limit),
    publicOrigin: optionalText(input.publicOrigin),
    autopilotUrl: optionalText(input.autopilotUrl),
    pipelineRunBaseUrl: optionalText(input.pipelineRunBaseUrl),
    dmChannelId: optionalText(input.dmChannelId),
    sendDm: booleanValue(input.sendDm, true),
    userNpub: optionalText(input.userNpub),
  });

  return {
    ...result,
    source: "kindling-auto-industry-enrichment-tick",
    checkedAt: text(result.checkedAt, new Date().toISOString()),
  };
}
