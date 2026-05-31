const PROFILE_CACHE_KEY = "chat_wapp_profiles_v1";
const PIPELINES_CACHE_KEY = "chat_wapp_pipelines_v1";
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const state = {
  token: localStorage.getItem("chat_wapp_token") || "",
  me: null,
  chats: [],
  settings: null,
  accessRules: [],
  pipelines: loadPipelinesCache(),
  activeChatId: localStorage.getItem("chat_wapp_chat") || "",
  activeKindlingView: localStorage.getItem("kindling_view") || "companies",
  selectedCompanyId: localStorage.getItem("kindling_company") || "",
  kindlingFilters: loadKindlingFilters(),
  kindling: null,
  scanJobDetail: null,
  companyDetail: null,
  companyProfileOpen: false,
  companyCreateOpen: false,
  kindlingStatus: "Ready",
  pollTimer: null,
  route: window.location.pathname,
  profiles: loadProfileCache(),
};

const $ = (id) => document.getElementById(id);

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || res.statusText);
    return payload;
  });
}

function setStatus(text) {
  const shellStatus = $("status");
  if (shellStatus) shellStatus.textContent = text;
  const settingsStatus = $("settingsStatus");
  if (settingsStatus) settingsStatus.textContent = text;
}

function loadProfileCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadPipelinesCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PIPELINES_CACHE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePipelinesCache() {
  localStorage.setItem(PIPELINES_CACHE_KEY, JSON.stringify(state.pipelines));
}

function loadKindlingFilters() {
  try {
    const parsed = JSON.parse(localStorage.getItem("kindling_company_filters") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveKindlingFilters() {
  localStorage.setItem("kindling_company_filters", JSON.stringify(state.kindlingFilters));
}

function saveProfileCache() {
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(state.profiles));
}

function cachedProfile(pubkey) {
  const entry = state.profiles[pubkey];
  if (!entry || Date.now() - Number(entry.cachedAt || 0) > PROFILE_CACHE_TTL_MS) return null;
  return entry;
}

function displayNameForRule(rule, profile) {
  return profile?.displayName || profile?.name || `${rule.npub.slice(0, 12)}...${rule.npub.slice(-6)}`;
}

function profileInitial(rule, profile) {
  return displayNameForRule(rule, profile).slice(0, 1).toUpperCase();
}

function appRoute() {
  return ["/act", "/chat", "/settings"].includes(window.location.pathname) ? window.location.pathname : "/";
}

function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  state.route = path;
  void renderRoute();
}

function showOnly(id) {
  for (const sectionId of ["login", "home", "actPage", "settingsPage", "shell"]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function renderRoute() {
  state.route = appRoute();
  if (!state.token || !state.me) {
    stopPolling();
    showOnly("login");
    return;
  }

  if (state.route === "/chat") {
    showOnly("shell");
    await loadChatScreen();
    startPolling();
    return;
  }

  stopPolling();
  if (state.route === "/settings") {
    showOnly("settingsPage");
    await loadSettings();
    return;
  }

  if (state.route === "/act") {
    showOnly("actPage");
    await loadKindlingScreen();
    return;
  }

  showOnly("home");
}

async function login() {
  $("loginError").textContent = "";
  if (!window.nostr) {
    $("loginError").textContent = "No Nostr browser extension was found.";
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    const challenge = await api("/api/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ pubkey }),
    });
    const event = await window.nostr.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["challenge", challenge.nonce], ["client", "kindling-wapp"]],
      content: challenge.content,
    });
    const result = await api("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ event }),
    });
    state.token = result.token;
    state.me = result;
    localStorage.setItem("chat_wapp_token", result.token);
    if (window.location.pathname !== "/") history.pushState({}, "", "/");
    await bootApp();
  } catch (error) {
    $("loginError").textContent = error.message;
  }
}

async function bootApp() {
  try {
    state.me = await api("/api/me");
    $("npub").textContent = state.me.npub;
    await renderRoute();
  } catch {
    logout();
  }
}

function logout() {
  state.token = "";
  state.me = null;
  state.activeChatId = "";
  localStorage.removeItem("chat_wapp_token");
  localStorage.removeItem("chat_wapp_chat");
  stopPolling();
  showOnly("login");
}

async function loadChatScreen() {
  await loadChats();
  if (!state.activeChatId || !state.chats.find((chat) => chat.id === state.activeChatId)) {
    if (state.chats[0]) state.activeChatId = state.chats[0].id;
    else await newChat();
  }
  await loadActiveChat();
}

async function loadChats() {
  const payload = await api("/api/chats");
  state.chats = payload.chats || [];
  renderChats();
}

async function loadSettings() {
  const [payload, roles] = await Promise.all([
    api("/api/settings"),
    api("/api/kindling/pipeline-roles"),
  ]);
  state.settings = payload.settings;
  state.accessRules = payload.accessRules || [];
  state.pipelineRoles = roles.pipelineRoles || [];
  renderSettings();
  renderPipelineOptions();
  renderSettingsRoleMappings();
  renderAccessRules();
}

async function loadKindlingScreen() {
  const companyQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(state.kindlingFilters)) {
    if (value) companyQuery.set(key, value);
  }
  const [summary, targets] = await Promise.all([
    api("/api/kindling/summary"),
    api("/api/kindling/todays-targets"),
  ]);
  const enrichmentIndustries = await api("/api/kindling/enrichment-industries");
  const filtered = await api(`/api/kindling/companies${companyQuery.toString() ? `?${companyQuery}` : ""}`);
  state.kindling = {
    ...summary,
    companies: filtered.companies || [],
    companyList: {
      total: Number(filtered.total ?? summary.counts?.companies ?? 0),
      returned: Number(filtered.returned ?? filtered.companies?.length ?? 0),
      limit: Number(filtered.limit ?? summary.companyList?.limit ?? 500),
    },
    targets: targets.targets || [],
    enrichmentIndustries: enrichmentIndustries.industries || [],
    enrichmentBatchLimit: enrichmentIndustries.batchLimit || 21,
    enrichmentStrategies: enrichmentIndustries.strategies || [],
  };
  if (state.selectedCompanyId && !state.kindling.companies?.some((company) => company.id === state.selectedCompanyId)) {
    state.selectedCompanyId = "";
  }
  renderKindling();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function selectedCompany() {
  return state.companyDetail?.company || state.kindling?.companies?.find((company) => company.id === state.selectedCompanyId) || null;
}

function servicePromptValue() {
  const profile = state.kindling?.profile?.version;
  if (!profile) return "We help local service businesses find better-fit prospects, enrich sparse company records, and draft relevant first-touch outreach.";
  return profile.structured?.offer || profile.summary || "";
}

function setKindlingStatus(text) {
  state.kindlingStatus = text;
  const node = $("kindlingStatus");
  if (node) node.textContent = text;
}

function companyListShownLabel(data) {
  const returned = Number(data.companyList?.returned ?? data.companies?.length ?? 0);
  const total = Number(data.companyList?.total ?? data.counts?.companies ?? returned);
  return total > returned ? `${returned} of ${total} shown` : `${returned} shown`;
}

function renderKindling() {
  const data = state.kindling || {};
  const company = selectedCompany();
  const canEdit = Boolean(state.me?.access?.edit);
  if (state.activeKindlingView === "act") {
    state.activeKindlingView = "companies";
    localStorage.setItem("kindling_view", "companies");
  }
  const views = [
    ["companies", "Companies", companyListShownLabel(data)],
    ["service", "Service offering", data.profile?.version ? `v${escapeHtml(data.profile.version.versionNumber || "active")}` : "Draft"],
    ["targets", "Target list", `${Number(data.discoveryJobs?.length || 0)} scans`],
    ["enrich", "Enrichment", `${Number(data.enrichmentIndustries?.length || 0)} segments`],
    ["today", "Today's targets", `${Number(data.targets?.length || 0)} ranked`],
  ];
  if (canEdit) views.push(["admin", "Pipeline admin", "Operator"]);
  if (state.activeKindlingView === "admin" && !canEdit) state.activeKindlingView = "service";
  $("actPage").innerHTML = `
    <div class="kindlingShell">
      <header class="kindlingHeader">
        <div>
          <div class="brandLockup">
            <img class="brandMark" src="/assets/kindling-campfire-logo.png" alt="" />
            <span>Kindling</span>
          </div>
          <h1>Business development workspace</h1>
        </div>
        <div class="kindlingHeaderActions">
          <button type="button" data-action="home">Home</button>
          <button type="button" data-action="refresh-kindling">Refresh</button>
        </div>
      </header>
      <div class="kindlingWorkspace">
        <aside class="workflowRail" aria-label="Kindling workspace sections">
          ${views.map(([key, label, meta], index) => `
            <button type="button" data-kindling-view="${key}" class="${state.activeKindlingView === key ? "active" : ""}">
              <span>${String(index + 1).padStart(2, "0")}</span>
              <strong>${label}</strong>
              <small>${meta}</small>
            </button>
          `).join("")}
        </aside>
        <main class="kindlingMain">
          <section class="kindlingStats">
            <div><span>Companies</span><strong>${Number(data.counts?.companies || 0)}</strong></div>
            <div><span>Outreach ready</span><strong>${Number(data.counts?.outreachReady || 0)}</strong></div>
            <div><span>Active runs</span><strong>${Number(data.counts?.activeRuns || 0)}</strong></div>
            <div><span>Status</span><strong id="kindlingStatus">${escapeHtml(state.kindlingStatus)}</strong></div>
          </section>
          ${renderKindlingView(data, company, canEdit)}
        </main>
      </div>
      ${renderScanJobModal()}
      ${renderCompanyCreateModal(canEdit)}
      ${renderCompanyProfileModal(canEdit)}
    </div>
  `;
}

function renderKindlingView(data, company, canEdit) {
  if (state.activeKindlingView === "service") return `
    <section class="kindlingGrid two">
      <div class="kindlingPanel">
        <h2>Current service profile</h2>
        <p>${escapeHtml(data.profile?.version?.summary || "No service profile has been created yet.")}</p>
        <dl class="kindlingFacts">
          <div><dt>Version</dt><dd>${escapeHtml(data.profile?.version?.versionNumber || "New")}</dd></div>
          <div><dt>Rationale</dt><dd>${escapeHtml(data.profile?.version?.rationale || "Use the workspace to create the first version.")}</dd></div>
        </dl>
      </div>
      <form class="kindlingPanel kindlingActionForm" data-form="service">
        <h2>Develop service offering</h2>
        <label>
          <span>Research prompt</span>
          <textarea id="servicePrompt" rows="9">${escapeHtml(servicePromptValue())}</textarea>
        </label>
        <div class="formActions">
          <button type="submit" ${canEdit ? "" : "disabled"}>Run service role</button>
        </div>
      </form>
    </section>
  `;

  if (state.activeKindlingView === "targets") return `
    <section class="kindlingGrid two">
      <form class="kindlingPanel kindlingActionForm" data-form="scan">
        <h2>Build target list</h2>
        <label><span>Industry</span><input id="scanIndustry" value="B2B services" /></label>
        <label><span>Location</span><input id="scanLocation" value="Perth" /></label>
        <label><span>Target count</span><input id="scanTargetCount" type="number" inputmode="numeric" min="1" max="2000" step="1" value="100" /></label>
        <div class="formActions">
          <button type="submit" ${canEdit ? "" : "disabled"}>Run scan role</button>
        </div>
      </form>
      <div class="kindlingPanel">
        <h2>Recent scan jobs</h2>
        ${renderScanJobs(data.discoveryJobs || [])}
      </div>
    </section>
  `;

  if (state.activeKindlingView === "enrich") return `
    <section class="kindlingGrid two">
      <div class="kindlingPanel">
        <div class="panelHeader">
          <h2>Enrich by industry</h2>
          <span>${Number(data.enrichmentIndustries?.length || 0)} segments</span>
        </div>
        ${renderEnrichmentIndustries(data.enrichmentIndustries || [], canEdit)}
      </div>
      <div class="kindlingPanel">
        <h2>Batch strategy set</h2>
        <div class="strategyList">
          ${(data.enrichmentStrategies || []).map((strategy, index) => `
            <div>
              <strong>${index + 1}. ${escapeHtml(strategy.label || strategy.key)}</strong>
              <span>${escapeHtml(strategy.instruction || "")}</span>
            </div>
          `).join("") || "<p>No enrichment strategies configured.</p>"}
        </div>
        <p class="scanWarning">Each run queues up to ${Number(data.enrichmentBatchLimit || 21)} unprocessed companies, then marks each company complete as soon as its enrichment result is written.</p>
      </div>
    </section>
  `;

  if (state.activeKindlingView === "companies") return `
    <section class="kindlingGrid companiesLayout">
      <div class="kindlingPanel companyTablePanel">
        <div class="panelHeader">
          <div>
            <h2>Companies</h2>
            <span>${companyListShownLabel(data)}</span>
          </div>
          <button type="button" data-action="open-company-create" ${canEdit ? "" : "disabled"}>New company</button>
        </div>
        ${renderCompanyStageFilters()}
        ${renderCompanyFilters()}
        ${renderCompanyTable(data.companies || [])}
      </div>
    </section>
  `;

  if (state.activeKindlingView === "today") return `
    <section class="kindlingPanel">
      <h2>Today's targets</h2>
      <div class="targetList">
        ${(data.targets || []).map((target) => `<button type="button" data-select-company="${escapeHtml(target.companyId)}"><strong>#${Number(target.rank || 0)} ${escapeHtml(target.name)}</strong><span>${escapeHtml(target.reason)} - ${escapeHtml(target.industry)} ${escapeHtml(target.location)}</span></button>`).join("") || "<p>No ranked targets yet. Run a scan or enrichment first.</p>"}
      </div>
    </section>
  `;

  return `
    <form class="kindlingPanel" data-form="roles">
      <h2>Pipeline role settings</h2>
      <div class="roleList">
        ${(data.pipelineRoles || []).map((role) => `
          <div class="roleRow">
            <label><span>${escapeHtml(role.displayName)}</span><input data-role-slug="${escapeHtml(role.roleKey)}" value="${escapeHtml(role.activePipelineSlug)}" /></label>
            <label class="roleEnabled"><input type="checkbox" data-role-enabled="${escapeHtml(role.roleKey)}" ${role.enabled ? "checked" : ""} /> Enabled</label>
          </div>
        `).join("")}
      </div>
      <button type="submit" ${canEdit ? "" : "disabled"}>Save role mappings</button>
    </form>
  `;
}

function renderScanJobs(jobs) {
  if (!jobs.length) return "<p>No scan jobs yet.</p>";
  return `<div class="compactList scanJobList">
    ${jobs.map((job) => `
      <button type="button" data-scan-job="${escapeHtml(job.id)}" class="scanJobButton">
        <strong>${escapeHtml(job.industry)}</strong>
        <span>${escapeHtml(job.location)} - ${escapeHtml(job.status)} - ${Number(job.companyCount || 0)} returned</span>
        <small>${Number(job.targetCount || 0)} target - ${escapeHtml(job.scanMode || "interactive")}</small>
      </button>
    `).join("")}
  </div>`;
}

function renderEnrichmentIndustries(industries, canEdit) {
  if (!industries.length) return "<p>No unprocessed companies are waiting for enrichment.</p>";
  return `<div class="compactList industryList">
    ${industries.map((item) => `
      <button type="button" data-enrich-industry="${escapeHtml(item.industry)}" class="industryButton" ${canEdit ? "" : "disabled"}>
        <strong>${escapeHtml(item.industry)} (${Number(item.unprocessedCount || 0)})</strong>
        <span>${Number(item.notStartedCount || 0)} not started${Number(item.failedCount || 0) ? ` - ${Number(item.failedCount || 0)} failed retry` : ""}</span>
        <small>${Number(item.queuedCount || 0)} queued - ${Number(item.completeCount || 0)} complete</small>
      </button>
    `).join("")}
  </div>`;
}

function renderScanJobModal() {
  const detail = state.scanJobDetail;
  if (!detail) return "";
  const searchedStrategies = detail.searchedStrategies || (detail.strategies || []).filter((strategy) => strategy.status !== "planned");
  const plannedStrategies = detail.plannedStrategies || (detail.strategies || []).filter((strategy) => strategy.status === "planned");
  const companies = detail.outputs?.companies || [];
  const targetCount = Number(detail.outputs?.targetCount || detail.input?.targetCount || detail.job?.targetCount || 0);
  const returnedCompanies = Number(detail.outputs?.returnedCompanies || detail.outputs?.companyCount || 0);
  const netNewCompanies = Number(detail.outputs?.netNewCompanies || 0);
  const existingMatchedCompanies = Number(detail.outputs?.existingMatchedCompanies || 0);
  const remainingTarget = Math.max(0, targetCount - returnedCompanies);
  return `
    <div class="modalBackdrop" data-action="close-scan-job">
      <section class="modalPanel scanJobModal" role="dialog" aria-modal="true" aria-label="Scan job details" data-modal-panel>
        <header class="modalHeader">
          <div>
            <div class="eyebrow">Scan job</div>
            <h2>${escapeHtml(detail.job?.industry || "Scan")} in ${escapeHtml(detail.job?.location || "Unknown")}</h2>
          </div>
          <button type="button" data-action="close-scan-job">Close</button>
        </header>
        <div class="scanDetailGrid">
          <section>
            <h3>Input</h3>
            <dl class="kindlingFacts">
              <div><dt>Message</dt><dd>${escapeHtml(detail.input?.message || "No message captured")}</dd></div>
              <div><dt>Target</dt><dd>${Number(detail.input?.targetCount || detail.job?.targetCount || 0)}</dd></div>
              <div><dt>Mode</dt><dd>${escapeHtml(detail.input?.scanMode || detail.job?.scanMode || "")}</dd></div>
              <div><dt>Status</dt><dd>${escapeHtml(detail.job?.status || "")}</dd></div>
            </dl>
          </section>
          <section>
            <h3>Outputs</h3>
            <dl class="kindlingFacts">
              <div><dt>Returned</dt><dd>${returnedCompanies} companies</dd></div>
              <div><dt>Net new</dt><dd>${netNewCompanies} companies</dd></div>
              <div><dt>Existing</dt><dd>${existingMatchedCompanies} matched by dedupe</dd></div>
              <div><dt>Sources</dt><dd>${Number(detail.outputs?.sourceCount || 0)}</dd></div>
              <div><dt>Strategies</dt><dd>${searchedStrategies.length} run, ${plannedStrategies.length} planned</dd></div>
              <div><dt>Remaining</dt><dd>${remainingTarget} of ${targetCount}</dd></div>
              <div><dt>Summary</dt><dd>${escapeHtml(detail.outputs?.summary || "No summary captured")}</dd></div>
            </dl>
            ${remainingTarget > 0 ? `<p class="scanWarning">This was a partial slice, not a completed bulk scan.</p>` : ""}
          </section>
        </div>
        <section class="scanDetailSection">
          <h3>Strategies run</h3>
          <div class="strategyList">
            ${searchedStrategies.map((strategy, index) => `
              <div>
                <strong>Strategy ${index + 1}: ${escapeHtml(strategy.strategyType)}</strong>
                <span>${escapeHtml(strategy.query || "No query captured")}</span>
                <small>${escapeHtml(strategy.status)} - ${Number(strategy.resultCount || 0)} companies${strategy.notes ? ` - ${escapeHtml(strategy.notes)}` : ""}</small>
              </div>
            `).join("") || "<p>No strategy attempts recorded yet.</p>"}
          </div>
        </section>
        <section class="scanDetailSection">
          <h3>Planned next strategies</h3>
          <div class="strategyList">
            ${plannedStrategies.map((strategy, index) => `
              <div>
                <strong>Next ${index + 1}: ${escapeHtml(strategy.strategyType)}</strong>
                <span>${escapeHtml(strategy.query || "No query captured")}</span>
                <small>${escapeHtml(strategy.notes || "No notes captured")}</small>
              </div>
            `).join("") || "<p>No planned next strategies recorded.</p>"}
          </div>
        </section>
        <section class="scanDetailSection">
          <h3>Companies found</h3>
          <div class="companyTable modalCompanyList">
            ${companies.map((company) => `
              <button type="button" data-select-company="${escapeHtml(company.id)}">
                <strong>${escapeHtml(company.name)}</strong>
                <span>${escapeHtml(company.website || "No website")} - ${escapeHtml(company.dataRing)} - confidence ${Number(company.confidence || 0).toFixed(2)}</span>
              </button>
            `).join("") || "<p>No companies matched this job yet.</p>"}
          </div>
        </section>
      </section>
    </div>
  `;
}

function renderCompanyStageFilters() {
  const current = state.kindlingFilters.enrichmentStatus || "";
  const stages = [
    ["", "All"],
    ["complete", "Enriched"],
    ["not_started", "Unprocessed"],
    ["queued", "Queued"],
    ["failed", "Failed"],
  ];
  return `<div class="stageFilters" aria-label="Company stage filters">
    ${stages.map(([value, label]) => `
      <button type="button" data-company-stage="${escapeHtml(value)}" class="${current === value ? "active" : ""}">
        ${escapeHtml(label)}
      </button>
    `).join("")}
  </div>`;
}

function renderCompanyFilters() {
  const filters = state.kindlingFilters;
  const option = (value, label, current) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`;
  return `
    <form class="companyFilters" data-form="company-filters">
      <input id="filterIndustry" value="${escapeHtml(filters.industry || "")}" placeholder="Industry" />
      <input id="filterLocation" value="${escapeHtml(filters.location || "")}" placeholder="Location" />
      <select id="filterDataRing">
        ${option("", "Any data ring", filters.dataRing || "")}
        ${["seed", "manual", "agent", "enriched", "outreach_ready"].map((value) => option(value, value, filters.dataRing || "")).join("")}
      </select>
      <select id="filterDuplicate">
        ${option("", "Any duplicate status", filters.duplicateStatus || "")}
        ${["unknown", "unique", "possible_duplicate", "duplicate"].map((value) => option(value, value, filters.duplicateStatus || "")).join("")}
      </select>
      <select id="filterHasWebsite">
        ${option("", "Any website status", filters.hasWebsite || "")}
        ${option("yes", "Has website", filters.hasWebsite || "")}
        ${option("no", "No website", filters.hasWebsite || "")}
      </select>
      <select id="filterEnrichment">
        ${option("", "Any enrichment", filters.enrichmentStatus || "")}
        ${["not_started", "queued", "complete", "failed"].map((value) => option(value, value, filters.enrichmentStatus || "")).join("")}
      </select>
      <div class="filterActions">
        <button type="submit">Apply</button>
        <button type="button" data-action="clear-company-filters">Clear</button>
      </div>
    </form>
  `;
}

function renderCompanyTable(companies) {
  if (!companies.length) return "<p>No companies yet.</p>";
  return `<div class="companyTable">
    ${companies.map((company) => `
      <button type="button" data-select-company="${escapeHtml(company.id)}" class="${company.id === state.selectedCompanyId ? "active" : ""}">
        <span class="companyRowMain">
          <strong>${escapeHtml(company.name)}</strong>
          <small>${escapeHtml(stageLabel(company.enrichmentStatus))}</small>
        </span>
        <span>${escapeHtml(company.industry || "Unknown")} - ${escapeHtml(company.location || "Unknown")} - ${escapeHtml(company.website || "No website")}</span>
      </button>
    `).join("")}
  </div>`;
}

function stageLabel(value) {
  if (value === "complete") return "Enriched";
  if (value === "not_started") return "Unprocessed";
  return value || "Unknown";
}

function renderCompanyEditor(company, canEdit) {
  return `
    <input id="editCompanyName" value="${escapeHtml(company.name)}" />
    <input id="editCompanyIndustry" value="${escapeHtml(company.industry)}" placeholder="Industry" />
    <input id="editCompanyLocation" value="${escapeHtml(company.location)}" placeholder="Location" />
    <input id="editCompanyWebsite" value="${escapeHtml(company.website)}" placeholder="Website" />
    <select id="editCompanyDataRing">
      ${["seed", "manual", "enriched", "outreach_ready"].map((value) => `<option value="${value}" ${company.dataRing === value ? "selected" : ""}>${value}</option>`).join("")}
    </select>
    <select id="editCompanyDuplicate">
      ${["unknown", "unique", "possible_duplicate", "duplicate"].map((value) => `<option value="${value}" ${company.duplicateStatus === value ? "selected" : ""}>${value}</option>`).join("")}
    </select>
    <textarea id="editCompanyNotes" rows="5" placeholder="Notes">${escapeHtml(company.profile?.notes || company.profile?.fitNotes || "")}</textarea>
    <div class="formActions">
      <button type="submit" ${canEdit ? "" : "disabled"}>Save profile</button>
    </div>
  `;
}

function renderCompanyCreateModal(canEdit) {
  if (!state.companyCreateOpen) return "";
  return `
    <div class="modalBackdrop" data-action="close-company-create">
      <section class="modalPanel companyCreateModal" role="dialog" aria-modal="true" aria-label="New company" data-modal-panel>
        <header class="modalHeader">
          <div>
            <div class="eyebrow">Company</div>
            <h2>New company</h2>
          </div>
          <button type="button" data-action="close-company-create">Close</button>
        </header>
        <form class="compactForm" data-form="company">
          <input id="companyName" placeholder="Company name" />
          <input id="companyIndustry" placeholder="Industry optional" />
          <input id="companyLocation" placeholder="Location optional" />
          <input id="companyWebsite" placeholder="Website optional" />
          <div class="formActions">
            <button type="submit" ${canEdit ? "" : "disabled"}>Create company</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderCompanyProfileModal(canEdit) {
  if (!state.companyProfileOpen) return "";
  const detail = state.companyDetail;
  const company = detail?.company || selectedCompany();
  if (!company) return "";
  const profile = company.profile || {};
  const sources = detail?.sources || [];
  const activities = detail?.activities || [];
  const drafts = detail?.drafts || [];
  return `
    <div class="modalBackdrop" data-action="close-company-profile">
      <section class="modalPanel companyProfileModal" role="dialog" aria-modal="true" aria-label="Company profile" data-modal-panel>
        <header class="modalHeader">
          <div>
            <div class="eyebrow">${escapeHtml(stageLabel(company.enrichmentStatus))}</div>
            <h2>${escapeHtml(company.name)}</h2>
          </div>
          <button type="button" data-action="close-company-profile">Close</button>
        </header>
        <div class="companyProfileGrid">
          <section>
            <h3>Profile</h3>
            <dl class="kindlingFacts">
              <div><dt>Industry</dt><dd>${escapeHtml(company.industry || "Unknown")}</dd></div>
              <div><dt>Location</dt><dd>${escapeHtml(company.location || "Unknown")}</dd></div>
              <div><dt>Website</dt><dd>${company.website ? `<a href="${escapeHtml(company.website)}" target="_blank" rel="noreferrer">${escapeHtml(company.website)}</a>` : "No website"}</dd></div>
              <div><dt>Data ring</dt><dd>${escapeHtml(company.dataRing)}</dd></div>
              <div><dt>Duplicate</dt><dd>${escapeHtml(company.duplicateStatus)}</dd></div>
              <div><dt>Confidence</dt><dd>${Number(company.confidence || 0).toFixed(2)}</dd></div>
            </dl>
          </section>
          <form class="kindlingActionForm" data-form="company-profile">
            <h3>Edit</h3>
            ${renderCompanyEditor(company, canEdit)}
          </form>
        </div>
        <section class="scanDetailSection">
          <h3>Enriched details</h3>
          ${renderProfileSummary(profile)}
        </section>
        <section class="scanDetailSection">
          <h3>Sources</h3>
          <div class="sourceList">
            ${sources.map((source) => `
              <a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer">
                <strong>${escapeHtml(source.title || source.sourceType || source.url || "Source")}</strong>
                <span>${escapeHtml(source.sourceType || "")}${source.confidence ? ` - confidence ${Number(source.confidence || 0).toFixed(2)}` : ""}</span>
              </a>
            `).join("") || "<p>No sources recorded yet.</p>"}
          </div>
        </section>
        <section class="scanDetailSection">
          <h3>Drafts</h3>
          ${drafts.map((draft) => `<textarea class="pitchText" readonly rows="7">${escapeHtml(draft.pitchText || "")}</textarea>`).join("") || "<p>No outreach drafts recorded yet.</p>"}
        </section>
        <section class="scanDetailSection">
          <h3>Activity</h3>
          <div class="activityList">
            ${activities.map((activity) => `
              <div>
                <strong>${escapeHtml(activity.summary || activity.actionType || "Activity")}</strong>
                <span>${formatDate(activity.createdAt)}</span>
              </div>
            `).join("") || "<p>No activity recorded yet.</p>"}
          </div>
        </section>
      </section>
    </div>
  `;
}

function renderProfileSummary(profile) {
  const entries = Object.entries(profile || {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!entries.length) return "<p>No enriched profile payload recorded yet.</p>";
  return `<div class="profilePayload">
    ${entries.map(([key, value]) => `
      <div>
        <strong>${escapeHtml(labelFromKey(key))}</strong>
        <span>${escapeHtml(formatProfileValue(value))}</span>
      </div>
    `).join("")}
  </div>`;
}

function labelFromKey(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatProfileValue(value) {
  if (Array.isArray(value)) return value.map(formatProfileValue).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

function formatDate(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString();
}

function renderLatestDraft(drafts, company) {
  const draft = drafts.find((item) => item.companyId === company?.id) || drafts[0];
  if (!draft) return "<p>No draft yet. Select a company and run Draft pitch.</p>";
  return `<textarea class="pitchText" readonly rows="12">${escapeHtml(draft.pitchText)}</textarea>
    <div class="formActions">
      <button type="button" data-copy-draft>Copy</button>
    </div>`;
}

async function startKindlingPipeline(path, body = {}) {
  const payload = await api(path, {
    method: "POST",
    body: JSON.stringify({ ...body, deferAutopilotAuth: true }),
  });
  if (!payload.requiresAutopilotAuth) return payload;
  const autopilotAuthorization = await signNip98Request(payload.triggerRequest);
  const started = await api(`/api/kindling/pipeline-runs/${encodeURIComponent(payload.runId)}/start`, {
    method: "POST",
    body: JSON.stringify({ autopilotAuthorization }),
  });
  return { ...payload, started };
}

async function refreshKindlingSoon() {
  await new Promise((resolve) => setTimeout(resolve, 900));
  await loadKindlingScreen();
}

async function handleKindlingSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  try {
    if (form.dataset.form === "service") {
      setKindlingStatus("Running service role");
      await startKindlingPipeline("/api/kindling/service-offering", { prompt: $("servicePrompt").value.trim() });
      await refreshKindlingSoon();
      setKindlingStatus("Service profile updated");
    }
    if (form.dataset.form === "scan") {
      setKindlingStatus("Running scan role");
      await startKindlingPipeline("/api/kindling/target-scans", {
        industry: $("scanIndustry").value.trim(),
        location: $("scanLocation").value.trim(),
        targetCount: Number($("scanTargetCount").value || 25),
      });
      await refreshKindlingSoon();
      setKindlingStatus("Target scan complete");
    }
    if (form.dataset.form === "company") {
      setKindlingStatus("Creating company");
      const payload = await api("/api/kindling/companies", {
        method: "POST",
        body: JSON.stringify({
          name: $("companyName").value.trim(),
          industry: $("companyIndustry").value.trim(),
          location: $("companyLocation").value.trim(),
          website: $("companyWebsite").value.trim(),
        }),
      });
      state.selectedCompanyId = payload.company.id;
      localStorage.setItem("kindling_company", state.selectedCompanyId);
      state.companyCreateOpen = false;
      state.companyProfileOpen = true;
      state.companyDetail = await api(`/api/kindling/companies/${encodeURIComponent(state.selectedCompanyId)}`);
      await loadKindlingScreen();
      setKindlingStatus("Company created");
    }
    if (form.dataset.form === "company-filters") {
      state.kindlingFilters = {
        industry: $("filterIndustry").value.trim(),
        location: $("filterLocation").value.trim(),
        dataRing: $("filterDataRing").value,
        duplicateStatus: $("filterDuplicate").value,
        hasWebsite: $("filterHasWebsite").value,
        enrichmentStatus: $("filterEnrichment").value,
      };
      saveKindlingFilters();
      await loadKindlingScreen();
      setKindlingStatus("Company filters applied");
    }
    if (form.dataset.form === "company-profile" && selectedCompany()) {
      setKindlingStatus("Saving profile");
      await api(`/api/kindling/companies/${encodeURIComponent(selectedCompany().id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: $("editCompanyName").value.trim(),
          industry: $("editCompanyIndustry").value.trim(),
          location: $("editCompanyLocation").value.trim(),
          website: $("editCompanyWebsite").value.trim(),
          dataRing: $("editCompanyDataRing").value,
          duplicateStatus: $("editCompanyDuplicate").value,
          notes: $("editCompanyNotes").value.trim(),
        }),
      });
      state.companyDetail = await api(`/api/kindling/companies/${encodeURIComponent(selectedCompany().id)}`);
      await loadKindlingScreen();
      state.companyProfileOpen = true;
      setKindlingStatus("Profile saved");
    }
    if (form.dataset.form === "roles") {
      const roles = Array.from(form.querySelectorAll("[data-role-slug]")).map((input) => ({
        roleKey: input.dataset.roleSlug,
        activePipelineSlug: input.value.trim(),
        pipelineLabel: input.value.trim(),
        enabled: form.querySelector(`[data-role-enabled="${CSS.escape(input.dataset.roleSlug)}"]`)?.checked ?? true,
      }));
      await api("/api/kindling/pipeline-roles", { method: "PUT", body: JSON.stringify({ roles }) });
      await loadKindlingScreen();
      setKindlingStatus("Role mappings saved");
    }
  } catch (error) {
    setKindlingStatus(error.message);
  }
}

async function handleKindlingClick(event) {
  const closeScanJob = event.target.closest('[data-action="close-scan-job"]');
  if (closeScanJob && (!event.target.closest("[data-modal-panel]") || closeScanJob.tagName === "BUTTON")) {
    state.scanJobDetail = null;
    renderKindling();
    return;
  }
  const closeCompanyCreate = event.target.closest('[data-action="close-company-create"]');
  if (closeCompanyCreate && (!event.target.closest("[data-modal-panel]") || closeCompanyCreate.tagName === "BUTTON")) {
    state.companyCreateOpen = false;
    renderKindling();
    return;
  }
  const closeCompanyProfile = event.target.closest('[data-action="close-company-profile"]');
  if (closeCompanyProfile && (!event.target.closest("[data-modal-panel]") || closeCompanyProfile.tagName === "BUTTON")) {
    state.companyProfileOpen = false;
    state.companyDetail = null;
    renderKindling();
    return;
  }
  const viewButton = event.target.closest("[data-kindling-view]");
  if (viewButton) {
    state.activeKindlingView = viewButton.dataset.kindlingView;
    localStorage.setItem("kindling_view", state.activeKindlingView);
    renderKindling();
    return;
  }
  const scanJobButton = event.target.closest("[data-scan-job]");
  if (scanJobButton) {
    setKindlingStatus("Loading scan job");
    state.scanJobDetail = await api(`/api/kindling/discovery-jobs/${encodeURIComponent(scanJobButton.dataset.scanJob)}`);
    renderKindling();
    setKindlingStatus("Scan job loaded");
    return;
  }
  const enrichIndustryButton = event.target.closest("[data-enrich-industry]");
  if (enrichIndustryButton) {
    const industry = enrichIndustryButton.dataset.enrichIndustry;
    const confirmed = window.confirm(`Run enrichment for ${industry}? This will queue up to ${Number(state.kindling?.enrichmentBatchLimit || 21)} unprocessed companies.`);
    if (!confirmed) return;
    setKindlingStatus(`Running ${industry} enrichment`);
    const payload = await startKindlingPipeline(`/api/kindling/enrichment-industries/${encodeURIComponent(industry)}/enrich`, {
      limit: Number(state.kindling?.enrichmentBatchLimit || 21),
    });
    await refreshKindlingSoon();
    setKindlingStatus(`Queued ${Number(payload.batchSize || 0)} ${industry} companies`);
    return;
  }
  const stageButton = event.target.closest("[data-company-stage]");
  if (stageButton) {
    state.kindlingFilters = {
      ...state.kindlingFilters,
      enrichmentStatus: stageButton.dataset.companyStage || "",
    };
    saveKindlingFilters();
    await loadKindlingScreen();
    setKindlingStatus(state.kindlingFilters.enrichmentStatus ? `${stageLabel(state.kindlingFilters.enrichmentStatus)} companies` : "All companies");
    return;
  }
  const selectButton = event.target.closest("[data-select-company]");
  if (selectButton) {
    state.selectedCompanyId = selectButton.dataset.selectCompany;
    localStorage.setItem("kindling_company", state.selectedCompanyId);
    state.scanJobDetail = null;
    state.companyProfileOpen = true;
    state.companyDetail = null;
    setKindlingStatus("Loading company profile");
    state.companyDetail = await api(`/api/kindling/companies/${encodeURIComponent(state.selectedCompanyId)}`);
    renderKindling();
    setKindlingStatus("Company profile loaded");
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "home") navigate("/");
  if (action === "refresh-kindling") await loadKindlingScreen();
  if (action === "open-company-create") {
    state.companyCreateOpen = true;
    renderKindling();
  }
  if (action === "clear-company-filters") {
    state.kindlingFilters = {};
    saveKindlingFilters();
    await loadKindlingScreen();
    setKindlingStatus("Company filters cleared");
  }
  if (action === "enrich-company" && selectedCompany()) {
    setKindlingStatus("Running enrichment role");
    await startKindlingPipeline(`/api/kindling/companies/${encodeURIComponent(selectedCompany().id)}/enrich`);
    await refreshKindlingSoon();
    setKindlingStatus("Enrichment complete");
  }
  if (action === "draft-outreach" && selectedCompany()) {
    setKindlingStatus("Running outreach role");
    await startKindlingPipeline(`/api/kindling/companies/${encodeURIComponent(selectedCompany().id)}/outreach`);
    await refreshKindlingSoon();
    setKindlingStatus("Draft ready");
  }
  if (event.target.closest("[data-copy-draft]")) {
    const text = $("actPage").querySelector(".pitchText")?.value || "";
    await navigator.clipboard.writeText(text);
    setKindlingStatus("Pitch copied");
  }
}

function handleKindlingChange(event) {
  if (event.target.id === "activeCompanySelect") {
    state.selectedCompanyId = event.target.value;
    localStorage.setItem("kindling_company", state.selectedCompanyId);
    renderKindling();
  }
}

function renderSettings() {
  $("autopilotUrlInput").value = state.settings?.autopilotUrl || "";
  $("pipelineInput").value = state.settings?.defaultPipeline || "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const id of ["autopilotUrlInput", "pipelineInput", "pipelineSelect", "loadPipelinesButton", "saveSettingsButton", "accessNpubInput", "accessRoleSelect", "addAccessButton"]) {
    $(id).disabled = !canEdit;
  }
}

function pipelineSlug(pipeline) {
  return pipeline?.slug || pipeline?.name || pipeline?.id || pipeline?.key || "";
}

function pipelineLabel(pipeline) {
  const slug = pipelineSlug(pipeline);
  const label = pipeline?.title || pipeline?.label || pipeline?.displayName || pipeline?.name || slug;
  return `${label}${pipeline?.version ? ` v${pipeline.version}` : ""}`;
}

function renderPipelineOptions() {
  const select = $("pipelineSelect");
  select.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = state.pipelines.length ? "Select a pipeline" : "No pipelines loaded";
  select.appendChild(empty);
  for (const pipeline of state.pipelines) {
    const slug = pipelineSlug(pipeline);
    if (!slug) continue;
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = pipelineLabel(pipeline);
    select.appendChild(option);
  }
}

function renderSettingsRoleMappings() {
  const list = $("settingsRoleList");
  if (!list) return;
  list.innerHTML = "";
  const canEdit = Boolean(state.me?.access?.edit);
  const roles = state.pipelineRoles || [];
  if (!roles.length) {
    list.innerHTML = `<p class="muted">No Kindling pipeline roles are configured.</p>`;
    return;
  }
  for (const role of roles) {
    const row = document.createElement("div");
    row.className = "settingsRoleRow";

    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = role.displayName;
    const select = document.createElement("select");
    select.dataset.settingsRoleSlug = role.roleKey;
    select.disabled = !canEdit;

    const current = role.activePipelineSlug || "";
    const currentOption = document.createElement("option");
    currentOption.value = current;
    currentOption.textContent = current || "Select a pipeline";
    select.appendChild(currentOption);

    for (const pipeline of state.pipelines) {
      const slug = pipelineSlug(pipeline);
      if (!slug || slug === current) continue;
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = pipelineLabel(pipeline);
      select.appendChild(option);
    }

    label.append(caption, select);

    const enabled = document.createElement("label");
    enabled.className = "roleEnabled";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.settingsRoleEnabled = role.roleKey;
    checkbox.checked = role.enabled !== false;
    checkbox.disabled = !canEdit;
    enabled.append(checkbox, document.createTextNode(" Enabled"));

    row.append(label, enabled);
    list.appendChild(row);
  }
}

function renderAccessRules() {
  const list = $("accessList");
  list.innerHTML = "";
  const canEdit = Boolean(state.me?.access?.edit);
  for (const rule of state.accessRules) {
    const item = document.createElement("div");
    item.className = "accessItem";
    item.dataset.pubkey = rule.pubkey;
    const profile = cachedProfile(rule.pubkey);
    const identity = document.createElement("div");
    identity.className = "accessIdentity";
    const avatar = document.createElement("div");
    avatar.className = "accessAvatar";
    if (profile?.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
    const label = document.createElement("div");
    label.className = "accessLabel";
    const name = document.createElement("strong");
    name.textContent = displayNameForRule(rule, profile);
    const meta = document.createElement("span");
    meta.textContent = `${rule.role === "edit" ? "Edit" : "Read"} - ${rule.npub}`;
    label.append(name, meta);
    identity.append(avatar, label);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Remove";
    button.disabled = !canEdit;
    button.addEventListener("click", () => removeAccessRule(rule));
    item.append(identity, button);
    list.appendChild(item);
    if (!profile) {
      void resolveProfile(rule).then(() => updateAccessRuleProfile(rule));
    }
  }
}

function updateAccessRuleProfile(rule) {
  const item = $(`accessList`).querySelector(`[data-pubkey="${CSS.escape(rule.pubkey)}"]`);
  const profile = cachedProfile(rule.pubkey);
  if (!item || !profile) return;
  const avatar = item.querySelector(".accessAvatar");
  const name = item.querySelector(".accessLabel strong");
  if (avatar) {
    avatar.innerHTML = "";
    if (profile.picture) {
      const img = document.createElement("img");
      img.src = profile.picture;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = profileInitial(rule, profile);
    }
  }
  if (name) name.textContent = displayNameForRule(rule, profile);
}

async function resolveProfile(rule) {
  const existing = cachedProfile(rule.pubkey);
  if (existing) return existing;
  const profile = await fetchNostrProfile(rule.pubkey).catch(() => null);
  const normalized = {
    pubkey: rule.pubkey,
    name: typeof profile?.name === "string" ? profile.name : "",
    displayName: typeof profile?.display_name === "string" ? profile.display_name : typeof profile?.displayName === "string" ? profile.displayName : "",
    picture: typeof profile?.picture === "string" ? profile.picture : "",
    cachedAt: Date.now(),
  };
  state.profiles[rule.pubkey] = normalized;
  saveProfileCache();
  return normalized;
}

async function fetchNostrProfile(pubkey) {
  const attempts = PROFILE_RELAYS.map((relay) => fetchProfileFromRelay(relay, pubkey));
  const result = await Promise.any(attempts);
  return result;
}

function fetchProfileFromRelay(relayUrl, pubkey) {
  return new Promise((resolve, reject) => {
    const subId = `profile-${pubkey.slice(0, 8)}-${Math.random().toString(16).slice(2)}`;
    let bestEvent = null;
    let settled = false;
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => {
      finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    }, 2500);

    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.send(JSON.stringify(["CLOSE", subId]));
      } catch {}
      try {
        socket.close();
      } catch {}
      if (error || !value) reject(error || new Error("profile not found"));
      else resolve(value);
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === "EVENT" && message[1] === subId && message[2]?.kind === 0) {
        if (!bestEvent || Number(message[2].created_at || 0) > Number(bestEvent.created_at || 0)) bestEvent = message[2];
      }
      if (message[0] === "EOSE" && message[1] === subId) finish(bestEvent ? parseProfileEvent(bestEvent) : null);
    });
    socket.addEventListener("error", () => finish(null, new Error(`relay failed: ${relayUrl}`)));
  });
}

function parseProfileEvent(event) {
  const profile = JSON.parse(event.content || "{}");
  return profile && typeof profile === "object" && !Array.isArray(profile) ? profile : null;
}

async function saveSettings() {
  try {
    const payload = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        autopilotUrl: $("autopilotUrlInput").value.trim(),
        defaultPipeline: $("pipelineInput").value.trim(),
      }),
    });
    state.settings = payload.settings;
    if (state.me?.access?.edit) {
      const roles = collectSettingsRoleMappings();
      const rolePayload = await api("/api/kindling/pipeline-roles", {
        method: "PUT",
        body: JSON.stringify({ roles }),
      });
      state.pipelineRoles = rolePayload.pipelineRoles || state.pipelineRoles;
    }
    renderSettings();
    renderPipelineOptions();
    renderSettingsRoleMappings();
    setStatus("Settings saved");
  } catch (error) {
    setStatus(error.message);
  }
}

function collectSettingsRoleMappings() {
  return Array.from(document.querySelectorAll("[data-settings-role-slug]")).map((select) => {
    const roleKey = select.dataset.settingsRoleSlug;
    const enabled = document.querySelector(`[data-settings-role-enabled="${CSS.escape(roleKey)}"]`);
    return {
      roleKey,
      activePipelineSlug: select.value.trim(),
      pipelineLabel: select.options[select.selectedIndex]?.textContent?.trim() || select.value.trim(),
      enabled: enabled ? enabled.checked : true,
    };
  });
}

async function loadPipelines() {
  try {
    setStatus("Authorizing pipeline list");
    const autopilotUrl = $("autopilotUrlInput").value.trim();
    const prepared = await api("/api/autopilot/pipelines", {
      method: "POST",
      body: JSON.stringify({ autopilotUrl }),
    });
    let payload = prepared;
    if (prepared.requiresAutopilotAuth && prepared.triggerRequest) {
      const autopilotAuthorization = await signNip98Request(prepared.triggerRequest);
      payload = await api("/api/autopilot/pipelines", {
        method: "POST",
        body: JSON.stringify({ autopilotUrl, autopilotAuthorization }),
      });
    }
    state.pipelines = payload.pipelines || [];
    savePipelinesCache();
    renderPipelineOptions();
    renderSettingsRoleMappings();
    setStatus(`Loaded ${state.pipelines.length} pipelines`);
  } catch (error) {
    setStatus(error.message);
  }
}

async function addAccess() {
  try {
    const payload = await api("/api/access-rules", {
      method: "POST",
      body: JSON.stringify({
        npub: $("accessNpubInput").value.trim(),
        role: $("accessRoleSelect").value,
      }),
    });
    state.accessRules = payload.accessRules || [];
    $("accessNpubInput").value = "";
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

async function removeAccessRule(rule) {
  try {
    const payload = await api(`/api/access-rules/${encodeURIComponent(rule.role)}/${encodeURIComponent(rule.npub)}`, {
      method: "DELETE",
    });
    state.accessRules = payload.accessRules || [];
    renderAccessRules();
    setStatus("Access updated");
  } catch (error) {
    setStatus(error.message);
  }
}

function renderChats() {
  const list = $("chatList");
  list.innerHTML = "";
  for (const chat of state.chats) {
    const button = document.createElement("button");
    button.className = `chatItem${chat.id === state.activeChatId ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = chat.title;
    button.querySelector("span").textContent = chat.preview || "No messages yet";
    button.addEventListener("click", async () => {
      state.activeChatId = chat.id;
      localStorage.setItem("chat_wapp_chat", chat.id);
      renderChats();
      await loadActiveChat();
    });
    list.appendChild(button);
  }
}

async function newChat() {
  const payload = await api("/api/chats", { method: "POST", body: "{}" });
  state.activeChatId = payload.chat.id;
  localStorage.setItem("chat_wapp_chat", state.activeChatId);
  await loadChats();
  await loadActiveChat();
}

async function loadActiveChat() {
  if (!state.activeChatId) return;
  const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`);
  $("chatTitle").textContent = payload.chat.title;
  renderMessages(payload.messages || []);
  renderChats();
}

function renderMessages(messages) {
  const box = $("messages");
  box.innerHTML = "";
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = `message ${message.role} ${message.status}`;
    node.textContent = message.status === "pending" ? "Thinking..." : message.content;
    box.appendChild(node);
  }
  box.scrollTop = box.scrollHeight;
  const pending = messages.some((message) => message.status === "pending");
  setStatus(pending ? "Pipeline running" : "Ready");
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("messageInput");
  const content = input.value.trim();
  if (!content || !state.activeChatId) return;
  input.value = "";
  $("sendButton").disabled = true;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    renderMessages(payload.messages || []);
    if (payload.requiresAutopilotAuth && payload.triggerRequest) {
      setStatus("Authorizing pipeline");
      const autopilotAuthorization = await signNip98Request(payload.triggerRequest);
      const started = await api(`/api/pipeline-runs/${encodeURIComponent(payload.runId)}/start`, {
        method: "POST",
        body: JSON.stringify({ autopilotAuthorization }),
      });
      renderMessages(started.messages || []);
    }
    await loadChats();
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("sendButton").disabled = false;
    input.focus();
  }
}

async function signNip98Request(triggerRequest) {
  if (!window.nostr) throw new Error("No Nostr browser extension was found.");
  const tags = [
    ["u", triggerRequest.url],
    ["method", triggerRequest.method || "POST"],
  ];
  if (triggerRequest.body !== undefined) {
    const bodyJson = JSON.stringify(triggerRequest.body);
    tags.push(["payload", await sha256Hex(bodyJson)]);
  }
  const event = await window.nostr.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  });
  return `Nostr ${base64Utf8(JSON.stringify(event))}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    if (state.route === "/chat" && state.activeChatId && state.token) {
      await loadActiveChat().catch(() => undefined);
      await loadChats().catch(() => undefined);
    }
  }, 1500);
}

$("loginButton").addEventListener("click", login);
$("logoutButton").addEventListener("click", logout);
$("newChatButton").addEventListener("click", newChat);
$("homeActButton").addEventListener("click", () => {
  state.activeKindlingView = "companies";
  localStorage.setItem("kindling_view", "companies");
  navigate("/act");
});
$("homeServiceButton").addEventListener("click", () => {
  state.activeKindlingView = "service";
  localStorage.setItem("kindling_view", "service");
  navigate("/act");
});
$("homeTargetsButton").addEventListener("click", () => {
  state.activeKindlingView = "targets";
  localStorage.setItem("kindling_view", "targets");
  navigate("/act");
});
$("homeReviewButton").addEventListener("click", () => {
  state.activeKindlingView = "today";
  localStorage.setItem("kindling_view", "today");
  navigate("/act");
});
$("homeChatButton").addEventListener("click", () => navigate("/chat"));
$("homeSettingsButton").addEventListener("click", () => navigate("/settings"));
$("settingsHomeButton").addEventListener("click", () => navigate("/"));
$("saveSettingsButton").addEventListener("click", saveSettings);
$("loadPipelinesButton").addEventListener("click", loadPipelines);
$("addAccessButton").addEventListener("click", addAccess);
$("pipelineSelect").addEventListener("change", () => {
  if ($("pipelineSelect").value) $("pipelineInput").value = $("pipelineSelect").value;
});
$("composer").addEventListener("submit", sendMessage);
$("actPage").addEventListener("submit", handleKindlingSubmit);
$("actPage").addEventListener("click", (event) => {
  void handleKindlingClick(event);
});
$("actPage").addEventListener("change", handleKindlingChange);
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

window.addEventListener("popstate", () => {
  void renderRoute();
});

if (state.token) bootApp();
else showOnly("login");
