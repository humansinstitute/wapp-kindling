import { QueryClient } from "@tanstack/query-core";

export interface QueryScope {
  userId: string;
  organisationId: string;
  workspaceId: string;
  apiVersion: string;
  schemaVersion: string;
  backendOrigin: string;
  membershipVersion?: string;
  role?: string;
}

export interface PersistedQuery<T = unknown> {
  id: string;
  scopeId: string;
  queryKey: readonly unknown[];
  data: T;
  dataUpdatedAt: number;
  etag?: string;
  rowVersion?: string | number;
  bytes: number;
}

export interface QueryPersister {
  get(id: string): Promise<PersistedQuery | null>;
  put(entry: PersistedQuery): Promise<void>;
  deleteScope(scopeId?: string): Promise<void>;
  available(): Promise<boolean>;
}

export class MemoryQueryPersister implements QueryPersister {
  readonly entries = new Map<string, PersistedQuery>();
  async get(id: string) { return this.entries.get(id) ?? null; }
  async put(entry: PersistedQuery) { this.entries.set(entry.id, structuredClone(entry)); }
  async deleteScope(scopeId?: string) {
    if (!scopeId) return void this.entries.clear();
    for (const [id, entry] of this.entries) if (entry.scopeId === scopeId) this.entries.delete(id);
  }
  async available() { return true; }
}

export class IndexedDbQueryPersister implements QueryPersister {
  constructor(
    private readonly databaseName = "kindling-query-cache-v1",
    private readonly maxEntries = 64,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore("queries", { keyPath: "id" });
        store.createIndex("scopeId", "scopeId");
        store.createIndex("dataUpdatedAt", "dataUpdatedAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("queries", mode);
      operation(tx.objectStore("queries"), resolve, reject);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => db.close();
    });
  }

  async get(id: string): Promise<PersistedQuery | null> {
    return this.transaction("readonly", (store, resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async put(entry: PersistedQuery): Promise<void> {
    if (entry.bytes > this.maxBytes / 2) return;
    await this.transaction<void>("readwrite", (store, resolve, reject) => {
      const put = store.put(entry);
      put.onerror = () => reject(put.error);
      const all = store.index("dataUpdatedAt").getAll();
      all.onsuccess = () => {
        const entries = (all.result as PersistedQuery[]).sort((a, b) => b.dataUpdatedAt - a.dataUpdatedAt);
        let bytes = 0;
        entries.forEach((value, index) => {
          bytes += value.bytes;
          if (index >= this.maxEntries || bytes > this.maxBytes) store.delete(value.id);
        });
        resolve();
      };
      all.onerror = () => reject(all.error);
    }).catch(() => undefined);
  }

  async deleteScope(scopeId?: string): Promise<void> {
    await this.transaction<void>("readwrite", (store, resolve, reject) => {
      if (!scopeId) {
        const clear = store.clear();
        clear.onsuccess = () => resolve();
        clear.onerror = () => reject(clear.error);
        return;
      }
      const cursor = store.index("scopeId").openCursor(IDBKeyRange.only(scopeId));
      cursor.onsuccess = () => {
        const value = cursor.result;
        if (!value) return resolve();
        value.delete();
        value.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    }).catch(() => undefined);
  }

  async available(): Promise<boolean> {
    try { const db = await this.open(); db.close(); return true; } catch { return false; }
  }
}

function stableParams(url: URL): string {
  return [...url.searchParams.entries()].sort(([aKey, a], [bKey, b]) => aKey.localeCompare(bKey) || a.localeCompare(b)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

export function scopeId(scope: QueryScope): string {
  return [scope.userId, scope.organisationId, scope.workspaceId, scope.backendOrigin, scope.apiVersion, scope.schemaVersion, scope.membershipVersion ?? "", scope.role ?? ""].map(encodeURIComponent).join("|");
}

export function serverQueryKey(scope: QueryScope, requestPath: string): readonly unknown[] {
  const url = new URL(requestPath, "https://kindling.invalid");
  return ["kindling", scope.userId, scope.organisationId, scope.workspaceId, scope.backendOrigin, scope.apiVersion, scope.schemaVersion, scope.membershipVersion ?? "", scope.role ?? "", url.pathname, stableParams(url)];
}

function queryId(key: readonly unknown[]): string { return JSON.stringify(key); }

function metadata(data: unknown): Pick<PersistedQuery, "etag" | "rowVersion"> {
  const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const rowVersion = value.row_version ?? value.rowVersion ?? value.updated_at ?? value.updatedAt;
  return {
    ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
    ...(typeof rowVersion === "string" || typeof rowVersion === "number" ? { rowVersion } : {}),
  };
}

export class KindlingServerState {
  readonly queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 10 * 60 * 1000, staleTime: 20_000 } } });
  private scope: QueryScope | null = null;
  private readonly listeners = new Set<(event: { path: string; data: unknown }) => void>();

  constructor(private readonly persister: QueryPersister) {}

  async setScope(next: QueryScope): Promise<void> {
    const previous = this.scope;
    const identityChanged = previous && scopeId(previous) !== scopeId(next);
    const schemaChanged = previous && previous.schemaVersion !== next.schemaVersion;
    if (identityChanged) {
      this.queryClient.clear();
      if (schemaChanged) await this.persister.deleteScope();
    }
    this.scope = { ...next };
  }

  currentScope(): QueryScope | null { return this.scope ? { ...this.scope } : null; }

  subscribe(listener: (event: { path: string; data: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async purge(reason: "logout" | "workspace" | "authorization" | "membership" | "schema", all = false): Promise<void> {
    const current = this.scope;
    this.queryClient.clear();
    await this.persister.deleteScope(all || reason === "schema" ? undefined : current ? scopeId(current) : undefined);
    if (["logout", "authorization", "membership"].includes(reason)) this.scope = null;
  }

  private async store<T>(key: readonly unknown[], data: T, updatedAt = Date.now()): Promise<void> {
    if (!this.scope) return;
    const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (Array.isArray(record.companies) && record.companies.length > 100) return;
    const encoded = JSON.stringify(data);
    await this.persister.put({ id: queryId(key), scopeId: scopeId(this.scope), queryKey: key, data, dataUpdatedAt: updatedAt, bytes: new Blob([encoded]).size, ...metadata(data) });
  }

  async query<T>(path: string, fetcher: () => Promise<T>): Promise<T> {
    if (!this.scope) return fetcher();
    const key = serverQueryKey(this.scope, path);
    let cached = this.queryClient.getQueryData<T>(key);
    if (cached === undefined) {
      const persisted = await this.persister.get(queryId(key)).catch(() => null);
      if (persisted?.scopeId === scopeId(this.scope)) {
        cached = persisted.data as T;
        this.queryClient.setQueryData(key, cached, { updatedAt: persisted.dataUpdatedAt });
      }
    }
    const live = async () => {
      try {
        const data = await fetcher();
        await this.store(key, data);
        return data;
      } catch (error) {
        const status = Number((error as { status?: number })?.status ?? 0);
        if (status === 401 || status === 403) {
          const deniedScope = this.scope;
          this.scope = null;
          await this.persister.deleteScope(deniedScope ? scopeId(deniedScope) : undefined);
          setTimeout(() => this.queryClient.clear(), 0);
        }
        throw error;
      }
    };
    if (cached !== undefined) {
      void this.queryClient.fetchQuery({ queryKey: key, queryFn: live, staleTime: 0 }).then((data) => {
        for (const listener of this.listeners) listener({ path, data });
      }).catch(() => undefined);
      return cached;
    }
    return this.queryClient.fetchQuery({ queryKey: key, queryFn: live });
  }

  async invalidate(pathPrefix = "/api/kindling"): Promise<void> {
    await this.queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[9] ?? "").startsWith(pathPrefix) });
    if (this.scope) await this.persister.deleteScope(scopeId(this.scope));
  }

  diagnostics() { return { scoped: Boolean(this.scope), inMemoryQueries: this.queryClient.getQueryCache().getAll().length }; }
}
