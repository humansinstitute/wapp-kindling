export const name = "kindling.selectIndustryEnrichmentCompany";
export const description = "Select the current company and strategy checklist for a Kindling industry enrichment loop.";
export const version = 1;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export default function run(input: JsonObject) {
  const loop = objectValue(input.loop);
  const index = Math.max(0, Math.floor(numberValue(loop.index, 0)));
  const companies = arrayValue(input.companies).map(objectValue);
  const company = objectValue(companies[index]);
  return {
    batchId: String(input.batchId ?? input.requestId ?? ""),
    industry: String(input.industry ?? ""),
    company,
    companyIndex: index,
    companyNumber: index + 1,
    batchSize: companies.length,
    enrichmentStrategies: arrayValue(input.enrichmentStrategies).map(objectValue),
    activeProfileVersion: objectValue(input.activeProfileVersion),
    writeApi: objectValue(input.writeApi),
    skipped: !company.id,
  };
}
