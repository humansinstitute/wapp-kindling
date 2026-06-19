import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import {
  APP_NPUB,
  APP_NSEC,
  IS_TOWER_DB_RUNTIME,
  TOWER_URL,
  WORKSPACE_OWNER_NPUB,
} from "./config.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "db", "migrations");

export type TowerMigration = {
  version: string;
  checksum: string;
  sql: string;
};

export type TowerDbClientOptions = {
  towerUrl: string;
  workspaceOwnerNpub: string;
  appNpub: string;
  appNsec: string;
  fetchImpl?: typeof fetch;
};

export class TowerDbClient {
  private readonly towerUrl: string;
  private readonly workspaceOwnerNpub: string;
  private readonly appNpub: string;
  private readonly appSecretKey: Uint8Array;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TowerDbClientOptions) {
    this.towerUrl = options.towerUrl.replace(/\/$/, "");
    this.workspaceOwnerNpub = options.workspaceOwnerNpub;
    this.appNpub = options.appNpub;
    this.appSecretKey = decodeAppSecretKey(options.appNsec);
    const derivedNpub = nip19.npubEncode(getPublicKey(this.appSecretKey));
    if (derivedNpub !== this.appNpub) {
      throw new Error("APP_NPUB does not match APP_NSEC");
    }
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async descriptor() {
    return this.request("GET", "/db/descriptor");
  }

  async provision(appSlug = "kindling") {
    return this.request("POST", "/db/provision", { app_slug: appSlug });
  }

  async migrations() {
    return this.request("GET", "/db/migrations");
  }

  async runMigrations(migrations: TowerMigration[]) {
    return this.request("POST", "/db/migrations", { migrations });
  }

  async createRow(table: string, data: Record<string, unknown>, id?: string) {
    return this.request("POST", `/db/tables/${encodeURIComponent(table)}/rows`, { id, data });
  }

  async queryRows(table: string, input: Record<string, unknown>) {
    return this.request("POST", `/db/tables/${encodeURIComponent(table)}/query`, input);
  }

  async patchRow(table: string, id: string, set: Record<string, unknown>) {
    return this.request("PATCH", `/db/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`, { set });
  }

  async deleteRow(table: string, id: string) {
    return this.request("DELETE", `/db/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(id)}`);
  }

  private apiUrl(path: string) {
    return `${this.towerUrl}/api/v4/workspaces/${encodeURIComponent(this.workspaceOwnerNpub)}/apps/${encodeURIComponent(this.appNpub)}${path}`;
  }

  private async request(method: string, path: string, body?: unknown) {
    const url = this.apiUrl(path);
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers = new Headers({ authorization: this.authorization(url, method, bodyText) });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : bodyText,
    });
    const text = await response.text();
    const payload = text ? parseJson(text) : {};
    if (!response.ok) {
      const message = typeof payload.error === "string" ? payload.error : `Tower DB request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  private authorization(url: string, method: string, bodyText: string) {
    const tags = [
      ["u", url],
      ["method", method],
    ];
    if (["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      tags.push(["payload", bytesToHex(sha256(new TextEncoder().encode(bodyText)))]);
    }
    const event = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    }, this.appSecretKey);
    return `Nostr ${btoa(JSON.stringify(event))}`;
  }
}

export function createTowerDbClientFromEnv(fetchImpl?: typeof fetch) {
  return new TowerDbClient({
    towerUrl: TOWER_URL,
    workspaceOwnerNpub: WORKSPACE_OWNER_NPUB,
    appNpub: APP_NPUB,
    appNsec: APP_NSEC,
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

export async function initializeTowerDbRuntime(client = createTowerDbClientFromEnv(), enabled = IS_TOWER_DB_RUNTIME) {
  if (!enabled) return { mode: "sqlite" as const };
  await client.provision("kindling");
  const migrations = loadTowerMigrations();
  await client.runMigrations(migrations);
  return { mode: "tower" as const, migrationCount: migrations.length };
}

function decodeAppSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Uint8Array.from(Buffer.from(trimmed, "hex"));
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") return decoded.data;
  }
  throw new Error("APP_NSEC must be a hex private key or nsec");
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
