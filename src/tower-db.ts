import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  WAPP_TOWER_DB_BROKER_URL,
  WAPP_TOWER_DB_CAPABILITY,
  isTowerDbRuntime,
} from "./config.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "db", "migrations");

export type TowerMigration = {
  version: string;
  checksum: string;
  sql: string;
};

export type TowerDbClientOptions = {
  brokerUrl: string;
  capability: string;
  fetchImpl?: typeof fetch;
};

export class TowerDbError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "TowerDbError";
    this.status = status;
    this.payload = payload;
  }
}

export class TowerDbClient {
  private readonly brokerUrl: string;
  private readonly capability: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TowerDbClientOptions) {
    this.brokerUrl = normalizeLoopbackBrokerUrl(options.brokerUrl);
    this.capability = options.capability.trim();
    if (!this.capability) throw new Error("WAPP_TOWER_DB_CAPABILITY is required for Tower DB runtime");
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async descriptor() {
    throw new Error("Tower DB descriptor is not exposed by the installation-scoped broker");
  }

  async provision(appSlug = "kindling") {
    return this.request("POST", "/provision", { app_slug: appSlug });
  }

  async migrations() {
    return this.request("GET", "/migrations");
  }

  async runMigrations(migrations: TowerMigration[]) {
    return this.request("POST", "/migrations", { migrations });
  }

  async createRow(table: string, data: Record<string, unknown>, id?: string) {
    return this.request("POST", `/tables/${encodeURIComponent(table)}/rows`, { id, data });
  }

  async getRow(table: string, id: string) {
    return this.request("GET", `/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`);
  }

  async queryRows(table: string, input: Record<string, unknown>) {
    return this.request("POST", `/tables/${encodeURIComponent(table)}/query`, input);
  }

  async patchRow(table: string, id: string, set: Record<string, unknown>) {
    return this.request("PATCH", `/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`, { set });
  }

  async deleteRow(table: string, id: string) {
    return this.request("DELETE", `/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`);
  }

  private async request(method: string, path: string, body?: unknown) {
    const brokerRequest = body === undefined ? { method, path } : { method, path, body };
    const response = await this.fetchImpl(this.brokerUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(brokerRequest),
    });
    const text = await response.text();
    const payload = text ? parseJson(text) : {};
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Tower DB request failed with HTTP ${response.status}`;
      throw new TowerDbError(message, response.status, payload);
    }
    return payload;
  }
}

export function createTowerDbClientFromEnv(fetchImpl?: typeof fetch) {
  return new TowerDbClient({
    brokerUrl: WAPP_TOWER_DB_BROKER_URL,
    capability: WAPP_TOWER_DB_CAPABILITY,
    fetchImpl,
  });
}

export function loadTowerMigrations(): TowerMigration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const version = name.replace(/\.sql$/, "");
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return { version, sql, checksum: `sha256:${bytesToHex(sha256(new TextEncoder().encode(sql)))}` };
    });
}

export async function initializeTowerDbRuntime(client?: Pick<TowerDbClient, "provision" | "runMigrations">, enabled = isTowerDbRuntime()) {
  if (!enabled) return { mode: "sqlite" as const };
  const towerClient = client ?? createTowerDbClientFromEnv();
  await towerClient.provision("kindling");
  const migrations = loadTowerMigrations();
  await towerClient.runMigrations(migrations);
  return { mode: "tower" as const, migrationCount: migrations.length };
}

function normalizeLoopbackBrokerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("WAPP_TOWER_DB_BROKER_URL must be a valid loopback URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("WAPP_TOWER_DB_BROKER_URL must use loopback HTTP");
  }
  return parsed.toString();
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
