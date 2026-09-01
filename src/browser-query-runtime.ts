import { IndexedDbQueryPersister, KindlingServerState, type QueryScope } from "./server-state.ts";

const serverState = new KindlingServerState(new IndexedDbQueryPersister());

export function configureServerState(scope: QueryScope) { return serverState.setScope(scope); }
export function queryServerState<T>(path: string, fetcher: () => Promise<T>) { return serverState.query(path, fetcher); }
export function invalidateServerState(path?: string) { return serverState.invalidate(path); }
export function purgeServerState(reason: "logout" | "workspace" | "authorization" | "membership" | "schema", all = false) { return serverState.purge(reason, all); }
export function subscribeServerState(listener: (event: { path: string; data: unknown }) => void) { return serverState.subscribe(listener); }
export function serverStateDiagnostics() { return serverState.diagnostics(); }
