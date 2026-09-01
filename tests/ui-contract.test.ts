import { describe, expect, test } from "bun:test";
import {
  MAX_BACKEND_SELECTIONS,
  canAdminBackend,
  canEditOfferings,
  draftSpecification,
  normalizeOfferings,
  normalizeResults,
  offeringMutationRequest,
  readBackendSelections,
  selectedBackendForWorkspace,
  updateBackendSelections,
  validateOfferingInput,
  workspaceIdentity,
} from "../public/ui-contract.js";

describe("Service Offering UI contract", () => {
  test("renders a useful empty model and loads multiple selectable offerings", () => {
    expect(normalizeOfferings({ items: [], total: 0 })).toEqual([]);
    const offerings = normalizeOfferings({ items: [
      { id: "vp-1", name: "Advisory", active: true, currentVersion: 2, version: { version: 2, specification: { services: ["Review"] } } },
      { id: "vp-2", name: "Diagnostic", active: false, currentVersion: 1, version: { version: 1, specification: {} } },
    ] });
    expect(offerings.map(({ id, currentVersion }) => [id, currentVersion])).toEqual([["vp-1", 2], ["vp-2", 1]]);
  });

  test("create and version update validation is actionable", () => {
    expect(validateOfferingInput("", "")).toEqual({ name: "Enter a name for the offering.", brief: "Describe the offering before saving." });
    expect(validateOfferingInput("Advisory", "Help owners prepare for succession.")).toEqual({});
    expect(draftSpecification("  Help owners prepare for succession.  ")).toEqual({ summary: "Help owners prepare for succession.", sourcePrompt: "Help owners prepare for succession.", source: "user_draft" });
    expect(offeringMutationRequest(null, "Advisory", "Brief")).toMatchObject({ path: "/api/kindling/value-propositions", method: "POST", body: { name: "Advisory", approvalState: "draft" } });
    expect(offeringMutationRequest({ id: "vp-1" }, "Advisory", "Version two")).toMatchObject({ path: "/api/kindling/value-propositions/vp-1", method: "PATCH", body: { specification: { summary: "Version two", source: "user_draft" } } });
  });

  test("owner, admin and contributor can mutate while viewer cannot", () => {
    for (const role of ["owner", "admin", "contributor"]) expect(canEditOfferings({ role })).toBeTrue();
    expect(canEditOfferings({ role: "viewer", access: { edit: true } })).toBeFalse();
  });
});

describe("Results UI contract", () => {
  test("normalizes empty results to zero counts instead of an error model", () => {
    expect(normalizeResults({ items: [], total: 0 }, { tab: "waiting", limit: 25 })).toEqual({
      tab: "waiting", items: [], total: 0, returned: 0, limit: 25, offset: 0,
      counts: { waiting: 0, no_response: 0, meeting: 0, rejected: 0, snoozed: 0 },
    });
  });

  test("preserves loaded rows, counts, paging and backend errors remain caller-visible", () => {
    const payload = normalizeResults({ tab: "meeting", items: [{ companyId: "co-1" }], total: 31, returned: 1, limit: 25, offset: 25, counts: { meeting: 31 } });
    expect(payload).toMatchObject({ tab: "meeting", items: [{ companyId: "co-1" }], total: 31, returned: 1, limit: 25, offset: 25, counts: { meeting: 31 } });
    expect(() => normalizeResults(Object.defineProperty({}, "items", { get() { throw new Error("backend unavailable"); } }))).toThrow("backend unavailable");
  });
});

describe("Backend Settings UI contract", () => {
  const allowed = ["https://managed.test", "https://kindling-be.a.otherstuff.ai"];

  test("uses the managed default before login and isolates persisted choices by workspace", () => {
    let selections = {};
    selections = updateBackendSelections(selections, "workspace-a", allowed[1]);
    expect(selectedBackendForWorkspace(JSON.stringify(selections), "", allowed, allowed[0])).toBe(allowed[0]);
    expect(selectedBackendForWorkspace(JSON.stringify(selections), "workspace-a", allowed, allowed[0])).toBe(allowed[1]);
    expect(selectedBackendForWorkspace(JSON.stringify(selections), "workspace-b", allowed, allowed[0])).toBe(allowed[0]);
    expect(workspaceIdentity({ workspace: { id: "workspace-a" } })).toBe("workspace-a");
  });

  test("drops stale/untrusted origins and bounds saved workspace state", () => {
    expect(readBackendSelections(JSON.stringify({ a: allowed[1], b: "https://evil.test" }), allowed)).toEqual({ a: allowed[1] });
    let selections = {};
    for (let index = 0; index < MAX_BACKEND_SELECTIONS + 4; index += 1) selections = updateBackendSelections(selections, `workspace-${index}`, allowed[index % 2]);
    expect(Object.keys(selections)).toHaveLength(MAX_BACKEND_SELECTIONS);
    expect(selections["workspace-0"]).toBeUndefined();
  });

  test("only owners and admins see an enabled backend control", () => {
    expect(canAdminBackend({ role: "owner" })).toBeTrue();
    expect(canAdminBackend({ membership: { role: "admin" } })).toBeTrue();
    expect(canAdminBackend({ role: "contributor" })).toBeFalse();
    expect(canAdminBackend({ role: "viewer" })).toBeFalse();
  });
});
