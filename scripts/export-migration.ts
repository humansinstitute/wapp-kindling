import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(join(import.meta.dir, ".."));
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const bundleName = `kindling-migration-${timestamp}`;
const defaultOutputRoot = resolve(join(repoRoot, "..", "wapp-kindling-migration-bundles"));
const outputRoot = resolve(process.argv.includes("--output")
  ? process.argv[process.argv.indexOf("--output") + 1] || "migration-bundles"
  : defaultOutputRoot);
const includeAuthState = process.argv.includes("--include-auth-state");

const repoPipelineRoot = join(repoRoot, "bootstrap/pipelines");
const pipelineUserRoot = resolve(process.env.KINDLING_PIPELINE_USER_ROOT || (existsSync(repoPipelineRoot)
  ? repoPipelineRoot
  : join(process.env.HOME || "", ".wingmen/pipelines/users/honest-ivory-thicket")));
const liveDbPath = resolve(process.env.KINDLING_DB_PATH || join(repoRoot, "data/chat-wapp.sqlite"));
const bundleRoot = join(outputRoot, bundleName);
const appRoot = join(bundleRoot, "app");
const pipelineRoot = join(bundleRoot, "pipelines/users/honest-ivory-thicket");
const dataRoot = join(bundleRoot, "data");

function run(command: string, args: string[], cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function copyAppSource() {
  cpSync(repoRoot, appRoot, {
    recursive: true,
    filter(source) {
      const rel = relative(repoRoot, source);
      if (!rel) return true;
      const first = rel.split(/[\\/]/)[0];
      if ([".git", "node_modules", "data", "migration-bundles"].includes(first || "")) return false;
      if (basename(source) === ".DS_Store") return false;
      if (basename(source) === ".env") return false;
      return true;
    },
  });
}

function copyKindlingPipelines() {
  for (const subdir of ["definitions", "functions"]) {
    const sourceDir = join(pipelineUserRoot, subdir);
    const targetDir = join(pipelineRoot, subdir);
    mkdirSync(targetDir, { recursive: true });
    for (const file of readdirSync(sourceDir)) {
      if (!file.startsWith("kindling-")) continue;
      cpSync(join(sourceDir, file), join(targetDir, file));
    }
  }
}

function backupDatabase() {
  mkdirSync(dataRoot, { recursive: true });
  if (!existsSync(liveDbPath)) throw new Error(`Kindling DB not found at ${liveDbPath}`);
  const backupPath = join(dataRoot, "chat-wapp.sqlite");
  run("sqlite3", [liveDbPath, `.backup '${backupPath.replaceAll("'", "''")}'`]);
  if (!includeAuthState) {
    run("sqlite3", [backupPath, "DELETE FROM sessions; DELETE FROM login_challenges; VACUUM;"]);
  }
  run("sqlite3", [backupPath, "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA journal_mode=DELETE;"]);
  rmSync(`${backupPath}-wal`, { force: true });
  rmSync(`${backupPath}-shm`, { force: true });
  return backupPath;
}

function sqliteScalar(dbPath: string, sql: string) {
  return run("sqlite3", [dbPath, sql]);
}

function writeManifest(dbPath: string) {
  const kindlingDefinitions = readdirSync(join(pipelineRoot, "definitions")).sort();
  const kindlingFunctions = readdirSync(join(pipelineRoot, "functions")).sort();
  const manifest = {
    name: bundleName,
    generatedAt: new Date().toISOString(),
    sourceHost: process.env.HOSTNAME || "",
    sanitizedAuthState: !includeAuthState,
    contents: {
      appSource: "app/",
      sqliteDatabase: "data/chat-wapp.sqlite",
      pipelineRoot: "pipelines/users/honest-ivory-thicket/",
    },
    counts: {
      companies: Number(sqliteScalar(dbPath, "SELECT COUNT(*) FROM companies;") || 0),
      sources: Number(sqliteScalar(dbPath, "SELECT COUNT(*) FROM sources;") || 0),
      discoveryJobs: Number(sqliteScalar(dbPath, "SELECT COUNT(*) FROM discovery_jobs;") || 0),
      scanStrategies: Number(sqliteScalar(dbPath, "SELECT COUNT(*) FROM scan_strategy_attempts;") || 0),
      accessRules: Number(sqliteScalar(dbPath, "SELECT COUNT(*) FROM access_rules;") || 0),
    },
    appSettings: {
      autopilotUrl: sqliteScalar(dbPath, "SELECT value FROM app_settings WHERE key='autopilotUrl';"),
      defaultPipeline: sqliteScalar(dbPath, "SELECT value FROM app_settings WHERE key='defaultPipeline';"),
    },
    pipelines: {
      definitions: kindlingDefinitions,
      functions: kindlingFunctions,
    },
    installNotes: [
      "Copy app/ to the target server, run bun install, and set .env from .env.example.",
      "Copy data/chat-wapp.sqlite into the target app data/ directory before first start.",
      "Copy pipelines/users/honest-ivory-thicket/definitions and functions into the target Wingman pipeline user root.",
      "Repo-local bootstrap copies live under app/bootstrap/pipelines for normal git-based installs.",
      "Update Kindling Settings -> Autopilot URL to the target Wingman Autopilot base URL and verify pipeline role slugs.",
      "Register/start the WApp through appctl; do not rely on node_modules or PM2 state from this bundle.",
    ],
  };
  writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function writeReadme() {
  writeFileSync(join(bundleRoot, "README-MIGRATION.md"), `# Kindling Migration Bundle

This bundle contains the Kindling WApp source, a SQLite backup of the app data, and the Kindling-specific Autopilot pipeline definitions/functions.

## Restore On Target

1. Copy \`app/\` to the target machine, for example \`~/code/wapp-kindling\`.
2. Copy \`data/chat-wapp.sqlite\` to \`~/code/wapp-kindling/data/chat-wapp.sqlite\`.
3. Copy \`pipelines/users/honest-ivory-thicket/definitions/kindling-*.json\` into the target \`~/.wingmen/pipelines/users/<target-user-alias>/definitions/\`.
4. Copy \`pipelines/users/honest-ivory-thicket/functions/kindling-*.ts\` into the target \`~/.wingmen/pipelines/users/<target-user-alias>/functions/\`.
5. In \`~/code/wapp-kindling\`, run \`bun install\`, configure \`.env\`, then run \`bun test\` and \`bun run check\`.
6. Register/start the WApp through the target Wingman app registry, then open Settings and set the Autopilot URL to the target server.

The database backup omits transient \`sessions\` and \`login_challenges\` unless the exporter was run with \`--include-auth-state\`.
`);
}

function createArchive() {
  mkdirSync(outputRoot, { recursive: true });
  const archivePath = join(outputRoot, `${bundleName}.tar.gz`);
  run("tar", ["-czf", archivePath, "-C", outputRoot, bundleName], repoRoot);
  return archivePath;
}

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });

copyAppSource();
copyKindlingPipelines();
const dbPath = backupDatabase();
writeManifest(dbPath);
writeReadme();
const archivePath = createArchive();
const archiveSize = statSync(archivePath).size;

console.log(JSON.stringify({
  bundleRoot,
  archivePath,
  archiveSize,
  includeAuthState,
}, null, 2));
