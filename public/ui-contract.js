export const BACKEND_SELECTION_STORAGE_KEY = "kindling_backend_selections_v1";
export const MAX_BACKEND_SELECTIONS = 16;

export function workspaceIdentity(me) {
  const workspace = me?.workspace || me?.workspaces?.[0] || {};
  return String(me?.workspaceId || me?.workspace_id || workspace.id || "").trim();
}

export function effectiveRole(me) {
  return String(me?.role || me?.membership?.role || me?.workspaceRole || "viewer").toLowerCase();
}

export function canEditOfferings(me) {
  return ["owner", "admin", "contributor"].includes(effectiveRole(me));
}

export function canAdminBackend(me) {
  return ["owner", "admin"].includes(effectiveRole(me));
}

export function normalizeOfferings(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.offerings) ? payload.offerings : [];
  return items.filter((item) => item && typeof item === "object" && item.id).map((item) => ({
    ...item,
    name: String(item.name || "Untitled offering"),
    currentVersion: Number(item.currentVersion || item.version?.version || 0),
    version: item.version && typeof item.version === "object" ? item.version : null,
  }));
}

export function validateOfferingInput(name, brief) {
  const errors = {};
  if (!String(name || "").trim()) errors.name = "Enter a name for the offering.";
  if (!String(brief || "").trim()) errors.brief = "Describe the offering before saving.";
  if (String(name || "").trim().length > 160) errors.name = "Keep the name to 160 characters or fewer.";
  if (String(brief || "").trim().length > 20_000) errors.brief = "Keep the brief to 20,000 characters or fewer.";
  return errors;
}

export function draftSpecification(brief) {
  return { summary: String(brief || "").trim(), sourcePrompt: String(brief || "").trim(), source: "user_draft" };
}

export function offeringMutationRequest(offering, name, brief) {
  return {
    path: offering?.id ? `/api/kindling/value-propositions/${encodeURIComponent(offering.id)}` : "/api/kindling/value-propositions",
    method: offering?.id ? "PATCH" : "POST",
    body: { name: String(name || "").trim(), specification: draftSpecification(brief), approvalState: "draft" },
  };
}

export function readBackendSelections(storageValue, allowedOrigins) {
  try {
    const parsed = JSON.parse(storageValue || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const allowed = new Set(allowedOrigins || []);
    return Object.fromEntries(Object.entries(parsed).filter(([workspaceId, origin]) => workspaceId && allowed.has(origin)).slice(-MAX_BACKEND_SELECTIONS));
  } catch {
    return {};
  }
}

export function updateBackendSelections(current, workspaceId, origin) {
  const entries = Object.entries({ ...(current || {}), [workspaceId]: origin }).filter(([key, value]) => key && typeof value === "string");
  return Object.fromEntries(entries.slice(-MAX_BACKEND_SELECTIONS));
}

export function selectedBackendForWorkspace(storageValue, workspaceId, allowedOrigins, defaultOrigin) {
  if (!workspaceId) return defaultOrigin;
  return readBackendSelections(storageValue, allowedOrigins)[workspaceId] || defaultOrigin;
}

export function normalizeResults(payload, fallback = {}) {
  return {
    tab: String(payload?.tab || fallback.tab || "waiting"),
    items: Array.isArray(payload?.items) ? payload.items : [],
    total: Number(payload?.total || 0),
    returned: Number(payload?.returned ?? payload?.items?.length ?? 0),
    limit: Number(payload?.limit || fallback.limit || 25),
    offset: Number(payload?.offset || fallback.offset || 0),
    counts: payload?.counts && typeof payload.counts === "object" ? payload.counts : { waiting: 0, no_response: 0, meeting: 0, rejected: 0, snoozed: 0 },
  };
}
