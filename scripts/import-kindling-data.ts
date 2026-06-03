#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { finalizeEvent, nip19 } from "nostr-tools";

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function secretKeyHex() {
  let value = process.env.KINDLING_IMPORT_NSEC || process.env.WINGMAN_NSEC || process.env.WINGMAN_PRIV || "";
  value = value.trim().replace(/^['"]|['"]$/g, "");
  if (/^[0-9a-f]{64}$/i.test(value)) return value;
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type === "nsec") return Buffer.from(decoded.data).toString("hex");
  }
  throw new Error("Set KINDLING_IMPORT_NSEC, WINGMAN_NSEC, or WINGMAN_PRIV to a hex key or nsec.");
}

function nip98Authorization(url: string, method: string, bodyText: string) {
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method],
      ["payload", bytesToHex(sha256(new TextEncoder().encode(bodyText)))],
    ],
    content: "",
  }, hexToBytes(secretKeyHex()));
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

const inputPath = argValue("--in");
const targetBase = argValue("--target").replace(/\/$/, "");
const signBase = (argValue("--sign-url", targetBase) || targetBase).replace(/\/$/, "");

if (!inputPath || !targetBase) {
  console.error("Usage: bun scripts/import-kindling-data.ts --in data/kindling-export.json --target https://kindling-host [--sign-url http://kindling-host]");
  process.exit(2);
}

const bodyText = readFileSync(inputPath, "utf8");
const targetUrl = `${targetBase}/api/nip98/kindling/import`;
const signUrl = `${signBase}/api/nip98/kindling/import`;
const response = await fetch(targetUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: nip98Authorization(signUrl, "POST", bodyText),
  },
  body: bodyText,
});
const text = await response.text();
if (!response.ok) {
  throw new Error(`Import failed (${response.status}): ${text}`);
}
console.log(text);
