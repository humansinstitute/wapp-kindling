#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";

const repoRoot = resolve(join(import.meta.dir, ".."));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const home = process.env.HOME || "/Users/mini";
const defaultAlias = "honest-ivory-thicket";
const defaultSourceRoot = join(home, ".wingmen/pipelines/users", defaultAlias);
const defaultOutputRoot = join(repoRoot, "data");

function argValue(name: string, fallback = "") {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function run(command: string, args: string[], cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listKindlingFiles(dir: string, extension: string) {
  if (!existsSync(dir)) return [];
  return Array.from(new Bun.Glob(`kindling-*.${extension}`).scanSync({ cwd: dir })).sort();
}

function parsePipelineDefinition(path: string) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown; default?: unknown; supersedes?: unknown };
    return {
      name: typeof raw.name === "string" ? raw.name : "",
      version: typeof raw.version === "number" ? raw.version : null,
      default: raw.default === true,
      supersedes: typeof raw.supersedes === "string" ? raw.supersedes : "",
    };
  } catch {
    return { name: "", version: null, default: false, supersedes: "" };
  }
}

function readKindlingPipelineRoles(dbPath: string) {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  return db.query(`
    SELECT role_key, active_pipeline_slug, pipeline_label, enabled, updated_at
    FROM pipeline_roles
    WHERE active_pipeline_slug LIKE 'kindling-%'
    ORDER BY role_key
  `).all();
}

function readKindlingSchedulerJobs(autopilotDbPath: string) {
  if (!existsSync(autopilotDbPath)) return [];
  const db = new Database(autopilotDbPath, { readonly: true });
  return db.query(`
    SELECT id, name, enabled, trigger_type, cron_expression, timezone, action_type,
           pipeline_definition_id, pipeline_input_json, pipeline_agent,
           active_start_time, active_end_time
    FROM scheduled_jobs
    WHERE lower(name) LIKE '%kindling%'
       OR coalesce(pipeline_definition_id, '') LIKE '%kindling%'
       OR coalesce(pipeline_input_json, '') LIKE '%kindling%'
    ORDER BY name
  `).all();
}

const sourceRoot = resolve(argValue("--source-root", defaultSourceRoot));
const outputRoot = resolve(argValue("--out-dir", defaultOutputRoot));
const sourceAlias = basename(sourceRoot);
const bundleName = `kindling-pipelines-${timestamp}`;
const bundleRoot = join(outputRoot, bundleName);
const definitionsSource = join(sourceRoot, "definitions");
const functionsSource = join(sourceRoot, "functions");
const definitionsTarget = join(bundleRoot, "pipelines/users", sourceAlias, "definitions");
const functionsTarget = join(bundleRoot, "pipelines/users", sourceAlias, "functions");
const kindlingDbPath = resolve(argValue("--kindling-db", join(repoRoot, "data/chat-wapp.sqlite")));
const autopilotDbPath = resolve(argValue("--autopilot-db", "/Users/mini/code/wingmanbefree/autopilot/data/wingman.db"));

if (!existsSync(sourceRoot)) {
  throw new Error(`Pipeline source root does not exist: ${sourceRoot}`);
}

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(definitionsTarget, { recursive: true });
mkdirSync(functionsTarget, { recursive: true });

const definitionFiles = listKindlingFiles(definitionsSource, "json");
const functionFiles = listKindlingFiles(functionsSource, "ts");

for (const file of definitionFiles) {
  cpSync(join(definitionsSource, file), join(definitionsTarget, file));
}
for (const file of functionFiles) {
  cpSync(join(functionsSource, file), join(functionsTarget, file));
}

const definitions = definitionFiles.map((file) => ({
  file,
  relativePath: `pipelines/users/${sourceAlias}/definitions/${file}`,
  sha256: sha256(join(definitionsTarget, file)),
  ...parsePipelineDefinition(join(definitionsTarget, file)),
}));
const functions = functionFiles.map((file) => ({
  file,
  relativePath: `pipelines/users/${sourceAlias}/functions/${file}`,
  sha256: sha256(join(functionsTarget, file)),
}));
const definedPipelineNames = new Set(definitions.map((definition) => definition.name).filter(Boolean));
const kindlingPipelineRoles = readKindlingPipelineRoles(kindlingDbPath);
const danglingPipelineRoles = kindlingPipelineRoles.filter((role) => {
  const slug = (role as { active_pipeline_slug?: unknown }).active_pipeline_slug;
  return typeof slug === "string" && !definedPipelineNames.has(slug);
});

const manifest = {
  name: bundleName,
  generatedAt: new Date().toISOString(),
  sourceRoot,
  sourceAlias,
  targetInstallRoot: "~/.wingmen/pipelines/users/<target-alias>",
  definitions,
  functions,
  kindlingPipelineRoles,
  danglingPipelineRoles,
  kindlingSchedulerJobs: readKindlingSchedulerJobs(autopilotDbPath),
  notes: [
    "This bundle migrates pipeline definitions and deterministic pipeline functions only.",
    "It intentionally excludes pipeline run history, callbacks, artifacts, logs, PM2 process state, sessions, secrets, and live scheduler state.",
    "Install by copying definitions/*.json and functions/*.ts into the remote user's ~/.wingmen/pipelines/users/<target-alias>/ folders.",
    "After copying, restart the remote Autopilot service so its pipeline loader sees the new files.",
    "Update Kindling pipeline_roles and scheduler jobs on the remote if the target alias or public URLs differ.",
    "Any danglingPipelineRoles entries are Kindling role rows whose slugs do not have matching live pipeline definitions in this bundle.",
  ],
};

writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(bundleRoot, "README.md"), `# Kindling Pipeline Migration

This bundle contains the live Kindling pipeline definitions and TypeScript pipeline functions from:

\`${sourceRoot}\`

## Install On Remote

1. Copy this bundle to the remote machine.
2. Choose the remote pipeline user alias, for example \`honest-ivory-thicket\`.
3. Copy files:

\`\`\`bash
mkdir -p ~/.wingmen/pipelines/users/<target-alias>/definitions
mkdir -p ~/.wingmen/pipelines/users/<target-alias>/functions
cp pipelines/users/${sourceAlias}/definitions/kindling-*.json ~/.wingmen/pipelines/users/<target-alias>/definitions/
cp pipelines/users/${sourceAlias}/functions/kindling-*.ts ~/.wingmen/pipelines/users/<target-alias>/functions/
\`\`\`

4. Restart Autopilot on the remote, for example:

\`\`\`bash
pm2 restart wm-ap --update-env
\`\`\`

5. In the remote Kindling SQLite/app settings, ensure pipeline role slugs still point at the unversioned Kindling names:
\`kindling-develop-service-offering\`, \`kindling-scan-target-list\`, \`kindling-enrich-company\`, \`kindling-enrich-industry-segment\`, \`kindling-score-company-service-fit\`, and \`kindling-draft-outreach\`.

6. Treat \`manifest.json\` -> \`danglingPipelineRoles\` as non-runnable seed/default rows unless matching definitions are added on the remote.

7. Recreate or update the remote scheduler job for \`kindling-auto-industry-enrichment-tick\` with remote URLs. Do not blindly reuse local \`publicOrigin\`, \`autopilotUrl\`, or DM channel values from \`manifest.json\`.

This bundle does not include historical pipeline runs or artifacts.
`);

mkdirSync(outputRoot, { recursive: true });
const archivePath = join(outputRoot, `${bundleName}.tar.gz`);
run("tar", ["-czf", archivePath, "-C", outputRoot, bundleName]);

console.log(JSON.stringify({
  bundleRoot,
  archivePath,
  archiveSize: statSync(archivePath).size,
  definitions: definitions.length,
  functions: functions.length,
  danglingPipelineRoles: danglingPipelineRoles.length,
}, null, 2));
