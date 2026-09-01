import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const captain = JSON.parse(read("captain-definition")) as { schemaVersion?: number; dockerfilePath?: string };
assert(captain.schemaVersion === 2, "captain-definition must use schemaVersion 2");
assert(captain.dockerfilePath === "./Dockerfile", "captain-definition must point to ./Dockerfile");

const dockerfile = read("Dockerfile");
assert(dockerfile.includes("ENV PORT=80"), "Dockerfile must declare the CapRover container port");
assert(dockerfile.includes("/api/health"), "Dockerfile must health-check /api/health");
assert(!dockerfile.includes("VOLUME [\"/data\"]"), "frontend image must not require a persistent /data mount");
assert(dockerfile.includes('CMD ["bun", "src/saas-server.ts"]'), "production image must use the API-only SaaS server");
assert(!read("src/saas-server.ts").includes("bun:sqlite"), "production server must not import bun:sqlite");

const dockerignore = read(".dockerignore").split(/\r?\n/).map((line) => line.trim());
for (const required of [".env", "node_modules", "data", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm", ".mcp.json"]) {
  assert(dockerignore.includes(required), `.dockerignore must exclude ${required}`);
}

const config = read("src/config.ts");
const server = read("src/saas-server.ts");
assert(config.includes("process.env.PORT"), "server port must come from runtime PORT");
assert(config.includes("process.env.KINDLING_API_URL"), "canonical API URL must come from runtime KINDLING_API_URL");
assert(server.includes("port: PORT"), "Bun server must honor configured PORT");

const tracked = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
assert(tracked.exitCode === 0, "git ls-files failed during secret audit");
const trackedFiles = tracked.stdout.toString().split("\0").filter(Boolean);
const signingEnvName = ["WAPP", "NSEC"].join("_");
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const nsecPattern = /nsec1[023456789acdefghjklmnpqrstuvwxyz]{40,}/i;
for (const file of trackedFiles) {
  let content = "";
  try {
    content = read(file);
  } catch {
    continue;
  }
  assert(!content.includes(`process.env.${signingEnvName}`), `${file} reads the removed raw signing-key environment`);
  assert(!privateKeyPattern.test(content), `${file} contains a private-key block`);
  assert(!nsecPattern.test(content), `${file} contains an nsec-like secret`);
}

for (const browserFile of ["public/app.js", "public/vendor/nostr-signer.js", "public/vendor/query-runtime.js"]) {
  const content = read(browserFile);
  assert(!content.includes(signingEnvName), `${browserFile} mentions a server signing-key environment`);
  assert(!content.includes("KINDLING_API_URL"), `${browserFile} hardcodes the runtime API environment name`);
}

console.log(`Collaborative frontend deployment contract valid (${trackedFiles.length} repository files audited).`);
