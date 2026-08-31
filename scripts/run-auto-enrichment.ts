#!/usr/bin/env bun
// One enrichment tick: starts the next industry-segment batch (up to 21
// companies per run) via the existing auto-enrichment job. Self-guards to one
// active batch at a time, so it is safe to tick on a short interval.

import { runAutoEnrichNextIndustry } from "../src/auto-enrichment-job.ts";

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

const publicOrigin = argValue("--origin", process.env.KINDLING_PUBLIC_ORIGIN || "http://localhost:43001");
const autopilotUrl = argValue("--autopilot-url", process.env.KINDLING_AUTOPILOT_URL || "http://localhost:3600");
const userNpub = argValue("--user-npub", process.env.KINDLING_USER_NPUB || "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy");
const sendDm = Bun.argv.includes("--send-dm");

const result = await runAutoEnrichNextIndustry({
  publicOrigin,
  autopilotUrl,
  userNpub,
  sendDm,
});

console.log(JSON.stringify(result, null, 2));
