#!/usr/bin/env bun

import { runAutoEnrichNextIndustry } from "../src/auto-enrichment-job.ts";

function parseArgs(args: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--no-dm") {
      parsed.noDm = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed[token.slice(2)] = true;
      continue;
    }
    parsed[token.slice(2)] = value;
    i += 1;
  }
  return parsed;
}

const args = parseArgs(Bun.argv.slice(2));

if (args.help === true || args.h === true) {
  console.log(`Usage: bun scripts/auto-enrich-next-industry.ts [options]

Options:
  --public-origin <url>           Public Kindling URL for webhooks
  --autopilot-url <url>           Autopilot API base URL
  --pipeline-run-base-url <url>   Pipeline run link base URL
  --dm-channel <id>               Flight Deck DM channel id
  --limit <number>                Max companies to queue, capped at 21
  --no-dm                         Do not send the Flight Deck DM
  --help                          Show this help text`);
  process.exit(0);
}

runAutoEnrichNextIndustry({
  batchLimit: args.limit ? Number(args.limit) : undefined,
  publicOrigin: typeof args["public-origin"] === "string" ? args["public-origin"] : undefined,
  autopilotUrl: typeof args["autopilot-url"] === "string" ? args["autopilot-url"] : undefined,
  pipelineRunBaseUrl: typeof args["pipeline-run-base-url"] === "string" ? args["pipeline-run-base-url"] : undefined,
  dmChannelId: typeof args["dm-channel"] === "string" ? args["dm-channel"] : undefined,
  sendDm: args.noDm !== true,
}).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
