#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

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

function requestSelfStop() {
  if (!process.env.SESSION_ID) {
    return { requested: false, reason: "missing_SESSION_ID" };
  }
  if (!process.env.WINGMAN_URL) {
    return { requested: false, reason: "missing_WINGMAN_URL" };
  }

  const result = spawnSync("bun", [
    "/Users/mini/code/wingmanbefree/autopilot/clis/sessions.ts",
    "metadata-update",
    "--next-action",
    "stop",
    "--bot-crypto",
    "--url",
    process.env.WINGMAN_URL,
  ], {
    cwd: "/Users/mini/code/wingmanbefree/autopilot",
    env: process.env,
    encoding: "utf8",
  });

  if ((result.status ?? 0) !== 0) {
    return {
      requested: false,
      reason: "metadata_update_failed",
      error: (result.stderr || result.stdout).trim(),
    };
  }

  return { requested: true };
}

const args = parseArgs(Bun.argv.slice(2));

if (args.help === true || args.h === true) {
  console.log(`Usage: bun scripts/auto-enrich-next-industry-and-stop.ts [options]

Runs the scheduled Kindling auto-enrichment tick, then marks the current
Wingman session nextAction as stop.

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

let exitCode = 0;
let payload: unknown;

try {
  const { runAutoEnrichNextIndustry } = await import("../src/auto-enrichment-job.ts");
  payload = await runAutoEnrichNextIndustry({
    batchLimit: args.limit ? Number(args.limit) : undefined,
    publicOrigin: typeof args["public-origin"] === "string" ? args["public-origin"] : undefined,
    autopilotUrl: typeof args["autopilot-url"] === "string" ? args["autopilot-url"] : undefined,
    pipelineRunBaseUrl: typeof args["pipeline-run-base-url"] === "string" ? args["pipeline-run-base-url"] : undefined,
    dmChannelId: typeof args["dm-channel"] === "string" ? args["dm-channel"] : undefined,
    sendDm: args.noDm !== true,
  });
} catch (error) {
  exitCode = 1;
  payload = {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  const selfStop = requestSelfStop();
  console.log(JSON.stringify({ ...(payload as object), selfStop }, null, 2));
}

process.exit(exitCode);
