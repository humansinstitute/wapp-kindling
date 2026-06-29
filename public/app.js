import { nip19, getPublicKey, finalizeEvent } from "/vendor/nostr-signer.js";

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
  activeKindlingView: localStorage.getItem("kindling_view") || "service",
  selectedCompanyId: localStorage.getItem("kindling_company") || "",
  selectedTargetId: localStorage.getItem("kindling_target") || "",
  kindlingFilters: loadKindlingFilters(),
  kindlingPaging: {
    companies: 0,
    enriched: 0,
    targets: 0,
    industries: 0,
    workQueue: 0,
  },
  kindling: null,
  scanJobDetail: null,
  companyDetail: null,
  companyProfileOpen: false,
  companyCreateOpen: false,
  kindlingStatus: "Ready",
  pollTimer: null,
  athena: { open: false, pinned: localStorage.getItem("athena_pinned") === "1" },
  athenaPollTimer: null,
  route: window.location.pathname,
  profiles: loadProfileCache(),
  focus: { items: [], index: 0, loaded: false, loading: false, error: "", contactPage: 0 },
  // Shared company-details overlay, openable from the On Deck deck or the
  // Companies list. `target` carries the scored-assessment context when we have
  // it (On Deck); from the plain Companies list it stays null.
  companyModal: { open: false, companyId: "", company: null, target: null, detail: null, loading: false, draftIndex: 0 },
  servicePage: { profile: null, loaded: false, loading: false, error: "" },
  companyListPage: { companies: [], total: 0, offset: 0, band: "high", bandCounts: null, loaded: false, loading: false, error: "" },
  resultsPage: { tab: "waiting", items: [], total: 0, offset: 0, q: "", counts: null, loaded: false, loading: false, error: "" },
  reasonModal: null,
  navCollapsed: localStorage.getItem("kindling_nav_collapsed") === "1",
  userProfile: null,
  // In-memory Nostr signer for the current page session. Either an extension
  // signer or an nsec signer; never persisted. Re-derived lazily for the
  // extension, but a pasted-nsec signer is lost on reload by design.
  signer: null,
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

const KINDLING_ROUTE_TO_VIEW = {
  "/act": "service",
  "/service-offerings": "service",
  "/serviceofferings": "service",
  "/companies": "companies",
  "/enriched-companies": "enriched",
  "/enriched": "enriched",
  "/targets": "targets",
  "/match": "match",
  "/researchdesk": "research",
  "/research-desk": "research",
};

const KINDLING_VIEW_TO_ROUTE = {
  service: "/service-offerings",
  companies: "/companies",
  enriched: "/enriched-companies",
  targets: "/targets",
  match: "/match",
  research: "/researchdesk",
  admin: "/settings",
};

function normalizedPath(pathname = window.location.pathname) {
  const path = pathname.replace(/\/+$/, "");
  return path || "/";
}

function kindlingViewForPath(pathname = window.location.pathname) {
  const path = normalizedPath(pathname);
  if (KINDLING_ROUTE_TO_VIEW[path]) return KINDLING_ROUTE_TO_VIEW[path];
  const match = Object.entries(KINDLING_ROUTE_TO_VIEW)
    .find(([route]) => route !== "/act" && path.endsWith(route));
  return match ? match[1] : null;
}

function routeForKindlingView(view) {
  return KINDLING_VIEW_TO_ROUTE[view] || "/service-offerings";
}

function setKindlingView(view) {
  state.activeKindlingView = view;
  localStorage.setItem("kindling_view", view);
}

function appRoute() {
  const pathname = normalizedPath();
  if (["/chat", "/settings", "/menu", "/results"].includes(pathname)) return pathname;
  const view = kindlingViewForPath(pathname);
  if (view === "service") return "/service";
  if (view === "companies") return "/companies-list";
  if (view) return "/act";
  return "/";
}

function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  state.route = path;
  void renderRoute();
}

// Which sidebar nav item each content section belongs to (null = no sidebar).
const SECTION_NAV = {
  focus: "deck",
  servicePage: "service",
  companyListPage: "companies",
  resultsPage: "results",
  shell: "chats",
  settingsPage: "settings",
};

function showOnly(id) {
  for (const sectionId of ["login", "focus", "servicePage", "companyListPage", "resultsPage", "home", "actPage", "settingsPage", "shell"]) {
    $(sectionId).classList.toggle("hidden", sectionId !== id);
  }
  const navKey = SECTION_NAV[id] || null;
  setChrome(navKey);
  syncAthenaLauncher();
}

// Persistent left drawer shown on the primary app screens. Hidden on login,
// chat, the old menu hub, and the scored/match drilldown (which has its own chrome).
function setChrome(activeNav) {
  const nav = $("appNav");
  const app = $("app");
  if (!activeNav) {
    nav.classList.add("hidden");
    app.classList.remove("withNav");
    return;
  }
  nav.classList.remove("hidden");
  app.classList.add("withNav");
  app.classList.toggle("navCollapsed", state.navCollapsed);
  nav.classList.toggle("collapsed", state.navCollapsed);
  renderAppNav(activeNav);
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

  if (state.route === "/service") {
    showOnly("servicePage");
    await loadServicePage();
    return;
  }

  if (state.route === "/companies-list") {
    showOnly("companyListPage");
    await loadCompanyListPage();
    return;
  }

  if (state.route === "/results") {
    showOnly("resultsPage");
    await loadResultsPage();
    return;
  }

  if (state.route === "/act") {
    const view = kindlingViewForPath(window.location.pathname);
    if (view) setKindlingView(view);
    showOnly("actPage");
    await loadKindlingScreen();
    return;
  }

  if (state.route === "/menu") {
    showOnly("home");
    return;
  }

  // Default landing after login: the On Deck call list.
  showOnly("focus");
  await loadFocusScreen();
}

// The first screen after login: the top-ranked, not-yet-contacted companies
// shown one at a time so the user can flick through their call list.
let focusLoadSeq = 0;
async function loadFocusScreen({ force = false } = {}) {
  if (state.focus.loaded && !force) {
    renderFocus();
    return;
  }
  const seq = ++focusLoadSeq;
  state.focus.loading = true;
  state.focus.error = "";
  renderFocus();
  try {
    // Pull a few extra so we can drop already-contacted companies and still
    // land on a full top-21 call list.
    const data = await api("/api/kindling/top-targets?band=high&limit=40&excludeOutreach=1");
    if (seq !== focusLoadSeq) return;
    const items = (data.targets || [])
      .filter((target) => (target.company?.dataRing || "") !== "contacted")
      .slice(0, 21);
    state.focus.items = items;
    state.focus.index = 0;
    state.focus.loaded = true;
    state.focus.loading = false;
    renderFocus();
    if (!$("appNav").classList.contains("hidden")) renderAppNav("deck");
  } catch (err) {
    if (seq !== focusLoadSeq) return;
    state.focus.loading = false;
    state.focus.error = err?.message || String(err);
    renderFocus();
  }
}

function focusStep(delta) {
  const total = state.focus.items.length;
  if (!total) return;
  const next = state.focus.index + delta;
  if (next < 0 || next >= total) return;
  state.focus.index = next;
  state.focus.contactPage = 0; // reset contact pager when the card changes
  renderFocus();
}

// Page through a long decision-maker list within the current card (3 at a time).
function focusContactStep(delta) {
  state.focus.contactPage = Math.max(0, state.focus.contactPage + delta);
  renderFocus();
}

function focusOpenCurrent() {
  const item = state.focus.items[state.focus.index];
  if (!item) return;
  const companyId = item.companyId || item.company?.id || "";
  state.selectedTargetId = item.id || "";
  state.selectedCompanyId = companyId;
  localStorage.setItem("kindling_target", state.selectedTargetId);
  localStorage.setItem("kindling_company", state.selectedCompanyId);
  openCompanyModal({ companyId, target: item, company: item.company || item });
}

// Open the shared company-details overlay. `target` is the scored assessment
// (On Deck) when available; `company` is whatever summary record we already
// have so the modal paints instantly, then we hydrate the full record in the
// background.
function openCompanyModal({ companyId, target = null, company = null }) {
  state.companyModal = {
    open: true,
    companyId: companyId || "",
    company: company || target?.company || null,
    target,
    detail: null,
    loading: !!companyId,
    draftIndex: 0,
  };
  renderCompanyModal();
  if (companyId) void loadCompanyModalDetail(companyId);
}

async function loadCompanyModalDetail(companyId) {
  try {
    const detail = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}`);
    if (!state.companyModal.open || state.companyModal.companyId !== companyId) return;
    state.companyModal.detail = detail;
    state.companyModal.loading = false;
    renderCompanyModal();
  } catch (err) {
    if (!state.companyModal.open || state.companyModal.companyId !== companyId) return;
    state.companyModal.loading = false;
    renderCompanyModal();
  }
}

async function saveCompanyFeedback(button) {
  const companyId = state.companyModal.companyId;
  if (!companyId) return;
  const verdict = document.querySelector("#companyFeedback [data-feedback-verdict].active")?.dataset.feedbackVerdict || "";
  const labels = Array.from(document.querySelectorAll("#companyFeedback [data-feedback-label].active"))
    .map((b) => b.dataset.feedbackLabel);
  const note = (document.getElementById("feedbackNote")?.value || "").trim();
  if (!verdict && !labels.length && !note) { alert("Add a verdict, a label, or a reason first."); return; }
  setBusyElement(button, true, "Saving");
  try {
    const data = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ verdict, labels, note }),
    });
    if (state.companyModal.open && state.companyModal.companyId === companyId && state.companyModal.detail) {
      state.companyModal.detail.feedback = data.feedback;
    }
    setBusyElement(button, false);
    if (button?.isConnected) {
      button.textContent = "Saved ✓";
      setTimeout(() => { if (button.isConnected) button.textContent = "Save feedback"; }, 1600);
    }
  } catch (err) {
    setBusyElement(button, false);
    alert(`Couldn't save feedback: ${err?.message || err}`);
  }
}

function closeCompanyModal() {
  if (!state.companyModal.open) return;
  state.companyModal = { open: false, companyId: "", company: null, target: null, detail: null, loading: false, draftIndex: 0 };
  renderCompanyModal();
}

function companyModalDraftStep(delta) {
  const drafts = state.companyModal.detail?.drafts || [];
  if (drafts.length < 2) return;
  const next = Math.min(Math.max(0, state.companyModal.draftIndex + delta), drafts.length - 1);
  if (next === state.companyModal.draftIndex) return;
  state.companyModal.draftIndex = next;
  renderCompanyModal();
}

function companyModalDraftCopy(button) {
  const drafts = state.companyModal.detail?.drafts || [];
  const draft = drafts[Math.min(Math.max(0, state.companyModal.draftIndex), drafts.length - 1)];
  const text = draft?.pitchText || draft?.body || "";
  if (!text) return;
  const done = () => {
    if (!button) return;
    const original = button.textContent;
    button.textContent = "Copied ✓";
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  }
}

// "Sent email" from the call list → move the company to the Waiting list and
// drop it from the deck.
async function focusSentCurrent(trigger) {
  const item = state.focus.items[state.focus.index];
  if (!item) return;
  const companyId = item.companyId || item.company?.id;
  if (!companyId) return;
  setBusyElement(trigger, true, "Saving");
  try {
    await api("/api/kindling/outreach/sent", { method: "POST", body: JSON.stringify({ companyId, channel: "email" }) });
    removeFocusItem(companyId);
  } catch (err) {
    setBusyElement(trigger, false);
    alert(`Couldn't save: ${err?.message || err}`);
  }
}

function renderWebsiteLink(website) {
  const href = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const label = website.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return `<a class="focusLink" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
}

function renderDecisionMakers(people, opts = {}) {
  if (!Array.isArray(people) || !people.length) return "";
  // On the deck card we page through contacts 3 at a time so the card stays
  // short; the details overlay passes no pager and shows everyone.
  const pageSize = opts.pageSize || 0;
  let shown = people;
  let pager = "";
  if (pageSize && people.length > pageSize) {
    const pageCount = Math.ceil(people.length / pageSize);
    const page = Math.min(Math.max(0, opts.page || 0), pageCount - 1);
    const start = page * pageSize;
    shown = people.slice(start, start + pageSize);
    pager = `
      <nav class="focusContactPager" aria-label="Browse contacts">
        <button type="button" class="focusContactArrow" data-focus-action="contacts-prev" ${page <= 0 ? "disabled" : ""} aria-label="Previous contacts">‹</button>
        <span class="focusContactPosition">${start + 1}–${start + shown.length} of ${people.length}</span>
        <button type="button" class="focusContactArrow" data-focus-action="contacts-next" ${page >= pageCount - 1 ? "disabled" : ""} aria-label="More contacts">›</button>
      </nav>`;
  }
  return `
    <section class="focusContacts">
      <h3 class="focusContactsTitle">Decision makers</h3>
      <div class="focusContactList">
        ${shown.map((person) => {
          const name = person.name || "Unknown";
          const title = person.title || person.role || "";
          const phone = person.phone || person.mobile || "";
          const email = person.email || "";
          const initials = name.split(/\s+/).map((part) => part[0] || "").slice(0, 2).join("").toUpperCase() || "?";
          const lines = [];
          if (phone) lines.push(`<a class="focusContactChip" href="tel:${escapeHtml(phone.replace(/\s+/g, ""))}">📞 ${escapeHtml(phone)}</a>`);
          if (email) lines.push(`<a class="focusContactChip" href="mailto:${escapeHtml(email)}">✉️ ${escapeHtml(email)}</a>`);
          if (person.linkedinUrl) lines.push(`<a class="focusContactChip" href="${escapeHtml(person.linkedinUrl)}" target="_blank" rel="noopener">in</a>`);
          return `
            <div class="focusContact">
              <span class="focusContactAvatar">${escapeHtml(initials)}</span>
              <div class="focusContactBody">
                <div class="focusContactName">${escapeHtml(name)}${title ? ` <span class="focusContactRole">${escapeHtml(title)}</span>` : ""}</div>
                ${lines.length ? `<div class="focusContactLinks">${lines.join("")}</div>` : `<div class="focusContactLinks focusContactMuted">No direct contact captured</div>`}
              </div>
            </div>`;
        }).join("")}
      </div>
      ${pager}
    </section>`;
}

function renderFocusCard(target, index, total) {
  const company = target.company || target;
  const name = company.name || target.name || "Unknown company";
  const offering = target.bestOffering?.name || target.bestOfferingName || "No offering selected";
  const score = Math.round(Number(target.assessmentScore || target.score || 0));
  const confidence = Math.round(Number(target.confidence || 0) * 100);
  const meta = [company.industry, company.location].filter(Boolean).join(" · ");
  const reason = target.reason || target.whyNow || "No reasoning captured yet.";
  const website = company.website || "";
  const people = Array.isArray(target.decisionMakers) && target.decisionMakers.length
    ? target.decisionMakers
    : (Array.isArray(company.decisionMakers) ? company.decisionMakers : []);
  // Number of cards still behind this one — drives how many ghost "stack"
  // layers show (capped at 2). Purely decorative, no real card underneath.
  const depth = Math.min(2, Math.max(0, total - index - 1));
  return `
    <div class="focusCardStack" data-depth="${depth}">
    <article class="focusCard">
      <div class="focusCardTop">
        <span class="focusRank">#${index + 1}</span>
        <span class="focusScore">${score} fit</span>
        ${confidence ? `<span class="focusConfidence">confidence ${confidence}%</span>` : ""}
      </div>
      <h2 class="focusName">${escapeHtml(name)}</h2>
      ${meta ? `<p class="focusMeta">${escapeHtml(meta)}</p>` : ""}
      ${website ? `<p class="focusWebsite">${renderWebsiteLink(website)}</p>` : ""}
      <p class="focusOffering">${escapeHtml(offering)}</p>
      <p class="focusReason">${escapeHtml(reason)}</p>
      ${renderDecisionMakers(people, { pageSize: 3, page: state.focus.contactPage })}
      <div class="focusActions">
        <button type="button" class="focusAction focusActionSent" data-focus-action="reach">Reach out →</button>
        <button type="button" class="focusAction focusActionSnooze" data-focus-action="snooze">Snooze</button>
        <button type="button" class="focusAction focusActionDismiss" data-focus-action="dismiss">Dismiss</button>
        <button type="button" class="focusAction focusActionGhost" data-focus-action="details">View details</button>
      </div>
    </article>
    </div>
    <nav class="focusNav" aria-label="Browse call list">
      <button type="button" class="focusArrow" data-focus-action="prev" ${index <= 0 ? "disabled" : ""} aria-label="Previous company">‹</button>
      <span class="focusPosition">${index + 1} of ${total}</span>
      <button type="button" class="focusArrow" data-focus-action="next" ${index >= total - 1 ? "disabled" : ""} aria-label="Next company">›</button>
    </nav>
    <p class="focusHint">Use ← / → or the arrows to flick through your top ${total}.</p>
  `;
}

function focusGreetingName() {
  const name = state.userProfile?.displayName || state.userProfile?.name || "";
  const first = name.trim().split(/\s+/)[0];
  return first || "there";
}

function focusGreetingTime() {
  const hour = new Date().getHours();
  if (hour < 12) return "Morning";
  if (hour < 18) return "Afternoon";
  return "Evening";
}

function renderFocus() {
  const body = $("focusBody");
  if (!body) return;
  const total = state.focus.items.length;
  if (state.focus.index >= total) state.focus.index = Math.max(0, total - 1);

  let lead;
  if (state.focus.loading && !state.focus.loaded) {
    lead = `<p class="focusLead">Loading your deck…</p>`;
  } else if (state.focus.error) {
    lead = `<p class="focusLead">Couldn't load the deck.</p>`;
  } else if (!total) {
    lead = `<p class="focusLead">No fresh cards. You're all caught up.</p>`;
  } else {
    lead = `<p class="focusLead"><strong>${total} fresh.</strong> Best fit first.</p>
      <p class="focusDeckCount">Today's deck — ${state.focus.index + 1} of ${total}</p>`;
  }

  let stage;
  if (state.focus.loading && !state.focus.loaded) {
    stage = `<div class="focusStage"><div class="focusCard focusCardSkeleton" aria-busy="true"></div></div>`;
  } else if (state.focus.error) {
    stage = `<div class="focusStage">
      <p class="focusEmpty">Couldn't load the deck: ${escapeHtml(state.focus.error)}</p>
      <button type="button" class="focusOpen" data-focus-action="retry">Retry</button>
    </div>`;
  } else if (!total) {
    stage = `<div class="focusStage"><p class="focusEmpty">No ranked companies waiting for outreach. Run scoring or check the Scored view.</p></div>`;
  } else {
    stage = `<div class="focusStage">${renderFocusCard(state.focus.items[state.focus.index], state.focus.index, total)}</div>`;
  }

  body.innerHTML = `
    <header class="focusGreeting">
      <h1>${focusGreetingTime()}, ${escapeHtml(focusGreetingName())}</h1>
      ${lead}
    </header>
    ${stage}
  `;
}

// Keys already surfaced in dedicated sections (or internal plumbing) — skip them
// in the generic "Enriched details" grid so we don't repeat or leak noise.
const FOCUS_PROFILE_HIDDEN_KEYS = new Set([
  "decisionMakers", "gaps", "parkedReason", "nextQuestions", "response",
  "changeSummary", "services", "servicesOffered", "signals", "evidence",
]);

// Signals get a dedicated card — each one a clean stacked block (type → summary →
// meta → source) instead of the cramped key/value columns the generic renderer
// produced.
function renderCompanySignals(signals, loading) {
  if (!signals.length) return `<p class="focusDetailEmpty">${loading ? "Loading signals…" : "No signals captured yet."}</p>`;
  return `<div class="signalList">
    ${signals.map((signal) => {
      const type = labelFromKey(signal.signalType || signal.type || "Signal");
      const summary = signal.summary || signal.description || "";
      const strength = signal.strength ? `${signal.strength} strength` : "";
      const confidence = signal.confidence ? `${Math.round(Number(signal.confidence) * 100)}% confidence` : "";
      const when = signal.observedDate || "";
      const meta = [strength, confidence, when].filter(Boolean).join(" · ");
      const url = signal.sourceUrl || signal.url || "";
      return `
        <div class="signalItem">
          <div class="signalHead">
            <span class="signalType">${escapeHtml(type)}</span>
            ${signal.adaptRelevance ? `<span class="signalRelevance">${escapeHtml(signal.adaptRelevance)}</span>` : ""}
          </div>
          ${summary ? `<p class="signalSummary">${escapeHtml(summary)}</p>` : ""}
          <div class="signalFoot">
            ${meta ? `<span class="signalMeta">${escapeHtml(meta)}</span>` : ""}
            ${url ? `<a class="signalSource" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Source ↗</a>` : ""}
          </div>
        </div>`;
    }).join("")}
  </div>`;
}

// Issue labels a reviewer can flag on a company. Mirrors COMPANY_ISSUE_LABELS on
// the server; the detail payload also carries the authoritative list.
const COMPANY_ISSUE_LABELS = [
  { key: "wrong_fit", label: "Wrong fit" },
  { key: "missing_decision_maker", label: "Missing decision maker" },
  { key: "duplicate", label: "Duplicate" },
  { key: "bad_website", label: "Bad website / no website" },
  { key: "bad_outreach", label: "Bad outreach" },
  { key: "wrong_industry", label: "Wrong industry" },
];

// Reviewer feedback card: a good/bad verdict, issue-label chips, and a reason.
// Toggles are handled with direct class flips (no re-render) so the note keeps
// focus while editing; the current selection is read from the DOM on save.
function renderCompanyFeedback(detail) {
  const feedback = detail?.feedback || null;
  const labels = (detail?.issueLabels && detail.issueLabels.length) ? detail.issueLabels : COMPANY_ISSUE_LABELS;
  const selectedLabels = new Set(feedback?.labels || []);
  const verdict = feedback?.verdict || "";
  const canEdit = Boolean(state.me?.access?.edit);
  const savedNote = feedback?.updatedAt
    ? `<span class="feedbackSaved">Saved ${escapeHtml(shortDate(feedback.updatedAt))}</span>`
    : "";
  return `
    <section class="focusDetailCard companyFeedbackCard" id="companyFeedback">
      <h3>Reviewer feedback ${savedNote}</h3>
      <div class="feedbackVerdicts">
        <button type="button" class="feedbackVerdictBtn feedbackVerdictGood ${verdict === "good" ? "active" : ""}" data-feedback-verdict="good" ${canEdit ? "" : "disabled"}>👍 Good result</button>
        <button type="button" class="feedbackVerdictBtn feedbackVerdictBad ${verdict === "bad" ? "active" : ""}" data-feedback-verdict="bad" ${canEdit ? "" : "disabled"}>👎 Bad result</button>
      </div>
      <p class="feedbackHint">Flag any issues</p>
      <div class="feedbackLabels">
        ${labels.map((l) => `<button type="button" class="feedbackChip ${selectedLabels.has(l.key) ? "active" : ""}" data-feedback-label="${escapeHtml(l.key)}" ${canEdit ? "" : "disabled"}>${escapeHtml(l.label)}</button>`).join("")}
      </div>
      <textarea class="feedbackNote" id="feedbackNote" rows="2" placeholder="Reason (optional)" ${canEdit ? "" : "disabled"}>${escapeHtml(feedback?.note || "")}</textarea>
      ${canEdit ? `<div class="feedbackActions">
        <button type="button" class="feedbackSave" data-feedback-save>Save feedback</button>
      </div>` : ""}
    </section>`;
}

// Render the shared company-details overlay into its global mount node so it can
// float above any screen (On Deck deck, Companies list, …).
function renderCompanyModal() {
  const root = $("companyModalRoot");
  if (!root) return;
  const modal = state.companyModal;
  if (!modal.open) { root.innerHTML = ""; return; }

  const detail = modal.detail;
  const target = modal.target;
  const company = detail?.company || modal.company || target?.company || {};
  const name = company.name || target?.name || "Unknown company";
  const profile = company.profile || {};
  const sources = detail?.sources || [];
  const drafts = detail?.drafts || [];
  const signals = Array.isArray(detail?.signals) ? detail.signals
    : (Array.isArray(profile.signals) ? profile.signals : []);
  const loading = modal.loading;

  // Prefer the deck's scored target. When the modal is opened from the Company
  // List there's no target, so fall back to the company's best stored service-fit
  // assessment (from the detail payload) — same "why this fit", offering, score,
  // caveats and next action the deck shows, instead of a bare facts card.
  const assessments = Array.isArray(detail?.serviceFitAssessments) ? detail.serviceFitAssessments : [];
  const bestAssessment = assessments.reduce((best, a) => (!best || Number(a.score || 0) > Number(best.score || 0)) ? a : best, null);
  const hasAssessment = !!target || !!bestAssessment;
  const offering = target?.bestOffering?.name || target?.bestOfferingName || bestAssessment?.serviceOffering?.name || "";
  const score = Math.round(Number(target?.assessmentScore || target?.score || bestAssessment?.score || 0));
  // Best fit score to surface in the header — from the deck assessment when we
  // have one, else the company's best service-fit assessment (detail payload),
  // else the score carried on the list-row record.
  const bestAssessmentScore = bestAssessment ? Number(bestAssessment.score || 0) : 0;
  const headerFitRaw = target
    ? score
    : (bestAssessmentScore || (modal.company?.fitScore != null ? Number(modal.company.fitScore) : 0));
  const headerFit = headerFitRaw ? Math.round(headerFitRaw) : null;
  const headerFitBand = headerFit == null ? "" : (headerFit >= 75 ? "high" : headerFit >= 50 ? "medium" : "low");
  const confidence = Math.round(Number(target?.confidence ?? bestAssessment?.confidence ?? company.confidence ?? 0) * 100);
  const reason = target?.reason || target?.whyNow || bestAssessment?.fitExplanation || "No reasoning captured yet.";
  const nextAction = target?.nextAction || bestAssessment?.recommendedAction || "";
  const caveats = (Array.isArray(target?.caveats) && target.caveats.length) ? target.caveats
    : (Array.isArray(bestAssessment?.caveats) ? bestAssessment.caveats : []);
  // Decision makers: the deck target carries a mapped list; opening from the list
  // we use the detail payload's people (the company profile's decisionMakers).
  const people = (Array.isArray(target?.decisionMakers) && target.decisionMakers.length) ? target.decisionMakers
    : (Array.isArray(detail?.people) && detail.people.length) ? detail.people
    : (Array.isArray(company.decisionMakers) ? company.decisionMakers : []);
  const services = Array.isArray(profile.services) ? profile.services
    : (Array.isArray(profile.servicesOffered) ? profile.servicesOffered : []);

  const eyebrow = [stageLabel(company.enrichmentStatus), hasAssessment ? `${score} fit` : "", confidence ? `${confidence}% confidence` : ""]
    .filter(Boolean).join(" · ");

  const whyCard = hasAssessment ? `
    <section class="focusDetailCard">
      <h3>Why this fit</h3>
      <p class="focusReason">${escapeHtml(reason)}</p>
      ${nextAction ? `<p class="focusNext"><strong>Next:</strong> ${escapeHtml(nextAction)}</p>` : ""}
      ${caveats.length ? `<p class="focusCaveats"><strong>Caveats:</strong> ${escapeHtml(caveats.join("; "))}</p>` : ""}
      <dl class="focusDetailFacts">
        ${offering ? `<div><dt>Best offering</dt><dd>${escapeHtml(offering)}</dd></div>` : ""}
        <div><dt>Fit score</dt><dd>${score} / 100</dd></div>
        ${confidence ? `<div><dt>Confidence</dt><dd>${confidence}%</dd></div>` : ""}
      </dl>
    </section>` : `
    <section class="focusDetailCard">
      <h3>Company</h3>
      <dl class="focusDetailFacts">
        <div><dt>Industry</dt><dd>${escapeHtml(company.industry || "Unknown")}</dd></div>
        <div><dt>Location</dt><dd>${escapeHtml(company.location || "Unknown")}</dd></div>
        <div><dt>Stage</dt><dd>${escapeHtml(stageLabel(company.enrichmentStatus))}</dd></div>
        ${confidence ? `<div><dt>Confidence</dt><dd>${confidence}%</dd></div>` : ""}
      </dl>
    </section>`;

  root.innerHTML = `
    <div class="modalBackdrop focusDetailBackdrop" data-modal-action="close">
      <section class="modalPanel focusDetailPanel" role="dialog" aria-modal="true" aria-label="Company details" data-modal-panel>
        <header class="focusDetailHeader">
          <div class="focusDetailHeading">
            <div class="eyebrow">${escapeHtml(eyebrow)}</div>
            <h2>${escapeHtml(name)}</h2>
            <p class="focusDetailMeta">${escapeHtml([company.industry, company.location].filter(Boolean).join(" · ") || "")}
              ${company.website ? ` · ${renderWebsiteLink(company.website)}` : ""}</p>
          </div>
          <div class="focusDetailHeaderRight">
            ${headerFit != null ? `<span class="focusDetailFit resultFit resultFit-${headerFitBand}">${headerFit} fit</span>` : ""}
            <button type="button" class="focusDetailClose" data-modal-action="close" aria-label="Close">✕</button>
          </div>
        </header>

        <div class="focusDetailBody">
          <div class="focusDetailColumns">
            ${whyCard}
            <section class="focusDetailCard">
              <h3>Decision makers</h3>
              ${people.length ? renderDecisionMakers(people) : `<p class="focusDetailEmpty">${loading ? "Loading contacts…" : "No named contacts captured yet."}</p>`}
            </section>
          </div>

          ${renderFocusDrafts(drafts, loading)}

          ${modal.companyId ? renderCompanyFeedback(detail) : ""}

          ${services.length ? `
          <section class="focusDetailCard">
            <h3>Services offered</h3>
            ${renderProfileValueHtml(services)}
          </section>` : ""}

          <section class="focusDetailCard">
            <h3>Enriched details</h3>
            ${renderFocusProfile(profile, loading)}
          </section>

          ${signals.length || loading ? `
          <section class="focusDetailCard">
            <h3>Signals</h3>
            ${renderCompanySignals(signals, loading)}
          </section>` : ""}

          <section class="focusDetailCard">
            <h3>Sources</h3>
            <div class="sourceList">
              ${sources.map((source) => `
                <a href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer">
                  <strong>${escapeHtml(source.title || source.sourceType || source.url || "Source")}</strong>
                  <span>${escapeHtml(source.sourceType || "")}${source.confidence ? ` · confidence ${Number(source.confidence || 0).toFixed(2)}` : ""}</span>
                </a>
              `).join("") || `<p class="focusDetailEmpty">${loading ? "Loading sources…" : "No sources recorded yet."}</p>`}
            </div>
          </section>
        </div>
      </section>
    </div>`;
}

// The draft outreach is the payoff of the whole deck — give it pride of place at
// the top of the modal, and let the user flick through variants if there's more
// than one.
function renderFocusDrafts(drafts, loading) {
  if (!drafts.length) {
    return `
      <section class="focusDraftCard focusDraftEmpty">
        <div class="focusDraftLabel">✷ Draft outreach</div>
        <p class="focusDetailEmpty">${loading ? "Loading drafts…" : "No outreach draft written yet."}</p>
      </section>`;
  }
  const total = drafts.length;
  const idx = Math.min(Math.max(0, state.companyModal.draftIndex), total - 1);
  const draft = drafts[idx];
  const text = draft.pitchText || draft.body || "";
  const label = draft.variantLabel ? escapeHtml(draft.variantLabel) : "";
  // Position + label of the current variant, e.g. "2 of 3 · Consultative".
  const meta = total > 1
    ? `${idx + 1} of ${total}${label ? ` · ${label}` : ""}`
    : label;
  return `
    <section class="focusDraftCard">
      <div class="focusDraftTop">
        <div class="focusDraftLabel">✷ Draft outreach${meta ? ` <span class="focusDraftCount">${meta}</span>` : ""}</div>
        <div class="focusDraftControls">
          ${total > 1 ? `
            <button type="button" class="focusDraftNav" data-modal-action="draft-prev" ${idx <= 0 ? "disabled" : ""} aria-label="Previous draft">‹</button>
            <button type="button" class="focusDraftNav" data-modal-action="draft-next" ${idx >= total - 1 ? "disabled" : ""} aria-label="Next draft">›</button>
          ` : ""}
          <button type="button" class="focusDraftCopy" data-modal-action="draft-copy">Copy</button>
        </div>
      </div>
      <div class="focusDraftText markdownBody" id="focusDraftText">${renderMarkdown(text) || `<span class="focusDetailEmpty">This draft is empty.</span>`}</div>
    </section>`;
}

// Curated, human-readable rendering of the enriched profile blob — no raw JSON.
function renderFocusProfile(profile, loading) {
  const entries = Object.entries(profile || {})
    .filter(([key]) => !FOCUS_PROFILE_HIDDEN_KEYS.has(key))
    .filter(([, value]) => !isEmptyProfileValue(value));
  if (!entries.length) return `<p class="focusDetailEmpty">${loading ? "Loading details…" : "No enriched profile captured yet."}</p>`;
  return `<div class="focusProfileGrid">
    ${entries.map(([key, value]) => `
      <div class="focusProfileField">
        <span class="focusProfileLabel">${escapeHtml(labelFromKey(key))}</span>
        <div class="focusProfileValue">${renderProfileValueHtml(value) || "—"}</div>
      </div>
    `).join("")}
  </div>`;
}

function isEmptyProfileValue(value) {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

// Recursively render an arbitrary profile value as readable HTML. Arrays of
// scalars become chips, arrays of objects become stacked sub-cards, objects
// become labelled rows. Never falls back to JSON.stringify.
function renderProfileValueHtml(value) {
  if (isEmptyProfileValue(value)) return "";
  if (Array.isArray(value)) {
    const scalars = value.every((entry) => entry === null || typeof entry !== "object");
    if (scalars) {
      return `<div class="profileChips">${value.map((entry) => `<span class="profileChip">${escapeHtml(String(entry))}</span>`).join("")}</div>`;
    }
    return `<div class="profileSubList">${value.map((entry) => `<div class="profileSubItem">${renderProfileValueHtml(entry)}</div>`).join("")}</div>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => !isEmptyProfileValue(entry));
    if (!entries.length) return "";
    return `<dl class="profileNested">${entries.map(([key, entry]) => `
      <div><dt>${escapeHtml(labelFromKey(key))}</dt><dd>${renderProfileValueHtml(entry)}</dd></div>
    `).join("")}</dl>`;
  }
  const text = String(value);
  if (/^https?:\/\//i.test(text)) {
    return `<a href="${escapeHtml(text)}" target="_blank" rel="noreferrer">${escapeHtml(text.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`;
  }
  return escapeHtml(text);
}

// ---- Sidebar drawer -------------------------------------------------------

const APP_NAV_ITEMS = [
  { key: "deck", label: "On Deck", route: "/", icon: "deck" },
  { key: "service", label: "Service Offering", route: "/service-offerings", icon: "offering" },
  { key: "companies", label: "Company List", route: "/companies", icon: "companies" },
  { key: "results", label: "Results", route: "/results", icon: "results" },
  { key: "chats", label: "Chats", route: "/chat", icon: "chats" },
  { key: "settings", label: "Settings", route: "/settings", icon: "settings" },
];

const NAV_ICONS = {
  deck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  offering: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/></svg>',
  companies: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="9" width="8" height="11" rx="1"/></svg>',
  results: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M13 16V8"/><path d="M18 16v-3"/></svg>',
  chats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.5L3 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h5l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1Z"/></svg>',
};

function navCountFor(key) {
  if (key === "deck") return state.focus.loaded ? state.focus.items.length : null;
  if (key === "companies") {
    const counts = state.companyListPage.bandCounts;
    if (!counts) return null;
    return Number(counts.high || 0) + Number(counts.medium || 0) + Number(counts.low || 0) + Number(counts.notScored || 0);
  }
  if (key === "service") {
    const services = state.servicePage.profile?.version?.structured?.services;
    return Array.isArray(services) ? services.length : null;
  }
  if (key === "results") {
    const counts = state.resultsPage.counts;
    if (!counts) return null;
    // Badge = things still awaiting a response (waiting + aged-out).
    return Number(counts.waiting || 0) + Number(counts.no_response || 0);
  }
  return null;
}

function renderAppNav(activeKey) {
  const list = $("appNavList");
  if (list) {
    list.innerHTML = APP_NAV_ITEMS.map((item) => {
      const count = navCountFor(item.key);
      return `
        <button type="button" class="appNavItem ${item.key === activeKey ? "active" : ""}" data-nav="${item.route}" title="${escapeHtml(item.label)}">
          <span class="appNavIcon">${NAV_ICONS[item.icon] || ""}</span>
          <span class="appNavLabel">${escapeHtml(item.label)}</span>
          ${count != null ? `<span class="appNavCount">${count}</span>` : ""}
        </button>`;
    }).join("");
  }
  renderAppNavUser();
  const collapse = $("appNavCollapse");
  if (collapse) {
    collapse.textContent = state.navCollapsed ? "⟩" : "⟨";
    collapse.title = state.navCollapsed ? "Expand" : "Collapse";
  }
}

function renderAppNavUser() {
  const el = $("appNavUser");
  if (!el || !state.me) return;
  const profile = state.userProfile;
  const name = profile?.displayName || profile?.name || "Signed in";
  const npub = state.me.npub || "";
  const npubShort = npub ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : "";
  const avatar = profile?.picture
    ? `<img class="appNavAvatarImg" src="${escapeHtml(profile.picture)}" alt="" />`
    : `<span class="appNavAvatarInitial">${escapeHtml((name[0] || "?").toUpperCase())}</span>`;
  el.innerHTML = `
    <div class="appNavUserInner">
      <span class="appNavAvatar">${avatar}</span>
      <span class="appNavUserText">
        <span class="appNavUserName">${escapeHtml(name)}</span>
        <span class="appNavUserNpub">${escapeHtml(npubShort)}</span>
      </span>
      <button type="button" class="appNavLogout" id="appNavLogout" title="Sign out" aria-label="Sign out">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
      </button>
    </div>`;
}

async function ensureUserProfile() {
  if (!state.me?.pubkey || state.userProfile) return;
  try {
    const profile = await resolveProfile({ pubkey: state.me.pubkey });
    state.userProfile = profile;
    renderAppNavUser();
    if (!$("focus").classList.contains("hidden")) renderFocus();
  } catch {}
}

function toggleNavCollapsed() {
  state.navCollapsed = !state.navCollapsed;
  localStorage.setItem("kindling_nav_collapsed", state.navCollapsed ? "1" : "0");
  $("app").classList.toggle("navCollapsed", state.navCollapsed);
  $("appNav").classList.toggle("collapsed", state.navCollapsed);
  const collapse = $("appNavCollapse");
  if (collapse) {
    collapse.textContent = state.navCollapsed ? "⟩" : "⟨";
    collapse.title = state.navCollapsed ? "Expand" : "Collapse";
  }
}

// ---- Service Offering page (read-only profile) ----------------------------

let servicePageSeq = 0;
async function loadServicePage({ force = false } = {}) {
  if (state.servicePage.loaded && !force) {
    renderServicePage();
    return;
  }
  const seq = ++servicePageSeq;
  state.servicePage.loading = true;
  state.servicePage.error = "";
  renderServicePage();
  try {
    const data = await api("/api/kindling/profile");
    if (seq !== servicePageSeq) return;
    state.servicePage.profile = data.profile || null;
    state.servicePage.loaded = true;
    state.servicePage.loading = false;
    renderServicePage();
    if (!$("appNav").classList.contains("hidden")) renderAppNav("service");
  } catch (err) {
    if (seq !== servicePageSeq) return;
    state.servicePage.loading = false;
    state.servicePage.error = err?.message || String(err);
    renderServicePage();
  }
}

function renderServicePage() {
  const el = $("servicePage");
  if (!el) return;
  let body;
  if (state.servicePage.loading && !state.servicePage.loaded) {
    body = `<div class="pageLoading"><span class="kindlingSpinner" aria-hidden="true"></span>Loading service offering…</div>`;
  } else if (state.servicePage.error) {
    body = `<p class="pageError">Couldn't load the service offering: ${escapeHtml(state.servicePage.error)}</p>
      <button type="button" data-page-action="retry-service">Retry</button>`;
  } else {
    body = `<div class="kindlingPanel serviceProfilePanel">${renderServiceProfile(state.servicePage.profile?.version)}</div>`;
  }
  el.innerHTML = `<div class="pageInner serviceOfferingInner">
    <header class="pageTopHeader"><h1>Service Offering</h1></header>
    ${body}
  </div>`;
}

// ---- Company List page (fast full list) -----------------------------------

const COMPANY_PAGE_SIZE = 25;
const COMPANY_BANDS = [
  { key: "high", label: "High Fit", countKey: "high" },
  { key: "medium", label: "Medium Fit", countKey: "medium" },
  { key: "low", label: "Low Fit", countKey: "low" },
  { key: "not_scored", label: "Not Scored", countKey: "notScored" },
];

let companyListSeq = 0;
async function loadCompanyListPage({ force = false } = {}) {
  if (state.companyListPage.loaded && !force) {
    renderCompanyListPage();
    return;
  }
  const seq = ++companyListSeq;
  const page = state.companyListPage;
  page.loading = true;
  page.error = "";
  renderCompanyListPage();
  try {
    const query = new URLSearchParams({
      band: page.band,
      limit: String(COMPANY_PAGE_SIZE),
      offset: String(Math.max(0, Number(page.offset) || 0)),
      withBandCounts: "1",
    });
    const data = await api(`/api/kindling/companies?${query}`);
    if (seq !== companyListSeq) return;
    page.companies = data.companies || [];
    page.total = Number(data.total ?? data.companies?.length ?? 0);
    page.offset = Number(data.offset ?? page.offset ?? 0);
    if (data.bandCounts) page.bandCounts = data.bandCounts;
    page.loaded = true;
    page.loading = false;
    renderCompanyListPage();
    if (!$("appNav").classList.contains("hidden")) renderAppNav("companies");
  } catch (err) {
    if (seq !== companyListSeq) return;
    page.loading = false;
    page.error = err?.message || String(err);
    renderCompanyListPage();
  }
}

function setCompanyBand(band) {
  if (state.companyListPage.band === band) return;
  state.companyListPage.band = band;
  state.companyListPage.offset = 0;
  void loadCompanyListPage({ force: true });
}

function stepCompanyPage(delta) {
  const page = state.companyListPage;
  const next = Math.max(0, (Number(page.offset) || 0) + delta * COMPANY_PAGE_SIZE);
  if (next === page.offset) return;
  if (next >= page.total) return;
  page.offset = next;
  void loadCompanyListPage({ force: true });
}

function renderCompanyBandTabs() {
  const counts = state.companyListPage.bandCounts;
  const active = state.companyListPage.band;
  return `<div class="scoredTabs companyBandTabs" role="tablist">
    ${COMPANY_BANDS.map((band) => {
      const count = counts ? Number(counts[band.countKey] || 0) : null;
      return `<button type="button" class="scoredTab ${band.key === active ? "active" : ""}" data-company-band="${band.key}">
        ${escapeHtml(band.label)}${count != null ? ` <span class="scoredTabCount">${count}</span>` : ""}
      </button>`;
    }).join("")}
  </div>`;
}

function renderCompanyListPage() {
  const el = $("companyListPage");
  if (!el) return;
  const { companies, total, offset, loading, loaded, error } = state.companyListPage;
  let body;
  if (loading && !loaded) {
    body = `<div class="pageLoading"><span class="kindlingSpinner" aria-hidden="true"></span>Loading companies…</div>`;
  } else if (error) {
    body = `<p class="pageError">Couldn't load companies: ${escapeHtml(error)}</p>
      <button type="button" data-page-action="retry-companies">Retry</button>`;
  } else if (!companies.length) {
    body = `<p class="pageEmpty">No companies in this list.</p>`;
  } else {
    body = `<div class="kindlingPanel companyTablePanel">${renderCompanyListRows(companies)}</div>`;
  }

  // Pager (25 per page).
  let pager = "";
  if (loaded && total > 0) {
    const start = companies.length ? offset + 1 : 0;
    const end = Math.min(total, offset + companies.length);
    pager = `<div class="pager companyListPager">
      <span>${start}-${end} of ${total}</span>
      <div>
        <button type="button" data-company-page="prev" ${offset <= 0 ? "disabled" : ""}>Previous</button>
        <button type="button" data-company-page="next" ${offset + companies.length >= total ? "disabled" : ""}>Next</button>
      </div>
    </div>`;
  }

  const count = loaded ? `${total} ${total === 1 ? "company" : "companies"}` : "";
  el.innerHTML = `<div class="pageInner companyListInner">
    <header class="pageTopHeader"><h1>Company List</h1>${count ? `<span class="pageCount">${escapeHtml(count)}</span>` : ""}</header>
    ${renderCompanyBandTabs()}
    ${pager}
    ${body}
  </div>`;
}

// ---- Results: outreach tracking -------------------------------------------

const RESULTS_TABS = [
  { key: "waiting", label: "Waiting", countKey: "waiting" },
  { key: "no_response", label: "No Response", countKey: "no_response" },
  { key: "meeting", label: "Meetings", countKey: "meeting" },
  { key: "rejected", label: "Rejected", countKey: "rejected" },
  { key: "snoozed", label: "Snoozed", countKey: "snoozed" },
];

const REASON_CATEGORY_LABELS = {
  not_appropriate: "Not appropriate to call",
  already_contacted: "Previously contacted (outside Kindling)",
  poor_record: "Poor record",
  poor_feedback: "Poor feedback after outreach",
  said_no: "They said no",
  no_response: "No response",
  other: "Other",
};

const RESULTS_PAGE_SIZE = 25;

function shortDate(ts) {
  if (!ts) return "";
  const d = new Date(Number(ts));
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - Number(ts)) / (24 * 60 * 60 * 1000));
}

let resultsSeq = 0;
async function loadResultsPage({ force = false } = {}) {
  if (state.resultsPage.loaded && !force) {
    renderResultsPage();
    return;
  }
  const seq = ++resultsSeq;
  const page = state.resultsPage;
  page.loading = true;
  page.error = "";
  renderResultsPage();
  try {
    const query = new URLSearchParams({
      tab: page.tab,
      limit: String(RESULTS_PAGE_SIZE),
      offset: String(Math.max(0, Number(page.offset) || 0)),
    });
    if (page.q) query.set("q", page.q);
    const data = await api(`/api/kindling/outreach/results?${query}`);
    if (seq !== resultsSeq) return;
    page.items = data.items || [];
    page.total = Number(data.total ?? page.items.length ?? 0);
    page.offset = Number(data.offset ?? page.offset ?? 0);
    page.counts = data.counts || page.counts;
    page.loaded = true;
    page.loading = false;
    renderResultsPage();
    if (!$("appNav").classList.contains("hidden")) renderAppNav("results");
  } catch (err) {
    if (seq !== resultsSeq) return;
    page.loading = false;
    page.error = err?.message || String(err);
    renderResultsPage();
  }
}

function setResultsTab(tab) {
  if (state.resultsPage.tab === tab) return;
  state.resultsPage.tab = tab;
  state.resultsPage.offset = 0;
  void loadResultsPage({ force: true });
}

function stepResultsPage(delta) {
  const page = state.resultsPage;
  const next = Math.max(0, (Number(page.offset) || 0) + delta * RESULTS_PAGE_SIZE);
  if (next === page.offset || next >= page.total) return;
  page.offset = next;
  void loadResultsPage({ force: true });
}

function renderResultsTabs() {
  const counts = state.resultsPage.counts;
  const active = state.resultsPage.tab;
  return `<div class="scoredTabs resultsTabs" role="tablist">
    ${RESULTS_TABS.map((tab) => {
      const count = counts ? Number(counts[tab.countKey] || 0) : null;
      return `<button type="button" class="scoredTab ${tab.key === active ? "active" : ""}" data-results-tab="${tab.key}">
        ${escapeHtml(tab.label)}${count != null ? ` <span class="scoredTabCount">${count}</span>` : ""}
      </button>`;
    }).join("")}
  </div>`;
}

function renderResultRow(item, tab) {
  const company = item.company || {};
  const name = company.name || "Unknown company";
  const meta = [company.industry, company.location].filter(Boolean).join(" · ");
  const fit = item.fitBand && item.fitBand !== "unscored"
    ? `<span class="resultFit resultFit-${escapeHtml(item.fitBand)}">${escapeHtml(item.fitBand)} fit</span>` : "";

  let timing = "";
  let actions = "";
  if (tab === "waiting" || tab === "no_response") {
    const d = daysSince(item.outreachAt);
    timing = `<span class="resultTiming">Sent ${escapeHtml(shortDate(item.outreachAt))}${d != null ? ` · ${d}d waiting` : ""}</span>`;
    actions = `
      <button type="button" class="resultBtn resultBtnGood" data-result-meeting="${escapeHtml(item.companyId)}">Got a meeting</button>
      <button type="button" class="resultBtn" data-result-drop="${escapeHtml(item.companyId)}">Dropped…</button>`;
  } else if (tab === "meeting") {
    timing = `<span class="resultTiming">Meeting · responded ${escapeHtml(shortDate(item.responseAt))}</span>`;
  } else if (tab === "rejected") {
    const cat = REASON_CATEGORY_LABELS[item.reasonCategory] || item.reasonCategory || "Dismissed";
    timing = `<span class="resultTiming">${escapeHtml(cat)}${item.dismissedFrom === "call_list" ? " · from call list" : item.dismissedFrom === "waiting" ? " · after outreach" : ""}</span>`;
  } else if (tab === "snoozed") {
    timing = `<span class="resultTiming">Snoozed${item.snoozedUntil ? ` until ${escapeHtml(shortDate(item.snoozedUntil))}` : ""}</span>`;
  }

  const reasonLine = (tab === "rejected" && item.reason)
    ? `<p class="resultReason">${escapeHtml(item.reason)}</p>` : "";

  // Undo always available — pulls the company out of tracking and back onto the
  // call list. Tucked behind a ⋮ menu so it doesn't crowd each row. On the Snoozed
  // tab it reads as "resume now" (ends the snooze).
  const undoLabel = tab === "snoozed" ? "↩ Resume now" : "↩ Undo";
  const menu = `
    <div class="resultMenu">
      <button type="button" class="resultMenuToggle" data-result-menu aria-label="More actions" aria-haspopup="true">⋮</button>
      <div class="resultMenuList" role="menu">
        <button type="button" class="resultMenuItem" role="menuitem" data-result-undo="${escapeHtml(item.companyId)}">${undoLabel}</button>
      </div>
    </div>`;

  return `
    <div class="resultRow">
      <div class="resultRowMain">
        <div class="resultRowHead">
          <strong>${escapeHtml(name)}</strong>
          ${fit}
        </div>
        ${meta ? `<span class="resultMeta">${escapeHtml(meta)}</span>` : ""}
        ${timing}
        ${reasonLine}
      </div>
      <div class="resultRowActions">${actions}${menu}</div>
    </div>`;
}

function renderResultsPage() {
  const el = $("resultsPage");
  if (!el) return;
  const { items, total, offset, tab, q, loading, loaded, error } = state.resultsPage;
  let body;
  if (loading && !loaded) {
    body = `<div class="pageLoading"><span class="kindlingSpinner" aria-hidden="true"></span>Loading results…</div>`;
  } else if (error) {
    body = `<p class="pageError">Couldn't load results: ${escapeHtml(error)}</p>
      <button type="button" data-page-action="retry-results">Retry</button>`;
  } else if (!items.length) {
    const empty = {
      waiting: "Nothing waiting. Send outreach from On Deck to start tracking.",
      no_response: "No silent threads — everyone waiting is still inside the week.",
      meeting: "No meetings booked yet.",
      rejected: "No dismissed or dropped companies.",
      snoozed: "Nothing snoozed. Snooze a company from On Deck to park it for later.",
    }[tab] || "Nothing here yet.";
    body = `<p class="pageEmpty">${escapeHtml(empty)}</p>`;
  } else {
    body = `<div class="kindlingPanel resultsListPanel">${items.map((item) => renderResultRow(item, tab)).join("")}</div>`;
  }

  let pager = "";
  if (loaded && total > RESULTS_PAGE_SIZE) {
    const start = items.length ? offset + 1 : 0;
    const end = Math.min(total, offset + items.length);
    pager = `<div class="pager resultsPager">
      <span>${start}-${end} of ${total}</span>
      <div>
        <button type="button" data-results-page="prev" ${offset <= 0 ? "disabled" : ""}>Previous</button>
        <button type="button" data-results-page="next" ${offset + items.length >= total ? "disabled" : ""}>Next</button>
      </div>
    </div>`;
  }

  el.innerHTML = `<div class="pageInner resultsInner">
    <header class="pageTopHeader"><h1>Results</h1><span class="pageCount">Outreach you've sent</span></header>
    ${renderResultsTabs()}
    <form class="resultsSearch" data-results-search>
      <input type="search" id="resultsSearchInput" placeholder="Search company or reason…" value="${escapeHtml(q || "")}" />
      ${q ? `<button type="button" data-results-clear>Clear</button>` : ""}
    </form>
    ${pager}
    ${body}
  </div>`;
}

// ---- Shared reason / outcome modal ----------------------------------------

// config: { title, message, confirmLabel, requireReason, categories:[{value,label}], onConfirm({reason, category}) }
function openReasonModal(config) {
  state.reasonModal = config;
  const root = $("reasonModalRoot");
  if (!root) return;
  const cats = config.categories || [];
  root.innerHTML = `
    <div class="reasonModalBackdrop">
      <div class="reasonModal" role="dialog" aria-modal="true">
        <h2 class="reasonModalTitle">${escapeHtml(config.title || "Add a reason")}</h2>
        ${config.message ? `<p class="reasonModalMessage">${escapeHtml(config.message)}</p>` : ""}
        ${cats.length ? `
          <label class="reasonModalField">
            <span>Category</span>
            <select id="reasonModalCategory">
              ${cats.map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join("")}
            </select>
          </label>` : ""}
        <label class="reasonModalField">
          <span>Reason${config.requireReason ? "" : " (optional)"}</span>
          <textarea id="reasonModalText" rows="3" placeholder="${escapeHtml(config.placeholder || "What happened / why?")}"></textarea>
        </label>
        <div class="reasonModalActions">
          <button type="button" data-reason-close>Cancel</button>
          <button type="button" class="reasonModalConfirm" data-reason-confirm>${escapeHtml(config.confirmLabel || "Confirm")}</button>
        </div>
      </div>
    </div>`;
  root.classList.remove("hidden");
  const text = $("reasonModalText");
  if (text) text.focus();
}

function closeReasonModal() {
  state.reasonModal = null;
  const root = $("reasonModalRoot");
  if (root) {
    root.classList.add("hidden");
    root.innerHTML = "";
  }
}

async function confirmReasonModal() {
  const config = state.reasonModal;
  if (!config) return;
  const reason = ($("reasonModalText")?.value || "").trim();
  const category = $("reasonModalCategory")?.value || "";
  if (config.requireReason && !reason) {
    const text = $("reasonModalText");
    if (text) text.focus();
    return;
  }
  const confirmBtn = document.querySelector("[data-reason-confirm]");
  setBusyElement(confirmBtn, true, "Saving");
  try {
    await config.onConfirm({ reason, category });
    closeReasonModal();
  } catch (err) {
    setBusyElement(confirmBtn, false);
    const modal = document.querySelector(".reasonModal");
    if (modal && !modal.querySelector(".reasonModalError")) {
      const p = document.createElement("p");
      p.className = "reasonModalError";
      p.textContent = err?.message || String(err);
      modal.insertBefore(p, modal.querySelector(".reasonModalActions"));
    }
  }
}

// ---- Outreach actions (call list + results) -------------------------------

const DISMISS_CATEGORIES = [
  { value: "not_appropriate", label: "Not appropriate to call" },
  { value: "already_contacted", label: "Previously contacted (outside Kindling)" },
  { value: "poor_record", label: "Poor record" },
  { value: "poor_feedback", label: "Poor feedback after outreach" },
  { value: "other", label: "Other" },
];

const DROP_CATEGORIES = [
  { value: "said_no", label: "They said no" },
  { value: "no_response", label: "No response" },
  { value: "poor_feedback", label: "Poor feedback after outreach" },
  { value: "other", label: "Other" },
];

function dismissFromDeck(companyId) {
  openReasonModal({
    title: "Dismiss from call list",
    message: "This company won't be called. Capture why so we can improve targeting.",
    confirmLabel: "Dismiss",
    requireReason: true,
    categories: DISMISS_CATEGORIES,
    placeholder: "e.g. wrong industry, no decision-maker contact, out of area…",
    onConfirm: async ({ reason, category }) => {
      await api("/api/kindling/outreach/dismiss", { method: "POST", body: JSON.stringify({ companyId, reason, reasonCategory: category }) });
      removeFocusItem(companyId);
    },
  });
}

async function snoozeFromDeck(companyId, trigger) {
  if (!companyId) return;
  setBusyElement(trigger, true, "Snoozing");
  try {
    await api("/api/kindling/outreach/snooze", { method: "POST", body: JSON.stringify({ companyId }) });
    removeFocusItem(companyId);
  } catch (err) {
    setBusyElement(trigger, false);
    alert(`Couldn't snooze: ${err?.message || err}`);
  }
}

function dropFromResults(companyId) {
  openReasonModal({
    title: "Drop this company",
    message: "Mark this outreach as closed without a meeting.",
    confirmLabel: "Drop",
    requireReason: true,
    categories: DROP_CATEGORIES,
    placeholder: "What was the outcome?",
    onConfirm: async ({ reason, category }) => {
      await api("/api/kindling/outreach/respond", { method: "POST", body: JSON.stringify({ companyId, outcome: "dropped", reason, reasonCategory: category }) });
      await loadResultsPage({ force: true });
    },
  });
}

function removeFocusItem(companyId) {
  const items = state.focus.items;
  const idx = items.findIndex((it) => (it.companyId || it.company?.id) === companyId);
  if (idx === -1) return;
  items.splice(idx, 1);
  if (state.focus.index >= items.length) state.focus.index = Math.max(0, items.length - 1);
  renderFocus();
  if (!$("appNav").classList.contains("hidden")) renderAppNav("deck");
  // Results badge/list will be stale until next visit; force a reload next open.
  state.resultsPage.loaded = false;
}

// After a "no answer" call, the company stays on the deck but recirculates to the
// back so fresh targets come first; the next card slides into the current slot.
function moveFocusItemToBack(companyId) {
  const items = state.focus.items;
  const idx = items.findIndex((it) => (it.companyId || it.company?.id) === companyId);
  if (idx === -1) return;
  const [item] = items.splice(idx, 1);
  items.push(item);
  if (state.focus.index >= items.length) state.focus.index = Math.max(0, items.length - 1);
  state.focus.contactPage = 0;
  renderFocus();
}

// ---- Reach Out modal (draft emails + contacts; log an email or a call) -----
// Self-contained: its own dynamically-mounted root + module-level state, so it
// never collides with the shared company-details overlay.
let reachState = { open: false, companyId: "", company: null, drafts: [], people: [], loading: false, view: "reach", draftIndex: 0 };

function ensureReachRoot() {
  let root = document.getElementById("reachModalRoot");
  if (root) return root;
  root = document.createElement("div");
  root.id = "reachModalRoot";
  root.className = "reachModalRoot hidden";
  document.body.appendChild(root);
  root.addEventListener("click", onReachClick);
  root.addEventListener("submit", onReachSubmit);
  return root;
}

function openReachOutModal() {
  const item = state.focus.items[state.focus.index];
  if (!item) return;
  const companyId = item.companyId || item.company?.id || "";
  if (!companyId) return;
  reachState = {
    open: true,
    companyId,
    company: item.company || { name: item.name, website: item.website },
    drafts: [],
    people: Array.isArray(item.decisionMakers) ? item.decisionMakers : (item.company?.decisionMakers || []),
    loading: true,
    view: "reach",
    draftIndex: 0,
  };
  renderReachModal();
  void loadReachDetail(companyId);
}

async function loadReachDetail(companyId) {
  try {
    const data = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}/outreach`);
    if (!reachState.open || reachState.companyId !== companyId) return;
    reachState.company = data.company || reachState.company;
    reachState.drafts = data.drafts || [];
    if (Array.isArray(data.people) && data.people.length) reachState.people = data.people;
    reachState.loading = false;
    renderReachModal();
  } catch (err) {
    if (!reachState.open || reachState.companyId !== companyId) return;
    reachState.loading = false;
    renderReachModal();
  }
}

function closeReachModal() {
  reachState.open = false;
  const root = document.getElementById("reachModalRoot");
  if (root) { root.classList.add("hidden"); root.innerHTML = ""; }
}

function renderReachContacts() {
  const people = reachState.people || [];
  if (!people.length) {
    return `<p class="reachEmpty">${reachState.loading ? "Loading contacts…" : "No named contacts captured yet."}</p>`;
  }
  return people.map((p) => {
    const name = p.name || "Unknown";
    const title = p.title || p.role || "";
    const phone = p.phone || p.mobile || "";
    const email = p.email || "";
    const chips = [];
    if (phone) chips.push(`<a class="reachChip" href="tel:${escapeHtml(phone.replace(/\s+/g, ""))}">📞 ${escapeHtml(phone)}</a><button type="button" class="reachChipCopy" data-copy="${escapeHtml(phone)}" title="Copy number">Copy</button>`);
    if (email) chips.push(`<a class="reachChip" href="mailto:${escapeHtml(email)}">✉️ ${escapeHtml(email)}</a><button type="button" class="reachChipCopy" data-copy="${escapeHtml(email)}" title="Copy email">Copy</button>`);
    return `
      <div class="reachContact">
        <div class="reachContactName">${escapeHtml(name)}${title ? ` <span class="reachContactRole">${escapeHtml(title)}</span>` : ""}</div>
        ${chips.length ? `<div class="reachContactChips">${chips.join("")}</div>` : `<div class="reachContactChips reachMuted">No direct contact captured</div>`}
      </div>`;
  }).join("");
}

function renderReachDrafts() {
  const drafts = reachState.drafts || [];
  if (!drafts.length) {
    return `<p class="reachEmpty">${reachState.loading ? "Loading drafts…" : "No draft emails written yet — copy a contact and write your own."}</p>`;
  }
  // Show one email at a time and let the user page through variants, mirroring
  // the draft pager on the company details modal. More width + one-at-a-time
  // means each email gets the vertical room to read without a cramped column.
  const total = drafts.length;
  const idx = Math.min(Math.max(0, reachState.draftIndex || 0), total - 1);
  const d = drafts[idx];
  const text = d.pitchText || d.body || "";
  const label = d.variantLabel ? escapeHtml(d.variantLabel) : "";
  const meta = total > 1
    ? `${idx + 1} of ${total}${label ? ` · ${label}` : ""}`
    : (label || "Draft 1");
  return `
    <section class="reachDraft">
      <div class="reachDraftHead">
        <span class="reachDraftLabel">${meta}</span>
        <div class="reachDraftControls">
          ${total > 1 ? `
            <button type="button" class="reachDraftNav" data-reach-action="draft-prev" ${idx <= 0 ? "disabled" : ""} aria-label="Previous draft">‹</button>
            <button type="button" class="reachDraftNav" data-reach-action="draft-next" ${idx >= total - 1 ? "disabled" : ""} aria-label="Next draft">›</button>
          ` : ""}
          <button type="button" class="reachDraftCopy" data-copy-draft="${idx}">Copy</button>
        </div>
      </div>
      <pre class="reachDraftText">${escapeHtml(text) || "(empty)"}</pre>
    </section>`;
}

function renderReachModal() {
  const root = ensureReachRoot();
  if (!reachState.open) { root.classList.add("hidden"); root.innerHTML = ""; return; }
  root.classList.remove("hidden");
  const company = reachState.company || {};
  const name = company.name || "Company";

  if (reachState.view === "call") {
    root.innerHTML = `
      <div class="reachBackdrop" data-reach-action="close">
        <div class="reachPanel reachPanelCall" role="dialog" aria-modal="true" data-reach-panel>
          <header class="reachHeader">
            <div><div class="reachEyebrow">Log a call</div><h2>${escapeHtml(name)}</h2></div>
            <button type="button" class="reachClose" data-reach-action="close" aria-label="Close">✕</button>
          </header>
          <form class="reachCallForm" data-reach-form="call">
            <label class="reachField">
              <span>How did the call go?</span>
              <textarea id="reachCallNotes" rows="4" placeholder="What was said, next steps, who you spoke to…"></textarea>
            </label>
            <label class="reachField">
              <span>Outcome</span>
              <select id="reachCallOutcome">
                <option value="meeting">Successful — follow-up meeting</option>
                <option value="dropped">Unsuccessful — not interested</option>
                <option value="no_answer">No answer — try again later</option>
              </select>
            </label>
            <label class="reachField" id="reachCallReasonField">
              <span>If unsuccessful, why?</span>
              <select id="reachCallCategory">
                ${DROP_CATEGORIES.map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join("")}
              </select>
            </label>
            <p class="reachError hidden" id="reachCallError"></p>
            <div class="reachActions">
              <button type="button" data-reach-action="back">Back</button>
              <button type="submit" class="reachPrimary">Save call</button>
            </div>
          </form>
        </div>
      </div>`;
    const notes = document.getElementById("reachCallNotes");
    if (notes) notes.focus();
    return;
  }

  root.innerHTML = `
    <div class="reachBackdrop" data-reach-action="close">
      <div class="reachPanel" role="dialog" aria-modal="true" data-reach-panel>
        <header class="reachHeader">
          <div>
            <div class="reachEyebrow">Reach out${company.website ? ` · ${renderWebsiteLink(company.website)}` : ""}</div>
            <h2>${escapeHtml(name)}</h2>
          </div>
          <button type="button" class="reachClose" data-reach-action="close" aria-label="Close">✕</button>
        </header>
        <div class="reachBody">
          <section class="reachCol reachColDrafts">
            <h3 class="reachColTitle">Draft emails</h3>
            <div class="reachDraftList">${renderReachDrafts()}</div>
          </section>
          <section class="reachCol reachColContacts">
            <h3 class="reachColTitle">Contacts</h3>
            <div class="reachContactList">${renderReachContacts()}</div>
          </section>
        </div>
        <footer class="reachFooter">
          <span class="reachFooterNote">Logs the outreach against ${escapeHtml(name)} (timestamped now).</span>
          <div class="reachActions">
            <button type="button" class="reachPrimary" data-reach-action="email">I emailed them</button>
            <button type="button" class="reachPrimary reachCall" data-reach-action="call">I called them</button>
          </div>
        </footer>
      </div>
    </div>`;
}

function onReachClick(event) {
  const copyDraft = event.target.closest("[data-copy-draft]");
  if (copyDraft) { reachCopy((reachState.drafts[Number(copyDraft.dataset.copyDraft)] || {}).pitchText || "", copyDraft); return; }
  const copyEl = event.target.closest("[data-copy]");
  if (copyEl) { reachCopy(copyEl.dataset.copy || "", copyEl); return; }
  const action = event.target.closest("[data-reach-action]")?.dataset.reachAction;
  if (!action) return;
  if (action === "close") {
    if (!event.target.closest("[data-reach-panel]") || event.target.closest("button")) closeReachModal();
    return;
  }
  if (action === "draft-prev") { reachDraftStep(-1); return; }
  if (action === "draft-next") { reachDraftStep(1); return; }
  if (action === "back") { reachState.view = "reach"; renderReachModal(); return; }
  if (action === "email") void reachMarkEmailed(event.target.closest("[data-reach-action]"));
  if (action === "call") { reachState.view = "call"; renderReachModal(); }
}

function reachDraftStep(delta) {
  const drafts = reachState.drafts || [];
  if (drafts.length < 2) return;
  const next = Math.min(Math.max(0, (reachState.draftIndex || 0) + delta), drafts.length - 1);
  if (next === reachState.draftIndex) return;
  reachState.draftIndex = next;
  renderReachModal();
}

function onReachSubmit(event) {
  if (!event.target.closest('[data-reach-form="call"]')) return;
  event.preventDefault();
  void reachSubmitCall();
}

function reachCopy(text, button) {
  if (!text || !navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(text).then(() => {
    if (!button) return;
    const original = button.textContent;
    button.textContent = "Copied ✓";
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1400);
  }).catch(() => {});
}

async function reachMarkEmailed(button) {
  const companyId = reachState.companyId;
  setBusyElement(button, true, "Saving");
  try {
    await api("/api/kindling/outreach/sent", { method: "POST", body: JSON.stringify({ companyId, channel: "email" }) });
    closeReachModal();
    removeFocusItem(companyId);
  } catch (err) {
    setBusyElement(button, false);
    alert(`Couldn't save: ${err?.message || err}`);
  }
}

async function reachSubmitCall() {
  const companyId = reachState.companyId;
  const notes = (document.getElementById("reachCallNotes")?.value || "").trim();
  const outcome = document.getElementById("reachCallOutcome")?.value || "meeting";
  const category = document.getElementById("reachCallCategory")?.value || "other";
  const errEl = document.getElementById("reachCallError");
  if (outcome === "dropped" && !notes) {
    if (errEl) { errEl.textContent = "Add a quick note on what happened."; errEl.classList.remove("hidden"); }
    document.getElementById("reachCallNotes")?.focus();
    return;
  }
  const body = { companyId, outcome, channel: "call", notes };
  if (outcome === "dropped") { body.reason = notes; body.reasonCategory = category; }
  const submitBtn = document.querySelector('[data-reach-form="call"] .reachPrimary');
  setBusyElement(submitBtn, true, "Saving");
  try {
    const data = await api("/api/kindling/outreach/respond", { method: "POST", body: JSON.stringify(body) });
    closeReachModal();
    // "No answer" keeps the company on the deck (server state "on_deck"); recirculate
    // it to the back, unless the 3rd attempt today auto-snoozed it out.
    if (outcome === "no_answer" && data.result?.state === "on_deck" && !data.result?.snoozedUntil) {
      moveFocusItemToBack(companyId);
    } else {
      removeFocusItem(companyId);
    }
  } catch (err) {
    setBusyElement(submitBtn, false);
    if (errEl) { errEl.textContent = err?.message || String(err); errEl.classList.remove("hidden"); }
  }
}

// While the Reach Out modal is open, swallow deck shortcuts (capture phase runs
// before the deck/keydown handlers) and let Escape close it.
document.addEventListener("keydown", (event) => {
  if (!reachState.open) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeReachModal(); return; }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (["ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) event.stopPropagation();
}, true);

// ---- Login signers --------------------------------------------------------
//
// Both login methods and NIP-98 pipeline authorization go through a small signer
// abstraction so adding nsec support doesn't leave pipeline actions broken for
// users without a browser extension.
//
//   { kind, getPublicKey() => 64-hex, signEvent(event) => signedEvent, clear() }

// Wraps a NIP-07 browser extension (window.nostr).
function makeExtensionSigner() {
  return {
    kind: "extension",
    getPublicKey: () => window.nostr.getPublicKey(),
    signEvent: (event) => window.nostr.signEvent(event),
    clear() {},
  };
}

// Wraps a decoded nsec secret key, signing entirely in this tab. The raw secret
// stays closed over here and is never returned, logged, or sent anywhere.
function makeNsecSigner(secretKey) {
  let key = secretKey;
  return {
    kind: "nsec",
    getPublicKey: async () => getPublicKey(key),
    signEvent: async (event) => {
      if (!key) throw new Error("Signer was cleared. Reconnect a Nostr signer.");
      return finalizeEvent(event, key);
    },
    clear() {
      if (key) key.fill?.(0);
      key = null;
    },
  };
}

// HTTPS is required for nsec entry on remote origins; localhost dev is exempt.
function nsecLoginAllowed() {
  if (location.protocol === "https:") return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

// Shared tail for every login method: challenge → sign → verify → boot.
async function completeLoginWithSigner(signer) {
  const pubkey = await signer.getPublicKey();
  const challenge = await api("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ pubkey }),
  });
  const event = await signer.signEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["challenge", challenge.nonce], ["client", "kindling-wapp"]],
    content: challenge.content,
  });
  const result = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ event }),
  });
  state.signer = signer;
  state.token = result.token;
  state.me = result;
  localStorage.setItem("chat_wapp_token", result.token);
  await bootApp();
}

async function loginWithExtension() {
  $("loginError").textContent = "";
  if (!window.nostr) {
    $("loginError").textContent = "No Nostr browser extension was found.";
    return;
  }
  try {
    await completeLoginWithSigner(makeExtensionSigner());
  } catch (error) {
    clearSigner();
    $("loginError").textContent = error.message;
  }
}

async function loginWithNsec() {
  $("loginError").textContent = "";
  const input = $("nsecInput");
  const value = (input?.value || "").trim();
  if (!nsecLoginAllowed()) {
    $("loginError").textContent = "Pasting an NSEC requires a secure (HTTPS) connection.";
    return;
  }
  if (!value.startsWith("nsec1")) {
    if (input) input.value = "";
    $("loginError").textContent = "That doesn't look like an nsec key. It should start with \"nsec1\".";
    return;
  }
  let signer = null;
  try {
    let decoded;
    try {
      decoded = nip19.decode(value);
    } catch {
      throw new Error("Invalid NSEC — the key could not be decoded.");
    }
    if (decoded.type !== "nsec") {
      throw new Error("That's a valid Nostr key but not an nsec private key.");
    }
    signer = makeNsecSigner(decoded.data);
    // Drop the secret from the DOM as soon as it's decoded into memory.
    if (input) input.value = "";
    await completeLoginWithSigner(signer);
  } catch (error) {
    signer?.clear();
    if (state.signer === signer) state.signer = null;
    if (input) input.value = "";
    // error.message here is one of our own sanitized strings or a server error
    // ("...not allowed to log in...", "Challenge expired", network failure) —
    // never the secret key.
    $("loginError").textContent = error.message || "Could not sign in with that NSEC.";
  }
}

// Drop the in-memory signer (logout, token expiry, failed login). The bearer
// token in localStorage is handled separately by logout().
function clearSigner() {
  state.signer?.clear?.();
  state.signer = null;
}

// Choose which login method is visible. The extension path stays the default.
function setLoginMethod(method) {
  const isNsec = method === "nsec";
  $("loginExtension")?.classList.toggle("hidden", isNsec);
  $("loginNsec")?.classList.toggle("hidden", !isNsec);
  $("loginError").textContent = "";
  if (isNsec) {
    const input = $("nsecInput");
    if (input) {
      input.value = "";
      input.disabled = !nsecLoginAllowed();
    }
    const note = $("nsecHttpsNote");
    if (note) note.classList.toggle("hidden", nsecLoginAllowed());
    const submit = $("nsecLoginButton");
    if (submit) submit.disabled = !nsecLoginAllowed();
  }
}

async function bootApp() {
  try {
    state.me = await api("/api/me");
    const npubEl = $("npub");
    if (npubEl) npubEl.textContent = state.me.npub;
    syncAccessUi();
    void ensureUserProfile();
    await renderRoute();
  } catch {
    logout();
  }
}

function logout() {
  clearSigner();
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
  if (!state.me?.access?.edit) {
    state.activeChatId = state.chats[0]?.id || "";
    renderChats();
    if (state.activeChatId) await loadActiveChat();
    else {
      $("chatTitle").textContent = "Chat";
      renderMessages([]);
    }
    syncAccessUi();
    return;
  }
  if (!state.activeChatId || !state.chats.find((chat) => chat.id === state.activeChatId)) {
    if (state.chats[0]) state.activeChatId = state.chats[0].id;
    else await newChat();
  }
  await loadActiveChat();
  syncAccessUi();
}

async function loadChats() {
  const payload = await api("/api/chats");
  state.chats = payload.chats || [];
  renderChats();
}

async function loadSettings() {
  const [payload, roles, scheduler] = await Promise.all([
    api("/api/settings"),
    api("/api/kindling/pipeline-roles"),
    api("/api/kindling/scheduler-settings").catch(() => ({ settings: null })),
  ]);
  state.settings = payload.settings;
  state.accessRules = payload.accessRules || [];
  state.pipelineRoles = roles.pipelineRoles || [];
  state.schedulerSettings = scheduler.settings || null;
  renderSettings();
  renderPipelineOptions();
  renderSettingsRoleMappings();
  renderAccessRules();
  renderAutomationCard();
}

// Single source of truth for scheduling, surfaced on the Settings page.
const AUTOMATION_ACTIONS = [
  { key: "acquisition", label: "Acquisition (find companies)", flag: "acquisitionEnabled", role: "scan_target_list", roles: ["scan_target_list"], cooldown: "acquisitionMs" },
  { key: "enrichment", label: "Enrichment (incl. people & contacts)", flag: "enrichmentEnabled", role: "enrich_company", roles: ["enrich_company", "enrich_industry_segment"], cooldown: "enrichmentMs" },
  { key: "scoring", label: "Scoring (service-fit)", flag: "scoringEnabled", role: "score_company_service_fit", roles: ["score_company_service_fit"], cooldown: "scoringMs" },
  { key: "outreach", label: "Outreach drafting", flag: "outreachEnabled", role: "draft_outreach", roles: ["draft_outreach"], cooldown: "outreachMs" },
];
const AUTOMATION_MODELS = [
  { value: "", label: "Default (Autopilot)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku (cheap/fast)" },
  { value: "claude-sonnet-4-6", label: "Sonnet" },
  { value: "claude-opus-4-8", label: "Opus" },
];

function renderAutomationCard() {
  const body = $("automationBody");
  if (!body) return;
  const s = state.schedulerSettings;
  const canEdit = Boolean(state.me?.access?.edit);
  if (!s) { body.innerHTML = "<p>Scheduler settings unavailable.</p>"; return; }
  const conc = s.perRoleConcurrency || {};
  const models = s.models || {};
  const cooldowns = s.cooldowns || {};
  const modelOpts = (sel) => AUTOMATION_MODELS
    .map((o) => `<option value="${o.value}" ${(sel || "") === o.value ? "selected" : ""}>${o.label}</option>`).join("");
  const rows = AUTOMATION_ACTIONS.map((a) => `
    <div class="automationRow">
      <label class="automationToggle"><input type="checkbox" id="auto_${a.key}" ${s[a.flag] ? "checked" : ""}/> <strong>${a.label}</strong></label>
      <div class="automationFields">
        <label><span>Concurrency</span><input type="number" min="1" max="20" id="auto_conc_${a.key}" value="${Number(conc[a.role] || 1)}"/></label>
        <label><span>Every (min)</span><input type="number" min="0" id="auto_cd_${a.key}" value="${Math.round(Number(cooldowns[a.cooldown] || 0) / 60000)}"/></label>
        <label><span>Model</span><select id="auto_model_${a.key}">${modelOpts(models[a.role])}</select></label>
      </div>
    </div>`).join("");
  body.innerHTML = `
    <label class="automationMaster"><input type="checkbox" id="auto_enabled" ${s.enabled ? "checked" : ""}/> <strong>Automation enabled (master switch)</strong></label>
    ${rows}
    <div class="automationTargets">
      <label><span>Target pool</span><input type="number" min="1" id="auto_pool" value="${Number(s.targetPoolSize || 0)}"/></label>
      <label><span>Enriched floor</span><input type="number" min="1" id="auto_floor" value="${Number(s.enrichedFloor || 0)}"/></label>
      <label><span>Top targets</span><input type="number" min="1" id="auto_toptarget" value="${Number(s.topTargetCount || 0)}"/></label>
      <label><span>Outreach target</span><input type="number" min="1" id="auto_outreachtarget" value="${Number(s.outreachTargetCount || 0)}"/></label>
    </div>`;
  for (const el of body.querySelectorAll("input,select")) el.disabled = !canEdit;
  const btn = $("saveAutomationButton"); if (btn) btn.disabled = !canEdit;
  const st = $("automationStatus"); if (st) st.textContent = s.enabled ? "Running" : "Paused";
}

async function saveAutomation() {
  const s = state.schedulerSettings || {};
  const conc = { ...(s.perRoleConcurrency || {}) };
  const models = { ...(s.models || {}) };
  const cooldowns = { ...(s.cooldowns || {}) };
  for (const a of AUTOMATION_ACTIONS) {
    conc[a.role] = Math.max(1, Number($(`auto_conc_${a.key}`).value || 1));
    cooldowns[a.cooldown] = Math.max(0, Number($(`auto_cd_${a.key}`).value || 0)) * 60000;
    const m = $(`auto_model_${a.key}`).value;
    for (const r of a.roles) models[r] = m;
  }
  try {
    const res = await api("/api/kindling/scheduler-settings", {
      method: "PATCH",
      body: JSON.stringify({
        enabled: $("auto_enabled").checked,
        acquisitionEnabled: $("auto_acquisition").checked,
        enrichmentEnabled: $("auto_enrichment").checked,
        scoringEnabled: $("auto_scoring").checked,
        outreachEnabled: $("auto_outreach").checked,
        targetPoolSize: Number($("auto_pool").value || 0),
        enrichedFloor: Number($("auto_floor").value || 0),
        topTargetCount: Number($("auto_toptarget").value || 0),
        outreachTargetCount: Number($("auto_outreachtarget").value || 0),
        perRoleConcurrency: conc,
        cooldowns,
        models,
      }),
    });
    state.schedulerSettings = res.settings || state.schedulerSettings;
    renderAutomationCard();
    setStatus("Automation saved");
  } catch (error) {
    setStatus(error.message);
  }
}

// Monotonic load token: lets stale (slower) responses be discarded so rapid
// clicks can't have an earlier request overwrite a newer view.
let kindlingLoadSeq = 0;
// When true, the main view content shows a loading placeholder so a tab switch
// gives instant feedback instead of looking dead until the fetch resolves.
let kindlingViewLoading = false;

function kindlingViewLabel(view) {
  const map = {
    service: "Service Offerings",
    companies: "Companies",
    enriched: "Enriched Companies",
    targets: "Scored",
    match: "Match",
    research: "Research Desk",
    admin: "Pipeline admin",
  };
  return map[view] || "view";
}

function companyPageKeyFor(view) {
  return view === "enriched" ? "enriched" : "companies";
}

function buildCompanyQuery(view) {
  const companyQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(state.kindlingFilters)) {
    if (value) companyQuery.set(key, value);
  }
  if (view === "enriched") companyQuery.set("enrichmentStatus", "complete");
  companyQuery.set("limit", "20");
  companyQuery.set("offset", String(Math.max(0, Number(state.kindlingPaging[companyPageKeyFor(view)] || 0))));
  return companyQuery;
}

function buildTargetQuery() {
  const targetQuery = new URLSearchParams({
    limit: "20",
    offset: String(Math.max(0, Number(state.kindlingPaging.targets || 0))),
  });
  if (state.kindlingFilters.hasOutreachDraft === "yes") targetQuery.set("hasOutreachDraft", "true");
  targetQuery.set("band", state.kindlingFilters.band || "high");
  return targetQuery;
}

function applyCompanyList(filtered) {
  const k = state.kindling;
  k.companies = filtered.companies || [];
  k.companyList = {
    total: Number(filtered.total ?? k.counts?.companies ?? 0),
    returned: Number(filtered.returned ?? filtered.companies?.length ?? 0),
    limit: Number(filtered.limit ?? 20),
    offset: Number(filtered.offset ?? Number(state.kindlingPaging[companyPageKeyFor(state.activeKindlingView)] || 0)),
  };
}

function applyTargets(targets) {
  const k = state.kindling;
  k.targets = targets.targets || [];
  k.targetListRunId = targets.targetListRunId || "";
  k.topTargets = targets.targets || [];
  k.topTargetList = {
    total: Number(targets.total ?? targets.run?.rankedCount ?? targets.targets?.length ?? 0),
    returned: Number(targets.returned ?? targets.targets?.length ?? 0),
    limit: Number(targets.limit ?? 20),
    offset: Number(targets.offset ?? Number(state.kindlingPaging.targets || 0)),
  };
  k.topTargetRun = targets.run || null;
  k.topTargetsRebuilt = Boolean(targets.rebuilt);
  k.scoredBandCounts = targets.bandCounts || k.scoredBandCounts || { high: 0, medium: 0, low: 0 };
  k.scoredBand = targets.band || state.kindlingFilters.band || "high";
}

function applyIndustries(enrichmentIndustries) {
  const k = state.kindling;
  k.enrichmentIndustries = enrichmentIndustries.industries || [];
  k.enrichmentIndustryList = {
    total: Number(enrichmentIndustries.total ?? enrichmentIndustries.industries?.length ?? 0),
    returned: Number(enrichmentIndustries.returned ?? enrichmentIndustries.industries?.length ?? 0),
    limit: Number(enrichmentIndustries.limit ?? 20),
    offset: Number(enrichmentIndustries.offset ?? Number(state.kindlingPaging.industries || 0)),
  };
  k.enrichmentBatchLimit = enrichmentIndustries.batchLimit || 21;
  k.enrichmentStrategies = enrichmentIndustries.strategies || [];
}

function applyWorkQueue(workQueue) {
  const k = state.kindling;
  k.workQueueItems = workQueue.items || [];
  k.workQueueList = {
    total: Number(workQueue.total ?? workQueue.items?.length ?? 0),
    returned: Number(workQueue.returned ?? workQueue.items?.length ?? 0),
    limit: Number(workQueue.limit ?? 20),
    offset: Number(workQueue.offset ?? Number(state.kindlingPaging.workQueue || 0)),
  };
}

// Page within a single list without re-fetching the whole screen (and the
// expensive summary endpoint). Only the affected list is requested.
async function loadKindlingList(listKey) {
  if (!state.kindling) return loadKindlingScreen();
  const view = state.activeKindlingView;
  kindlingViewLoading = false;
  const seq = ++kindlingLoadSeq;
  setKindlingStatus("Loading page…");
  try {
    if (listKey === "companies" || listKey === "enriched") {
      const filtered = await api(`/api/kindling/companies?${buildCompanyQuery(view)}`);
      if (seq !== kindlingLoadSeq) return;
      applyCompanyList(filtered);
    } else if (listKey === "targets") {
      const targets = await api(`/api/kindling/top-targets?${buildTargetQuery()}`);
      if (seq !== kindlingLoadSeq) return;
      applyTargets(targets);
    } else if (listKey === "industries") {
      const offset = Math.max(0, Number(state.kindlingPaging.industries || 0));
      const industries = await api(`/api/kindling/enrichment-industries?limit=20&offset=${offset}`);
      if (seq !== kindlingLoadSeq) return;
      applyIndustries(industries);
    } else if (listKey === "workQueue") {
      const offset = Math.max(0, Number(state.kindlingPaging.workQueue || 0));
      const workQueue = await api(`/api/kindling/work-queue?limit=20&offset=${offset}`);
      if (seq !== kindlingLoadSeq) return;
      applyWorkQueue(workQueue);
    } else {
      return loadKindlingScreen();
    }
    renderKindling();
    setKindlingStatus("Page loaded");
  } catch (err) {
    if (seq === kindlingLoadSeq) setKindlingStatus(`Error: ${err?.message || err}`);
  }
}

async function loadKindlingScreen() {
  if (["scheduler", "targets", "today"].includes(state.activeKindlingView)) {
    setKindlingView(state.activeKindlingView === "scheduler" ? "research" : "targets");
  }
  const view = state.activeKindlingView;
  const needsCompanyList = view === "companies" || view === "enriched";
  const needsResearch = view === "research";
  const needsScoring = view === "targets" || view === "match";
  const needsTargets = view === "targets" || view === "match";

  const companyQuery = buildCompanyQuery(view);
  const targetQuery = buildTargetQuery();
  const industryOffset = Math.max(0, Number(state.kindlingPaging.industries || 0));
  const workQueueOffset = Math.max(0, Number(state.kindlingPaging.workQueue || 0));

  const seq = ++kindlingLoadSeq;
  setKindlingStatus("Loading…");
  // Paint the destination view (rail + active tab + loading placeholder) right
  // away so the click registers visually instead of looking unresponsive.
  kindlingViewLoading = true;
  renderKindling();

  // Single round of independent requests — no second serial Promise.all round.
  const [summary, targets, enrichmentIndustries, filtered, scheduler, schedulerPreview, workQueue, scoringOfferings, rankingRuns] = await Promise.all([
    api("/api/kindling/summary?compact=1"),
    needsTargets ? api(`/api/kindling/top-targets?${targetQuery}`) : Promise.resolve({ targets: [], total: 0, returned: 0, limit: 20, offset: Number(targetQuery.get("offset") || 0) }),
    needsResearch ? api(`/api/kindling/enrichment-industries?limit=20&offset=${industryOffset}`) : Promise.resolve({ industries: [], batchLimit: 21, strategies: [], total: 0, returned: 0, limit: 20, offset: 0 }),
    needsCompanyList ? api(`/api/kindling/companies?${companyQuery}`) : Promise.resolve({ companies: [], total: 0, returned: 0, limit: 500 }),
    needsResearch ? api("/api/kindling/scheduler-settings") : Promise.resolve({ settings: null, recentRuns: [], activeLock: null }),
    needsResearch ? api("/api/kindling/scheduler/preview") : Promise.resolve({ decision: null }),
    needsResearch ? api(`/api/kindling/work-queue?limit=20&offset=${workQueueOffset}`) : Promise.resolve({ items: [], total: 0, returned: 0, limit: 20, offset: 0 }),
    needsScoring ? api("/api/kindling/scoring/offerings") : Promise.resolve({ profile: null, offerings: [], marketProfileVersionId: "" }),
    needsResearch || needsScoring ? api("/api/kindling/initial-ranking/runs?limit=10") : Promise.resolve({ runs: [] }),
  ]);

  // A newer load was started while these requests were in flight — discard.
  if (seq !== kindlingLoadSeq) return;

  state.kindling = {
    ...summary,
    scheduler: scheduler.settings || null,
    schedulerRecentRuns: scheduler.recentRuns || [],
    schedulerActiveLock: scheduler.activeLock || null,
    schedulerPreview: schedulerPreview.decision || null,
    scoringProfile: scoringOfferings.profile || null,
    scoringOfferings: scoringOfferings.offerings || [],
    marketProfileVersionId: scoringOfferings.marketProfileVersionId || "",
    rankingRuns: rankingRuns.runs || [],
  };
  applyCompanyList(filtered);
  applyTargets(targets);
  applyIndustries(enrichmentIndustries);
  applyWorkQueue(workQueue);

  if (needsCompanyList && state.selectedCompanyId && !state.kindling.companies?.some((company) => company.id === state.selectedCompanyId)) {
    if (state.activeKindlingView !== "match") state.selectedCompanyId = "";
  }
  if (state.activeKindlingView === "match") {
    const target = selectedTarget(state.kindling);
    const companyId = state.selectedCompanyId || target?.companyId || target?.company?.id || "";
    if (companyId && state.companyDetail?.company?.id !== companyId) {
      state.selectedCompanyId = companyId;
      localStorage.setItem("kindling_company", companyId);
      state.companyDetail = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}`);
    }
  }
  kindlingViewLoading = false;
  renderKindling();
  if (state.kindlingStatus === "Loading…") setKindlingStatus("Ready");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Minimal, escape-first markdown renderer for first-party outreach drafts.
// Supports the subset the pipeline emits: headings, paragraphs, bold/italic,
// links, ordered/unordered lists, and horizontal rules. Escaping happens before
// any markdown tokens are interpreted, so the output is safe to inject.
function renderInlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // { type: "ul" | "ol", items: [] }
  let code = null; // { lines: [] } while inside a ``` fenced block
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(renderInlineMarkdown).join("<br>")}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${renderInlineMarkdown(i)}</li>`).join("")}</${list.type}>`); list = null; }
  };
  for (const line of lines) {
    const fence = line.trim().match(/^```/);
    if (code) {
      if (fence) { out.push(`<pre><code>${code.lines.join("\n")}</code></pre>`); code = null; }
      else code.lines.push(line);
      continue;
    }
    if (fence) { flushPara(); flushList(); code = { lines: [] }; continue; }
    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }
    if (/^([-*_])(?:\s*\1){2,}$/.test(t)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    const heading = t.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flushPara(); flushList(); const lvl = heading[1].length; out.push(`<h${lvl}>${renderInlineMarkdown(heading[2])}</h${lvl}>`); continue; }
    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ul) { flushPara(); if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; } list.items.push(ul[1]); continue; }
    if (ol) { flushPara(); if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; } list.items.push(ol[1]); continue; }
    flushList();
    para.push(t);
  }
  if (code) out.push(`<pre><code>${code.lines.join("\n")}</code></pre>`);
  flushPara(); flushList();
  return out.join("");
}

function selectedCompany() {
  return state.companyDetail?.company || state.kindling?.companies?.find((company) => company.id === state.selectedCompanyId) || null;
}

function servicePromptValue() {
  const profile = state.kindling?.profile?.version;
  if (!profile) return "We help local service businesses find better-fit prospects, enrich sparse company records, and draft relevant first-touch outreach.";
  return "";
}

function setKindlingStatus(text) {
  state.kindlingStatus = text;
  const node = $("kindlingStatus");
  if (node) node.textContent = text;
}

function setBusyElement(element, busy, label = "Working") {
  if (!element) return;
  if (busy) {
    if (!element.dataset.originalText) element.dataset.originalText = element.textContent || "";
    element.dataset.busy = "true";
    element.setAttribute("aria-busy", "true");
    element.disabled = true;
    element.textContent = label;
    return;
  }
  element.removeAttribute("aria-busy");
  element.disabled = false;
  if (element.dataset.originalText) {
    element.textContent = element.dataset.originalText;
    delete element.dataset.originalText;
  }
  delete element.dataset.busy;
}

function companyListShownLabel(data) {
  const returned = Number(data.companyList?.returned ?? data.companies?.length ?? 0);
  const total = Number(data.companyList?.total ?? data.counts?.companies ?? returned);
  return total > returned ? `${returned} of ${total} shown` : `${returned} shown`;
}

function pageRangeLabel(page = {}) {
  const total = Number(page.total || 0);
  const returned = Number(page.returned || 0);
  const offset = Number(page.offset || 0);
  if (!total) return "0 shown";
  const start = returned ? offset + 1 : 0;
  const end = Math.min(total, offset + returned);
  return `${start}-${end} of ${total}`;
}

function renderPager(page = {}, key) {
  const total = Number(page.total || 0);
  const limit = Math.max(1, Number(page.limit || 20));
  const offset = Math.max(0, Number(page.offset || 0));
  const returned = Number(page.returned || 0);
  if (total <= limit && offset === 0) return "";
  return `
    <div class="pager">
      <span>${escapeHtml(pageRangeLabel(page))}</span>
      <div>
        <button type="button" data-page-list="${escapeHtml(key)}" data-page-offset="${Math.max(0, offset - limit)}" ${offset <= 0 ? "disabled" : ""}>Previous</button>
        <button type="button" data-page-list="${escapeHtml(key)}" data-page-offset="${offset + limit}" ${offset + returned >= total ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;
}

function renderKindling() {
  const data = state.kindling || {};
  const company = selectedCompany();
  const canEdit = Boolean(state.me?.access?.edit);
  if (state.activeKindlingView === "act") {
    setKindlingView("service");
  }
  const views = [
    ["service", "Service Offerings", data.profile?.version ? `v${escapeHtml(data.profile.version.versionNumber || "active")}` : "Draft"],
    ["companies", "Companies", companyListShownLabel(data)],
    ["enriched", "Enriched Companies", `${Number(data.counts?.enriched || data.counts?.outreachReady || 0)} enriched`],
    ["targets", "Scored", `${Number(data.counts?.scored || 0)} companies`],
    ["match", "Match", state.selectedTargetId ? "Selected" : "Review"],
  ];
  if (state.activeKindlingView === "research") views.push(["research", "Research Desk", data.scheduler?.enabled ? "Enabled" : "Paused"]);
  if (canEdit && state.activeKindlingView === "admin") views.push(["admin", "Pipeline admin", "Operator"]);
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
            <div><span>Enriched</span><strong>${Number(data.counts?.enriched || data.counts?.outreachReady || 0)}</strong></div>
            <div><span>Scored</span><strong>${Number(data.counts?.scored || 0)}</strong></div>
            <div><span>Active runs</span><strong>${Number(data.counts?.activeRuns || 0)}</strong></div>
            <div><span>Queue</span><strong>${Number(data.counts?.workQueue?.queued || 0)} / ${Number(data.counts?.workQueue?.running || 0)} / ${Number(data.counts?.workQueue?.failed || 0)}</strong></div>
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
  if (kindlingViewLoading) {
    return `
      <section class="kindlingPanel kindlingLoadingPanel">
        <div class="kindlingLoading"><span class="kindlingSpinner" aria-hidden="true"></span>Loading ${escapeHtml(kindlingViewLabel(state.activeKindlingView))}…</div>
      </section>
    `;
  }
  if (state.activeKindlingView === "research") return renderResearchDeskView(data, canEdit);

  if (state.activeKindlingView === "service") return `
    <section class="serviceWorkspace">
      <div class="kindlingPanel serviceProfilePanel">
        ${renderServiceProfile(data.profile?.version)}
      </div>
      <form class="kindlingPanel kindlingActionForm profileChatPanel" data-form="service">
        <div class="panelHeader">
          <div>
            <h2>Profile chat</h2>
            <span>${data.profile?.version ? `Editing v${escapeHtml(data.profile.version.versionNumber)}` : "Create first profile"}</span>
          </div>
        </div>
        ${renderProfileChatContext(data.profile?.version)}
        <label>
          <span>Message</span>
          <textarea id="servicePrompt" rows="10" placeholder="Tell Kindling what to change, add, question, or tighten.">${escapeHtml(servicePromptValue())}</textarea>
        </label>
        <div class="formActions">
          <button type="submit" ${canEdit ? "" : "disabled"}>Update profile</button>
        </div>
      </form>
    </section>
  `;

  if (state.activeKindlingView === "companies" || state.activeKindlingView === "enriched") return `
    <section class="kindlingGrid companiesLayout">
      <div class="kindlingPanel companyTablePanel">
        <div class="panelHeader">
          <div>
            <h2>${state.activeKindlingView === "enriched" ? "Enriched Companies" : "Companies"}</h2>
            <span>${companyListShownLabel(data)}</span>
          </div>
          ${state.activeKindlingView === "companies" ? `<button type="button" data-action="open-company-create" ${canEdit ? "" : "disabled"}>New company</button>` : ""}
        </div>
        ${state.activeKindlingView === "companies" ? renderCompanyStageFilters() : ""}
        ${renderCompanyFilters(state.activeKindlingView === "enriched")}
        ${renderCompanyTable(data.companies || [])}
        ${renderPager(data.companyList, state.activeKindlingView === "enriched" ? "enriched" : "companies")}
      </div>
    </section>
  `;

  if (state.activeKindlingView === "targets") return `
    <section class="kindlingGrid targetReviewLayout">
      <div class="kindlingPanel">
        <div class="panelHeader">
          <div>
            <h2>Scored</h2>
            <span>${Number(data.counts?.serviceFitAssessments || 0)} service-fit assessments${data.topTargetRun ? `; top ${Number(data.topTargets?.length || 0)} from ${escapeHtml(data.topTargetRun.id.slice(0, 8))}` : ""}</span>
          </div>
          <button type="button" data-action="rebuild-top-targets" ${canEdit ? "" : "disabled"}>Rebuild</button>
        </div>
        ${renderScoredFilters()}
        ${renderTopTargets(data.topTargets || data.targets || [])}
        ${renderPager(data.topTargetList, "targets")}
      </div>
    </section>
  `;

  if (state.activeKindlingView === "match") return renderMatchView(data, canEdit);

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

function renderResearchDeskView(data, canEdit) {
  const settings = data.scheduler || {};
  const masterOff = !settings.enabled;
  const preview = data.schedulerPreview || {};
  return `
    <section class="researchDesk">
      <div class="researchHero kindlingPanel">
        <div class="panelHeader">
          <div>
            <h2>Research Desk</h2>
            <span>${settings.enabled ? "Automated prospecting is on" : "Automated prospecting is paused"}</span>
          </div>
          <div class="formActions inlineActions">
            <button type="button" data-action="scheduler-dry-run" ${canEdit ? "" : "disabled"}>Preview and log</button>
            <button type="button" data-action="scheduler-run-once" ${canEdit ? "" : "disabled"}>Run next now</button>
          </div>
        </div>
        <div class="researchSummaryGrid">
          ${renderResearchMetric("Scheduler", settings.enabled ? "On" : "Paused", masterOff ? "No automated loop will start" : "Runs every 21 minutes")}
          ${renderResearchMetric("Next action", schedulerActionLabel(preview.action), preview.reason || "No preview loaded")}
          ${renderResearchMetric("Target pool", Number(settings.targetPoolSize || 0).toLocaleString(), `${Number(data.counts?.companies || 0).toLocaleString()} companies in database`)}
          ${renderResearchMetric("Scored", Number(data.counts?.scored || 0).toLocaleString(), `${Number(data.counts?.serviceFitAssessments || 0).toLocaleString()} service-fit assessments`)}
        </div>
        ${renderSchedulerLock(data.schedulerActiveLock)}
      </div>

      <div class="researchOpsGrid">
        <div class="kindlingPanel nextRunPanel">
          <div class="panelHeader">
            <div>
              <h2>Next Run</h2>
              <span>${preview.workAvailable ? "Ready" : "No work selected"}</span>
            </div>
          </div>
          ${renderSchedulerPreview(preview)}
        </div>
        <div class="kindlingPanel">
          <div class="panelHeader">
            <div>
              <h2>Run History</h2>
              <span>${data.schedulerActiveLock ? "Lock active" : "No active lock"}</span>
            </div>
          </div>
          ${renderSchedulerRuns(data.schedulerRecentRuns || [])}
        </div>
      </div>

      <div class="researchOpsGrid">
        <div class="kindlingPanel">
          <div class="panelHeader">
            <div>
              <h2>Coverage To Walk</h2>
              <span>${Number(data.coverage?.slices?.length || 0)} slices</span>
            </div>
          </div>
          ${renderCoverageSlices(data.coverage?.slices || [])}
        </div>
        <div class="kindlingPanel">
          <div class="panelHeader">
            <div>
              <h2>Work Queue</h2>
              <span>${Number(data.counts?.workQueue?.queued || 0)} queued · ${Number(data.counts?.workQueue?.running || 0)} running · ${Number(data.counts?.workQueue?.failed || 0)} failed</span>
            </div>
            <button type="button" data-action="clear-failed-work-queue" ${canEdit && Number(data.counts?.workQueue?.failed || 0) ? "" : "disabled"}>Clear failed</button>
          </div>
          ${renderWorkQueue(data.workQueueItems || [], canEdit)}
          ${renderPager(data.workQueueList, "workQueue")}
        </div>
      </div>

      <details class="researchAdvanced kindlingPanel">
        <summary>Scheduler Settings</summary>
        <form class="schedulerSettingsForm" data-form="scheduler-settings">
        <p class="schedulerHelp">${masterOff
          ? "Automated runs are paused. These controls define what will be eligible after the scheduler is turned on."
          : "Automated runs are enabled. Acquisition walks coverage areas while scoring can drain enriched companies up to the scoring concurrency limit."}</p>
        <div class="toggleGrid">
          ${renderSchedulerToggle("enabled", "Run scheduler", settings.enabled, "Master on/off switch")}
          ${renderSchedulerToggle("acquisitionEnabled", "Allow acquisition", settings.acquisitionEnabled, "Eligible when scheduler is on")}
          ${renderSchedulerToggle("enrichmentEnabled", "Allow enrichment", settings.enrichmentEnabled, "Eligible when scheduler is on")}
          ${renderSchedulerToggle("scoringEnabled", "Allow scoring", settings.scoringEnabled, "Eligible when scheduler is on")}
          ${renderSchedulerToggle("outreachEnabled", "Allow outreach", settings.outreachEnabled, "Eligible when scheduler is on")}
        </div>
        <div class="settingsNumberGrid">
          <label><span>Target pool size</span><input id="schedulerTargetPoolSize" type="number" min="1" step="1" value="${Number(settings.targetPoolSize || 0)}" /></label>
          <label><span>Enriched floor</span><input id="schedulerEnrichedFloor" type="number" min="1" step="1" value="${Number(settings.enrichedFloor || 0)}" /></label>
          <label><span>Top target count</span><input id="schedulerTopTargetCount" type="number" min="1" step="1" value="${Number(settings.topTargetCount || 0)}" /></label>
          <label><span>Outreach target</span><input id="schedulerOutreachTargetCount" type="number" min="1" step="1" value="${Number(settings.outreachTargetCount || settings.topTargetCount || 0)}" /></label>
        </div>
        <label><span>Per-role concurrency JSON</span><textarea id="schedulerConcurrency" rows="5">${escapeHtml(JSON.stringify(settings.perRoleConcurrency || {}, null, 2))}</textarea></label>
        <label><span>Cooldowns JSON</span><textarea id="schedulerCooldowns" rows="5">${escapeHtml(JSON.stringify(settings.cooldowns || {}, null, 2))}</textarea></label>
        <div class="formActions">
          <button type="submit" ${canEdit ? "" : "disabled"}>Save settings</button>
        </div>
        </form>
      </details>

      <section class="kindlingGrid two schedulerLayout">
        <div class="kindlingPanel">
        <div class="panelHeader">
          <div>
            <h2>Ranking rebuilds</h2>
            <span>Manual validation</span>
          </div>
        </div>
        <div class="buttonGrid">
          <button type="button" data-action="run-initial-ranking" ${canEdit ? "" : "disabled"}>Run initial ranking</button>
          <button type="button" data-action="rebuild-top-targets" ${canEdit ? "" : "disabled"}>Rebuild top targets</button>
        </div>
        ${renderRankingRuns(data.rankingRuns || [])}
      </div>
      <form class="kindlingPanel kindlingActionForm" data-form="scan">
        <h2>Target acquisition</h2>
        <label><span>Industry</span><input id="scanIndustry" value="B2B services" /></label>
        <label><span>Location</span><input id="scanLocation" value="Perth" /></label>
        <label><span>Target count</span><input id="scanTargetCount" type="number" inputmode="numeric" min="1" max="2000" step="1" value="100" /></label>
        <div class="formActions">
          <button type="submit" ${canEdit ? "" : "disabled"}>Run acquisition</button>
        </div>
      </form>
      <div class="kindlingPanel">
        <div class="panelHeader">
          <h2>Enrich by industry</h2>
          <span>${Number(data.enrichmentIndustries?.length || 0)} segments</span>
        </div>
        ${renderEnrichmentIndustries(data.enrichmentIndustries || [], canEdit)}
        ${renderPager(data.enrichmentIndustryList, "industries")}
      </div>
      <div class="kindlingPanel">
        <h2>Recent scan jobs</h2>
        ${renderScanJobs(data.discoveryJobs || [])}
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
      </div>
      </section>
    </section>
  `;
}

function schedulerActionLabel(action) {
  const labels = {
    acquisition: "Find companies",
    enrichment: "Enrich company",
    scoring: "Score targets",
    outreach: "Draft outreach",
    no_work: "No work",
  };
  return labels[action] || "No work";
}

function renderResearchMetric(label, value, helper) {
  return `
    <div class="researchMetric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(helper || "")}</small>
    </div>
  `;
}

function renderSchedulerPreview(decision) {
  if (!decision) return "<p>Scheduler preview is unavailable.</p>";
  const item = decision.item || {};
  const company = item.company || {};
  const queueItem = item.queueItem || {};
  const lines = [];
  if (decision.action === "acquisition") {
    lines.push(["Target area", `${item.segmentLabel || "Unlabelled segment"} in ${item.geographyText || "unspecified geography"}`]);
    lines.push(["Coverage target", `${Number(item.deficit?.sourceBackedUnique || 0)} more source-backed unique companies`]);
    lines.push(["Source", `${item.sourceFamily || "web"} / ${item.strategyType || "search"}`]);
    lines.push(["Slice", item.coverageSliceId || "segment default"]);
  } else if (decision.action === "scoring") {
    lines.push(["Company", company.name || company.id || "Unknown company"]);
    lines.push(["Reason", decision.reason || "Needs scoring"]);
  } else if (decision.action === "enrichment") {
    lines.push(["Company", company.name || company.id || queueItem.targetId || "Unknown company"]);
    lines.push(["Queue", queueItem.id || item.kind || "new enrichment"]);
  } else if (decision.action === "outreach") {
    lines.push(["Company", company.name || company.id || "Unknown company"]);
    lines.push(["Ranking", item.ranking?.rank ? `#${item.ranking.rank}` : "Top target"]);
  }
  return `
    <div class="nextRunStatus ${decision.workAvailable ? "ready" : "idle"}">
      <strong>${escapeHtml(schedulerActionLabel(decision.action))}</strong>
      <span>${escapeHtml(decision.reason || "No scheduler work is currently available.")}</span>
    </div>
    ${lines.length ? `<dl class="compactFacts">${lines.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : ""}
    ${Array.isArray(decision.evaluatedRoles) && decision.evaluatedRoles.length ? `
      <div class="roleDecisionList">
        ${decision.evaluatedRoles.map((role) => `
          <div>
            <strong>${escapeHtml(schedulerActionLabel(role.action))}</strong>
            <span>${escapeHtml(role.status)} - ${escapeHtml(role.reason || "")}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function renderSchedulerToggle(key, label, checked, helper = "") {
  return `
    <label class="toggleControl">
      <input type="checkbox" id="scheduler_${escapeHtml(key)}" ${checked ? "checked" : ""} />
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(helper)}</small></span>
    </label>
  `;
}

function renderSchedulerLock(lock) {
  if (!lock) return "";
  return `<p class="scanWarning">Scheduler lock held by ${escapeHtml(lock.ownerId || "unknown")} until ${formatDate(lock.leaseExpiresAt)}.</p>`;
}

function renderSchedulerRuns(runs) {
  const visibleRuns = runs.filter((run) => !String(run.skipReason || "").includes("only acquisition execution is implemented"));
  if (!visibleRuns.length) return "<p>No executable scheduler runs yet. Use Run next now when Next Run is ready.</p>";
  return `<div class="compactList schedulerRunList">
    ${visibleRuns.slice(0, 10).map((run) => `
      <div>
        <strong>${escapeHtml(schedulerActionLabel(run.selectedAction || run.roleKey))} - ${escapeHtml(run.status)}</strong>
        <span>${escapeHtml(schedulerRunSubject(run))}</span>
        <small>${escapeHtml(run.runType)} - ${formatDate(run.updatedAt)}${run.error ? ` - ${escapeHtml(run.error)}` : ""}</small>
      </div>
    `).join("")}
  </div>`;
}

function schedulerRunSubject(run) {
  const context = run.context || {};
  const result = run.result || {};
  const acquisition = context.selectedAcquisitionWork || result.decision?.item || {};
  const scoring = context.selectedScoringWork || result.decision?.item || {};
  if (run.skipReason) return run.skipReason;
  if (run.selectedAction === "acquisition") {
    return `${acquisition.segmentLabel || "Target area"} in ${acquisition.geographyText || "unspecified geography"}`;
  }
  if (run.selectedAction === "scoring") {
    return scoring.company?.name || scoring.company?.id || result.scoringRun?.requestId || "Service-fit scoring";
  }
  if (run.selectedAction === "enrichment") {
    return scoring.company?.name || scoring.queueItem?.targetId || "Company enrichment";
  }
  if (run.selectedAction === "outreach") {
    return scoring.company?.name || scoring.company?.id || "Outreach drafting";
  }
  return run.roleKey || "No action";
}

function renderCoverageSlices(slices) {
  if (!slices.length) return "<p>No coverage slices yet. Acquisition will create slices from active target segments as it walks the list.</p>";
  return `<div class="compactList coverageSliceList">
    ${slices.slice(0, 12).map((slice) => {
      const current = slice.currentCounts || {};
      const target = slice.targetCounts || {};
      const foundTarget = Number(target.found || 0);
      const sourceBacked = Number(current.sourceBackedUnique || 0);
      const remaining = Math.max(0, foundTarget - sourceBacked);
      return `
        <div>
          <strong>${escapeHtml(slice.segmentLabel || "Unlabelled segment")}</strong>
          <span>${escapeHtml(slice.geographyText || slice.geographyLabel || "No geography")} - ${escapeHtml(slice.sourceFamily || "web")} / ${escapeHtml(slice.strategyType || "search")}</span>
          <small>${sourceBacked}/${foundTarget || "?"} source-backed unique${remaining ? ` - needs ${remaining}` : ""}${slice.nextRunAfterAt ? ` - next after ${formatDate(slice.nextRunAfterAt)}` : ""}</small>
        </div>
      `;
    }).join("")}
  </div>`;
}

function renderWorkQueue(items, canEdit) {
  if (!items.length) return "<p>No queued work yet.</p>";
  return `<div class="compactList workQueueList">
    ${items.map((item) => `
      <div>
        <strong>${escapeHtml(item.kind)} - ${escapeHtml(item.status)}</strong>
        <span>${escapeHtml(item.target?.name || item.segment || item.targetId)}${item.reason ? ` - ${escapeHtml(item.reason)}` : ""}</span>
        <small>Priority ${Number(item.priority || 0)} - attempts ${Number(item.attempts || 0)}${item.error ? ` - ${escapeHtml(item.error)}` : ""}</small>
        ${["failed", "cancelled"].includes(item.status) ? `<button type="button" data-retry-work-queue="${escapeHtml(item.id)}" ${canEdit ? "" : "disabled"}>Retry</button>` : ""}
      </div>
    `).join("")}
  </div>`;
}

function renderTopTargets(targets) {
  if (!targets.length) return "<p>No ranked targets yet. Run scoring and rebuild the top-target list.</p>";
  // The "#" is the company's position in this call list (1-based within the
  // current band + page), not its global composite rank — so removing one
  // reindexes the rest. Offset keeps numbering continuous across pages.
  const base = Math.max(0, Number(state.kindling?.topTargetList?.offset || 0));
  return `<div class="targetList topTargetList">
    ${targets.map((target, index) => {
      const company = target.company || target;
      const name = company.name || target.name || "Unknown company";
      const offering = target.bestOffering?.name || target.bestOfferingName || "No offering selected";
      const caveats = Array.isArray(target.caveats) ? target.caveats : [];
      const score = Number(target.assessmentScore || target.score || 0);
      const confidence = Number(target.confidence || 0);
      return `
        <button type="button" data-open-match="${escapeHtml(target.id || "")}" data-select-company="${escapeHtml(target.companyId || company.id || "")}">
          <span class="targetRank">#${base + index + 1} - ${Math.round(score)}</span>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(offering)} - confidence ${Math.round(confidence * 100)}%</span>
          ${target.hasOutreachDraft ? `<small>${Number(target.outreachDraftCount || 1)} outreach draft${Number(target.outreachDraftCount || 1) === 1 ? "" : "s"} ready</small>` : ""}
          <small>${escapeHtml(target.reason || target.whyNow || "No reasoning captured yet.")}</small>
          ${target.nextAction ? `<small>Next: ${escapeHtml(target.nextAction)}</small>` : ""}
          ${caveats.length ? `<small>Caveats: ${escapeHtml(caveats.slice(0, 2).join("; "))}</small>` : ""}
        </button>
      `;
    }).join("")}
  </div>`;
}

function renderScoredFilters() {
  const band = state.kindlingFilters.band || "high";
  const counts = (state.kindling && state.kindling.scoredBandCounts) || { high: 0, medium: 0, low: 0 };
  const draftOnly = state.kindlingFilters.hasOutreachDraft === "yes";
  const tab = (key, label) => `
    <button type="button" class="scoredTab ${band === key ? "active" : ""}" data-scored-band="${key}">
      ${label} <span class="scoredTabCount">${Number(counts[key] || 0)}</span>
    </button>`;
  const blurb = band === "high"
    ? "Your call list — work these top-down."
    : band === "medium"
      ? "We can see an angle — reach out by email first and see if they respond."
      : "Parked for now — low fit.";
  return `
    <div class="scoredTabs" role="tablist">
      ${tab("high", "High fit")}
      ${tab("medium", "Medium fit")}
      ${tab("low", "Low fit")}
    </div>
    <p class="scoredBandBlurb">${escapeHtml(blurb)}</p>
    <form class="companyFilters scoredFilters" data-form="scored-filters">
      <label class="scoredDraftToggle"><input type="checkbox" id="filterHasOutreachDraft" ${draftOnly ? "checked" : ""}/> Drafted outreach only</label>
      <div class="filterActions">
        <button type="submit">Apply</button>
      </div>
    </form>
  `;
}

function selectedTarget(data = state.kindling || {}) {
  const targets = data.topTargets || data.targets || [];
  return targets.find((target) => target.id === state.selectedTargetId)
    || targets.find((target) => target.companyId === state.selectedCompanyId)
    || targets[0]
    || null;
}

function renderMatchView(data, canEdit) {
  const target = selectedTarget(data);
  const detail = state.companyDetail;
  const company = detail?.company || target?.company || selectedCompany() || target;
  if (!target || !company) return `
    <section class="kindlingPanel">
      <h2>Match</h2>
      <p>Select a company from Targets to review the service-offering match.</p>
    </section>
  `;
  const assessments = detail?.serviceFitAssessments || [];
  const assessment = assessments.find((item) => item.id === target.serviceFitAssessmentId)
    || assessments.find((item) => item.serviceOfferingId === target.bestOffering?.id)
    || assessments[0]
    || null;
  const drafts = detail?.drafts || detail?.outreachDrafts || [];
  return `
    <section class="kindlingGrid two matchLayout">
      <div class="kindlingPanel">
        <div class="panelHeader">
          <div>
            <h2>${escapeHtml(company.name)}</h2>
            <span>${escapeHtml(company.industry || "Unknown")} - ${escapeHtml(company.location || "Unknown")}</span>
          </div>
        </div>
        <dl class="kindlingFacts">
          <div><dt>Website</dt><dd>${company.website ? `<a href="${escapeHtml(company.website)}" target="_blank" rel="noreferrer">${escapeHtml(company.website)}</a>` : "No website"}</dd></div>
          <div><dt>Stage</dt><dd>${escapeHtml(stageLabel(company.enrichmentStatus))}</dd></div>
          <div><dt>Data ring</dt><dd>${escapeHtml(company.dataRing || "")}</dd></div>
          <div><dt>Confidence</dt><dd>${Number(company.confidence || 0).toFixed(2)}</dd></div>
        </dl>
        <section class="scanDetailSection">
          <h3>Company details</h3>
          ${renderProfileSummary(company.profile || {})}
          <div class="formActions">
            <button type="button" data-select-company="${escapeHtml(company.id)}">Show full profile</button>
          </div>
        </section>
      </div>
      <div class="kindlingPanel">
        <div class="panelHeader">
          <div>
            <h2>Service match</h2>
            <span>${escapeHtml(target.bestOffering?.name || "No offering")}</span>
          </div>
        </div>
        <dl class="kindlingFacts">
          <div><dt>Rank</dt><dd>#${Number(target.rank || 0)}</dd></div>
          <div><dt>Score</dt><dd>${Number(target.score || assessment?.score || 0).toFixed(1)}</dd></div>
          <div><dt>Band</dt><dd>${escapeHtml(assessment?.band || "")}</dd></div>
          <div><dt>Confidence</dt><dd>${Math.round(Number(target.confidence || assessment?.confidence || 0) * 100)}%</dd></div>
        </dl>
        <section class="scanDetailSection">
          <h3>Why this match</h3>
          <p>${escapeHtml(assessment?.fitExplanation || target.reason || target.whyNow || "No match reasoning captured yet.")}</p>
          ${renderAssessmentDrivers(assessment)}
        </section>
        <section class="scanDetailSection">
          <h3>Proposed USP / outreach</h3>
          <p>${escapeHtml(target.scoreJson?.outreachAngleSeed || assessment?.assessment?.outreachAngleSeed || target.nextAction || "No USP seed has been generated yet.")}</p>
          ${drafts.map((draft) => `<textarea class="pitchText" readonly rows="8">${escapeHtml(draft.pitchText || "")}</textarea>`).join("") || "<p>No outreach email draft recorded yet.</p>"}
          <div class="formActions">
            <button type="button" data-action="draft-outreach" ${canEdit ? "" : "disabled"}>Generate outreach</button>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderAssessmentDrivers(assessment) {
  const drivers = Array.isArray(assessment?.drivers) ? assessment.drivers : [];
  if (!drivers.length) return "";
  return `<div class="strategyList">${drivers.map((driver) => `
    <div>
      <strong>${escapeHtml(labelFromKey(driver.dimension || "driver"))} - ${Number(driver.score || 0).toFixed(1)}</strong>
      <span>${escapeHtml(driver.reason || "")}</span>
    </div>
  `).join("")}</div>`;
}

function renderRankingRuns(runs) {
  if (!runs.length) return "<p>No ranking runs yet.</p>";
  return `<div class="compactList rankingRunList">
    ${runs.map((run) => `
      <div>
        <strong>${escapeHtml(run.status)} - ${Number(run.rankedCount || 0)} ranked</strong>
        <span>${escapeHtml(run.reason || "Ranking rebuild")}</span>
        <small>${formatDate(run.updatedAt || run.completedAt || run.createdAt)}</small>
      </div>
    `).join("")}
  </div>`;
}

function renderServiceProfile(version) {
  if (!version) return `
    <h2>Company profile</h2>
    <p>No service profile has been created yet.</p>
  `;
  const profile = version.structured || {};
  const summary = profile.summary || version.summary || "";
  return `
    <section class="aboutAdapt">
      <div class="aboutAdaptTop">
        <span class="aboutEyebrow">About Adapt</span>
        <span class="aboutVersion">Version ${escapeHtml(version.versionNumber || "New")}</span>
      </div>
      <h2>${escapeHtml(profile.title || "Company profile")}</h2>
      ${summary ? `<p class="aboutSummary">${escapeHtml(summary)}</p>` : ""}
      ${profile.positioningStatement ? `
        <div class="aboutPositioning">
          <strong>Positioning</strong>
          <p>${escapeHtml(profile.positioningStatement)}</p>
        </div>` : ""}
    </section>
    ${renderServiceLines(profile.services || [])}
    ${renderProfileGroup("Ideal customer profile", profile.idealCustomerProfile)}
    ${renderProfileListSection("Problems solved", profile.problemsSolved)}
    ${renderProfileListSection("Buying triggers", profile.buyingTriggers)}
    ${renderProfileListSection("Differentiators", profile.differentiators)}
    ${renderOutreachVoice(profile.outreachVoice)}
    ${renderProfileListSection("Exclusions", profile.exclusions)}
    ${renderAssumptions(profile.assumptions || [])}
    ${renderProfileListSection("Rationale", profile.rationaleNotes || (version.rationale ? version.rationale.split("\\n") : []))}
    ${renderEvidence(profile.evidence || version.sourceReferences || [])}
    ${renderProfileListSection("Warnings", profile.warnings)}
  `;
}

function renderServiceLines(services) {
  if (!Array.isArray(services) || !services.length) return "";
  const count = services.length;
  return `
    <section class="profileSection offersSection">
      <div class="offersHeader">
        <h3>What Adapt offers</h3>
        <span class="offersCount">${count} service${count === 1 ? "" : "s"}</span>
      </div>
      <div class="serviceCardGrid">
        ${services.map((service) => `
          <article class="serviceCard">
            <h4>${escapeHtml(service.name || "Service")}</h4>
            <p>${escapeHtml(service.description || "")}</p>
            ${renderInlineList("Benefits", service.benefits)}
            ${renderInlineList("Proof", service.proofPoints)}
            ${renderInlineList("Targets", service.targetSegments)}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderProfileGroup(title, group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return "";
  const entries = Object.entries(group).filter(([, value]) => Array.isArray(value) ? value.length : value);
  if (!entries.length) return "";
  return `
    <section class="profileSection">
      <h3>${escapeHtml(title)}</h3>
      <div class="profileColumns">
        ${entries.map(([key, value]) => `
          <div>
            <strong>${escapeHtml(labelFromKey(key))}</strong>
            ${renderBulletList(value)}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderOutreachVoice(voice) {
  if (!voice || typeof voice !== "object" || Array.isArray(voice)) return "";
  return `
    <section class="profileSection">
      <h3>Outreach voice</h3>
      ${voice.tone ? `<p>${escapeHtml(voice.tone)}</p>` : ""}
      <div class="profileColumns">
        ${renderProfileColumn("Emphasise", voice.emphasise)}
        ${renderProfileColumn("Avoid", voice.avoid)}
      </div>
    </section>
  `;
}

function renderProfileColumn(label, values) {
  if (!Array.isArray(values) || !values.length) return "";
  return `<div><strong>${escapeHtml(label)}</strong>${renderBulletList(values)}</div>`;
}

function renderProfileListSection(title, values) {
  if (!Array.isArray(values) || !values.length) return "";
  return `
    <section class="profileSection">
      <h3>${escapeHtml(title)}</h3>
      ${renderBulletList(values)}
    </section>
  `;
}

function renderAssumptions(assumptions) {
  if (!Array.isArray(assumptions) || !assumptions.length) return "";
  return `
    <section class="profileSection">
      <h3>Assumptions</h3>
      <div class="assumptionList">
        ${assumptions.map((item) => `
          <div>
            <span>${escapeHtml(item.statement || item)}</span>
            ${item.confidence !== undefined ? `<small>${Math.round(Number(item.confidence || 0) * 100)}% confidence${item.needsEvidence ? " - needs evidence" : ""}</small>` : ""}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderEvidence(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return "";
  return `
    <section class="profileSection">
      <h3>Evidence</h3>
      <div class="assumptionList">
        ${evidence.map((item) => `
          <div>
            <strong>${escapeHtml(item.label || item.title || item.url || "Evidence")}</strong>
            <span>${escapeHtml(item.summary || "")}</span>
            ${item.confidence !== undefined ? `<small>${Math.round(Number(item.confidence || 0) * 100)}% confidence</small>` : ""}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderInlineList(label, values) {
  if (!Array.isArray(values) || !values.length) return "";
  return `<div class="inlineProfileList"><strong>${escapeHtml(label)}</strong>${renderBulletList(values)}</div>`;
}

function renderBulletList(values) {
  const items = Array.isArray(values) ? values : [values];
  return `<ul>${items.map((value) => `<li>${escapeHtml(formatProfileValue(value))}</li>`).join("")}</ul>`;
}

function renderProfileChatContext(version) {
  const profile = version?.structured || {};
  const questions = Array.isArray(profile.nextQuestions) ? profile.nextQuestions : [];
  const latest = profile.response || profile.changeSummary || "";
  return `
    ${latest ? `<div class="profileChatContext"><strong>Latest update</strong><span>${escapeHtml(latest)}</span></div>` : ""}
    ${questions.length ? `<div class="nextQuestionList">
      ${questions.slice(0, 5).map((question) => `<button type="button" data-service-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`).join("")}
    </div>` : ""}
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

function renderCompanyFilters(enrichedOnly = false) {
  const filters = state.kindlingFilters;
  const enrichmentCurrent = enrichedOnly ? "complete" : filters.enrichmentStatus || "";
  const option = (value, label, current) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`;
  return `
    <form class="companyFilters" data-form="company-filters">
      <input id="filterSearch" value="${escapeHtml(filters.q || "")}" placeholder="Search name" />
      <input id="filterIndustry" value="${escapeHtml(filters.industry || "")}" placeholder="Industry" />
      <input id="filterLocation" value="${escapeHtml(filters.location || "")}" placeholder="Location" />
      <select id="filterDataRing">
        ${option("", "Any data ring", filters.dataRing || "")}
        ${["found", "enhanced", "ranked", "scored", "outreach_ready", "contacted", "parked"].map((value) => option(value, value, filters.dataRing || "")).join("")}
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
        ${option("", enrichedOnly ? "Enriched only" : "Any enrichment", enrichmentCurrent)}
        ${["not_started", "queued", "complete", "failed"].map((value) => option(value, value, enrichmentCurrent)).join("")}
      </select>
      <div class="filterActions">
        <button type="submit">Apply</button>
        <button type="button" data-action="clear-company-filters">Clear</button>
      </div>
    </form>
  `;
}

function renderCompanyListRows(companies) {
  if (!companies.length) return "<p>No companies yet.</p>";
  return `<div class="companyTable companyListRows">
    ${companies.map((company) => {
      const meta = [company.industry, company.location].filter(Boolean).join(" · ") || "No details yet";
      const site = company.website
        ? `<a class="companyRowSite" href="${escapeHtml(/^https?:\/\//i.test(company.website) ? company.website : `https://${company.website}`)}" target="_blank" rel="noopener">${escapeHtml(company.website)}</a>`
        : "";
      const fitPill = company.fitScore != null
        ? `<span class="companyRowFit resultFit resultFit-${escapeHtml(company.fitBand || "high")}">${company.fitScore} fit</span>`
        : "";
      return `
        <div class="companyListRow" data-open-company="${escapeHtml(company.id)}" role="button" tabindex="0">
          <span class="companyRowMain">
            <strong>${escapeHtml(company.name)}</strong>
            <span class="companyRowBadges">
              ${fitPill}
              <small>${escapeHtml(stageLabel(company.enrichmentStatus))}</small>
            </span>
          </span>
          <span class="companyRowMeta">${escapeHtml(meta)}</span>
          ${site}
        </div>`;
    }).join("")}
  </div>`;
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
      ${["found", "enhanced", "ranked", "scored", "outreach_ready", "contacted", "parked"].map((value) => `<option value="${value}" ${company.dataRing === value ? "selected" : ""}>${value}</option>`).join("")}
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

async function runSchedulerOnce(dryRun) {
  const payload = await api(`/api/kindling/scheduler/run-once?dryRun=${dryRun ? "true" : "false"}`, {
    method: "POST",
    body: JSON.stringify({ deferAutopilotAuth: true }),
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
  const submitButton = event.submitter || form.querySelector('button[type="submit"]');
  setBusyElement(submitButton, true);
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
        q: $("filterSearch").value.trim(),
        industry: $("filterIndustry").value.trim(),
        location: $("filterLocation").value.trim(),
        dataRing: $("filterDataRing").value,
        duplicateStatus: $("filterDuplicate").value,
        hasWebsite: $("filterHasWebsite").value,
        enrichmentStatus: $("filterEnrichment").value,
      };
      state.kindlingPaging.companies = 0;
      state.kindlingPaging.enriched = 0;
      saveKindlingFilters();
      await loadKindlingScreen();
      setKindlingStatus("Company filters applied");
    }
    if (form.dataset.form === "scored-filters") {
      state.kindlingFilters = {
        ...state.kindlingFilters,
        hasOutreachDraft: $("filterHasOutreachDraft").checked ? "yes" : "",
      };
      state.kindlingPaging.targets = 0;
      saveKindlingFilters();
      await loadKindlingList("targets");
      setKindlingStatus(state.kindlingFilters.hasOutreachDraft === "yes" ? "Showing drafted outreach" : "Showing all in this band");
    }
    if (form.dataset.form === "scheduler-settings") {
      setKindlingStatus("Saving scheduler settings");
      await api("/api/kindling/scheduler-settings", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: $("scheduler_enabled").checked,
          acquisitionEnabled: $("scheduler_acquisitionEnabled").checked,
          enrichmentEnabled: $("scheduler_enrichmentEnabled").checked,
          scoringEnabled: $("scheduler_scoringEnabled").checked,
          outreachEnabled: $("scheduler_outreachEnabled").checked,
          targetPoolSize: Number($("schedulerTargetPoolSize").value || 0),
          enrichedFloor: Number($("schedulerEnrichedFloor").value || 0),
          topTargetCount: Number($("schedulerTopTargetCount").value || 0),
          outreachTargetCount: Number($("schedulerOutreachTargetCount").value || 0),
          perRoleConcurrency: JSON.parse($("schedulerConcurrency").value || "{}"),
          cooldowns: JSON.parse($("schedulerCooldowns").value || "{}"),
        }),
      });
      await loadKindlingScreen();
      setKindlingStatus("Scheduler settings saved");
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
  } finally {
    setBusyElement(submitButton, false);
  }
}

async function handleKindlingClick(event) {
  const busyButton = event.target.closest("button");
  const busyAction = busyButton?.dataset.action || busyButton?.dataset.kindlingView || busyButton?.dataset.openMatch || busyButton?.dataset.selectCompany || busyButton?.dataset.scanJob || busyButton?.dataset.enrichIndustry || busyButton?.dataset.retryWorkQueue;
  if (busyAction && !busyButton.disabled) setBusyElement(busyButton, true);
  try {
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
    const nextView = viewButton.dataset.kindlingView;
    setKindlingView(nextView);
    navigate(routeForKindlingView(nextView));
    return;
  }
  const pageButton = event.target.closest("[data-page-list]");
  if (pageButton) {
    const listKey = pageButton.dataset.pageList;
    if (Object.prototype.hasOwnProperty.call(state.kindlingPaging, listKey)) {
      state.kindlingPaging[listKey] = Math.max(0, Number(pageButton.dataset.pageOffset || 0));
      await loadKindlingList(listKey);
    }
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
  const serviceQuestionButton = event.target.closest("[data-service-question]");
  if (serviceQuestionButton) {
    const input = $("servicePrompt");
    if (input) {
      input.value = serviceQuestionButton.dataset.serviceQuestion || "";
      input.focus();
    }
    return;
  }
  const stageButton = event.target.closest("[data-company-stage]");
  if (stageButton) {
    state.kindlingFilters = {
      ...state.kindlingFilters,
      enrichmentStatus: stageButton.dataset.companyStage || "",
    };
    state.kindlingPaging.companies = 0;
    saveKindlingFilters();
    await loadKindlingScreen();
    setKindlingStatus(state.kindlingFilters.enrichmentStatus ? `${stageLabel(state.kindlingFilters.enrichmentStatus)} companies` : "All companies");
    return;
  }
  const scoredBandButton = event.target.closest("[data-scored-band]");
  if (scoredBandButton) {
    state.kindlingFilters = {
      ...state.kindlingFilters,
      band: scoredBandButton.dataset.scoredBand || "high",
    };
    state.kindlingPaging.targets = 0;
    saveKindlingFilters();
    setKindlingStatus("Loading…");
    await loadKindlingList("targets");
    const labels = { high: "High-fit call list", medium: "Medium-fit list", low: "Low-fit (parked)" };
    setKindlingStatus(labels[state.kindlingFilters.band] || "Scored");
    return;
  }
  const matchButton = event.target.closest("[data-open-match]");
  if (matchButton) {
    const companyId = matchButton.dataset.selectCompany || "";
    state.selectedTargetId = matchButton.dataset.openMatch || "";
    state.selectedCompanyId = companyId;
    localStorage.setItem("kindling_target", state.selectedTargetId);
    localStorage.setItem("kindling_company", state.selectedCompanyId);
    state.companyProfileOpen = false;
    state.companyDetail = null;
    // Switch to the match view immediately using the target data we already
    // have, then fill in the company detail in the background — no full reload.
    setKindlingView("match");
    kindlingViewLoading = false;
    if (window.location.pathname !== "/match") history.pushState({}, "", "/match");
    state.route = "/match";
    renderKindling();
    setKindlingStatus("Loading match");
    if (selectedTarget(state.kindling)) {
      if (companyId) {
        const detail = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}`);
        if (state.selectedCompanyId === companyId && state.activeKindlingView === "match") {
          state.companyDetail = detail;
          renderKindling();
        }
      }
      setKindlingStatus("Match loaded");
    } else {
      // No scored list in memory (e.g. deep link) — fall back to a full load.
      await loadKindlingScreen();
    }
    return;
  }
  const selectButton = event.target.closest("[data-select-company]");
  if (selectButton) {
    const companyId = selectButton.dataset.selectCompany;
    state.selectedCompanyId = companyId;
    localStorage.setItem("kindling_company", companyId);
    state.scanJobDetail = null;
    state.companyProfileOpen = true;
    state.companyDetail = null;
    kindlingViewLoading = false;
    // Open the modal immediately with the company we already have, then load
    // the full detail (sources/activity/drafts) in the background.
    renderKindling();
    setKindlingStatus("Loading company profile");
    const detail = await api(`/api/kindling/companies/${encodeURIComponent(companyId)}`);
    if (state.selectedCompanyId === companyId && state.companyProfileOpen) {
      state.companyDetail = detail;
      renderKindling();
      setKindlingStatus("Company profile loaded");
    }
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "home") navigate("/");
  if (action === "refresh-kindling") await loadKindlingScreen();
  if (action === "scheduler-dry-run") {
    setKindlingStatus("Running scheduler dry run");
    await runSchedulerOnce(true);
    await loadKindlingScreen();
    setKindlingStatus("Scheduler dry run complete");
  }
  if (action === "scheduler-run-once") {
    setKindlingStatus("Running scheduler once");
    await runSchedulerOnce(false);
    await refreshKindlingSoon();
    setKindlingStatus("Scheduler run submitted");
  }
  if (action === "run-initial-ranking") {
    setKindlingStatus("Running initial ranking");
    await api("/api/kindling/initial-ranking/run", {
      method: "POST",
      body: JSON.stringify({ reason: "Manual UI initial ranking rebuild" }),
    });
    await loadKindlingScreen();
    setKindlingStatus("Initial ranking rebuilt");
  }
  if (action === "rebuild-top-targets") {
    setKindlingStatus("Rebuilding top targets");
    await api("/api/kindling/top-targets/rebuild", {
      method: "POST",
      body: JSON.stringify({ reason: "Manual UI top-target rebuild" }),
    });
    await loadKindlingScreen();
    setKindlingStatus("Top targets rebuilt");
  }
  if (action === "open-company-create") {
    state.companyCreateOpen = true;
    renderKindling();
  }
  if (action === "clear-company-filters") {
    state.kindlingFilters = {};
    state.kindlingPaging.companies = 0;
    state.kindlingPaging.enriched = 0;
    saveKindlingFilters();
    await loadKindlingScreen();
    setKindlingStatus("Company filters cleared");
  }
  if (action === "clear-failed-work-queue") {
    const failedCount = Number(state.kindling?.counts?.workQueue?.failed || 0);
    if (!failedCount) return;
    const confirmed = window.confirm(`Clear ${failedCount} failed queue item${failedCount === 1 ? "" : "s"}? They will be marked cancelled and removed from backlog counts.`);
    if (!confirmed) return;
    setKindlingStatus("Clearing failed queue items");
    const cleared = await api("/api/kindling/work-queue/clear-failed", {
      method: "POST",
      body: "{}",
    });
    state.kindlingPaging.workQueue = 0;
    await loadKindlingScreen();
    setKindlingStatus(`Cleared ${Number(cleared.cleared || 0)} failed queue item${Number(cleared.cleared || 0) === 1 ? "" : "s"}`);
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
  const retryQueueButton = event.target.closest("[data-retry-work-queue]");
  if (retryQueueButton) {
    setKindlingStatus("Retrying queue item");
    await api(`/api/kindling/work-queue/${encodeURIComponent(retryQueueButton.dataset.retryWorkQueue)}/retry`, {
      method: "POST",
      body: "{}",
    });
    await loadKindlingScreen();
    setKindlingStatus("Queue item retried");
  }
  } catch (error) {
    setKindlingStatus(error.message);
  } finally {
    setBusyElement(busyButton, false);
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
  $("publicOriginInput").value = state.settings?.publicOrigin || "";
  $("pipelineInput").value = state.settings?.defaultPipeline || "";
  $("snoozeDaysInput").value = state.settings?.snoozeDays || 1;
  const canEdit = Boolean(state.me?.access?.edit);
  for (const id of ["autopilotUrlInput", "publicOriginInput", "pipelineInput", "snoozeDaysInput", "pipelineSelect", "loadPipelinesButton", "saveSettingsButton", "researchDeskButton", "accessNpubInput", "accessRoleSelect", "addAccessButton"]) {
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
        publicOrigin: $("publicOriginInput").value.trim(),
        defaultPipeline: $("pipelineInput").value.trim(),
        snoozeDays: Math.max(1, Math.min(365, Math.floor(Number($("snoozeDaysInput").value) || 1))),
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

// Full-screen Chats view: previous chats as a horizontally-scrolling tab strip,
// mirroring the floating widget's style.
function renderChats() {
  const bar = $("chatTabs");
  if (!bar) return;
  bar.innerHTML = "";
  for (const chat of state.chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `athenaTab${chat.id === state.activeChatId ? " active" : ""}`;
    button.textContent = chat.title || "New chat";
    button.title = chat.title || "New chat";
    button.addEventListener("click", async () => {
      state.activeChatId = chat.id;
      localStorage.setItem("chat_wapp_chat", chat.id);
      renderChats();
      await loadActiveChat();
    });
    bar.appendChild(button);
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
    if (message.status === "pending") {
      node.textContent = "Thinking...";
    } else if (message.role === "assistant") {
      node.classList.add("markdownBody");
      node.innerHTML = renderMarkdown(message.content || "");
    } else {
      node.textContent = message.content;
    }
    box.appendChild(node);
  }
  box.scrollTop = box.scrollHeight;
  const pending = messages.some((message) => message.status === "pending");
  setStatus(pending ? "Pipeline running" : "Ready");
}

function syncAccessUi() {
  const canEdit = Boolean(state.me?.access?.edit);
  for (const id of ["homeChatButton", "newChatButton", "messageInput", "sendButton"]) {
    const el = $(id);
    if (el) el.disabled = !canEdit;
  }
}

// Shared chat-send core used by both the full-screen chat and the floating
// Ask Athena widget. Posts the user message, and if the backend asks for a
// NIP-98 pipeline authorization, signs it and starts the run. `onProgress` is
// called with the interim message list (user + pending assistant) so the UI can
// echo the message immediately, before signing completes.
async function postChatMessage(content, onProgress) {
  const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (onProgress) onProgress(payload.messages || []);
  if (payload.requiresAutopilotAuth && payload.triggerRequest) {
    const autopilotAuthorization = await signNip98Request(payload.triggerRequest);
    const started = await api(`/api/pipeline-runs/${encodeURIComponent(payload.runId)}/start`, {
      method: "POST",
      body: JSON.stringify({ autopilotAuthorization }),
    });
    return started.messages || payload.messages || [];
  }
  return payload.messages || [];
}

async function sendMessage(event) {
  event.preventDefault();
  if (!state.me?.access?.edit) return;
  const input = $("messageInput");
  const content = input.value.trim();
  if (!content || !state.activeChatId) return;
  input.value = "";
  $("sendButton").disabled = true;
  try {
    setStatus("Authorizing pipeline");
    const messages = await postChatMessage(content, (interim) => renderMessages(interim));
    renderMessages(messages);
    await loadChats();
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("sendButton").disabled = !state.me?.access?.edit;
    if (state.me?.access?.edit) input.focus();
  }
}

// ---- Floating "Ask Athena" widget ----------------------------------------
// A read-only chat that overlays every app page. Shares state.activeChatId and
// the chats list with the full-screen Chats view, so it always shows the most
// recent thread; "+" starts a new one. Live updates via its own poll loop.

function athenaEditable() {
  return Boolean(state.me?.access?.edit);
}

function setAthenaStatus(text) {
  const el = $("athenaStatus");
  if (el) el.textContent = text;
}

async function openAthena() {
  if (!state.token || !state.me) return;
  state.athena.open = true;
  $("athenaPanel").classList.remove("hidden");
  $("athenaLauncher").classList.add("active");
  try {
    await loadChats();
    if (!state.activeChatId || !state.chats.find((chat) => chat.id === state.activeChatId)) {
      if (state.chats[0]) {
        state.activeChatId = state.chats[0].id;
        localStorage.setItem("chat_wapp_chat", state.activeChatId);
      } else if (athenaEditable()) {
        await newAthenaChat();
      }
    }
    renderAthenaTabs();
    if (state.activeChatId) await loadAthenaChat();
    else renderAthenaMessages([]);
  } catch (error) {
    setAthenaStatus(error.message);
  }
  syncAthenaAccess();
  applyAthenaChrome();
  startAthenaPolling();
  $("athenaInput")?.focus();
}

function closeAthena() {
  state.athena.open = false;
  state.athena.pinned = false;
  localStorage.setItem("athena_pinned", "0");
  $("athenaPanel").classList.add("hidden");
  $("athenaLauncher").classList.remove("active");
  applyAthenaChrome();
  stopAthenaPolling();
}

function toggleAthena() {
  if (state.athena.open) closeAthena();
  else void openAthena();
}

// Toggle the docked right-hand drawer. Pinning implies open; the panel then
// persists across pages until unpinned or closed.
function toggleAthenaPin() {
  state.athena.pinned = !state.athena.pinned;
  localStorage.setItem("athena_pinned", state.athena.pinned ? "1" : "0");
  if (state.athena.pinned && !state.athena.open) {
    void openAthena();
    return;
  }
  applyAthenaChrome();
}

// Apply pinned/floating chrome: docks the panel as a right column and pushes the
// page content over so it isn't covered. Hidden on /chat and when signed out.
function applyAthenaChrome() {
  const root = $("athena");
  const app = $("app");
  const pinBtn = $("athenaPin");
  if (!root || !app) return;
  const visible = !root.classList.contains("hidden");
  const pinned = state.athena.pinned && state.athena.open && visible;
  root.classList.toggle("pinned", pinned);
  app.classList.toggle("athenaPinned", pinned);
  if (pinBtn) {
    pinBtn.textContent = state.athena.pinned ? "⇤" : "⇥";
    pinBtn.title = state.athena.pinned ? "Unpin" : "Pin to side";
    pinBtn.classList.toggle("active", state.athena.pinned);
  }
}

function selectAthenaChat(chatId) {
  state.activeChatId = chatId;
  localStorage.setItem("chat_wapp_chat", chatId);
  renderAthenaTabs();
  void loadAthenaChat();
  $("athenaInput")?.focus();
}

async function newAthenaChat() {
  if (!athenaEditable()) return;
  const payload = await api("/api/chats", { method: "POST", body: "{}" });
  state.activeChatId = payload.chat.id;
  localStorage.setItem("chat_wapp_chat", state.activeChatId);
  await loadChats();
  renderAthenaTabs();
  await loadAthenaChat();
  $("athenaInput")?.focus();
}

async function loadAthenaChat() {
  if (!state.activeChatId) return;
  const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`);
  renderAthenaMessages(payload.messages || []);
}

function renderAthenaTabs() {
  const bar = $("athenaTabs");
  if (!bar) return;
  bar.innerHTML = "";
  for (const chat of state.chats.slice(0, 5)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `athenaTab${chat.id === state.activeChatId ? " active" : ""}`;
    btn.textContent = chat.title || "New chat";
    btn.title = chat.title || "New chat";
    btn.addEventListener("click", () => selectAthenaChat(chat.id));
    bar.appendChild(btn);
  }
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "athenaTab athenaTabNew";
  plus.textContent = "+";
  plus.title = "New chat";
  plus.disabled = !athenaEditable();
  plus.addEventListener("click", () => void newAthenaChat());
  bar.appendChild(plus);
}

function renderAthenaMessages(messages) {
  const box = $("athenaMessages");
  if (!box) return;
  box.innerHTML = "";
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "athenaEmpty";
    empty.textContent = athenaEditable()
      ? "Ask about the system, data, or processes. Athena is read-only — it never changes anything."
      : "You have read-only access. Ask an editor to chat with Athena.";
    box.appendChild(empty);
  }
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = `athenaMessage ${message.role} ${message.status}`;
    if (message.status === "pending") {
      node.textContent = "Thinking…";
    } else if (message.role === "assistant") {
      node.classList.add("markdownBody");
      node.innerHTML = renderMarkdown(message.content || "");
    } else {
      node.textContent = message.content;
    }
    box.appendChild(node);
  }
  box.scrollTop = box.scrollHeight;
  const pending = messages.some((message) => message.status === "pending");
  setAthenaStatus(pending ? "Athena is thinking…" : "Ready");
}

function syncAthenaAccess() {
  const canEdit = athenaEditable();
  for (const id of ["athenaInput", "athenaSend"]) {
    const el = $(id);
    if (el) el.disabled = !canEdit;
  }
}

async function sendAthenaMessage(event) {
  event.preventDefault();
  if (!athenaEditable()) return;
  const input = $("athenaInput");
  const content = input.value.trim();
  if (!content || !state.activeChatId) return;
  input.value = "";
  $("athenaSend").disabled = true;
  try {
    setAthenaStatus("Authorizing…");
    const messages = await postChatMessage(content, (interim) => renderAthenaMessages(interim));
    renderAthenaMessages(messages);
    await loadChats();
    renderAthenaTabs();
  } catch (error) {
    setAthenaStatus(error.message);
  } finally {
    $("athenaSend").disabled = !athenaEditable();
    if (athenaEditable()) input.focus();
  }
}

function startAthenaPolling() {
  stopAthenaPolling();
  state.athenaPollTimer = setInterval(async () => {
    if (state.athena.open && state.activeChatId && state.token) {
      await loadAthenaChat().catch(() => undefined);
      await loadChats().catch(() => undefined);
      renderAthenaTabs();
    }
  }, 1500);
}

function stopAthenaPolling() {
  if (state.athenaPollTimer) clearInterval(state.athenaPollTimer);
  state.athenaPollTimer = null;
}

// Show the launcher on every app page once signed in; hide it on the login
// screen and on the full-screen /chat view (where it would be redundant).
function syncAthenaLauncher() {
  const root = $("athena");
  if (!root) return;
  const hide = !(state.token && state.me) || state.route === "/chat";
  root.classList.toggle("hidden", hide);
  if (hide) {
    // Don't lose the pinned preference when passing through /chat — just undock.
    root.classList.remove("pinned");
    $("app")?.classList.remove("athenaPinned");
    return;
  }
  // Re-dock the pinned drawer when returning to a normal page.
  if (state.athena.pinned && !state.athena.open) {
    void openAthena();
    return;
  }
  applyAthenaChrome();
}

// Resolve the signer to use for a NIP-98 (kind 27235) pipeline authorization.
// Prefer the active in-memory signer; fall back to a fresh extension signer if
// the page reloaded onto a restored bearer session. An nsec signer cannot be
// restored after reload, so we ask the user to reconnect one.
function currentSigner() {
  if (state.signer) return state.signer;
  if (window.nostr) {
    state.signer = makeExtensionSigner();
    return state.signer;
  }
  throw new Error("Reconnect a Nostr signer to authorize this pipeline run.");
}

async function signNip98Request(triggerRequest) {
  const signer = currentSigner();
  const tags = [
    ["u", triggerRequest.url],
    ["method", triggerRequest.method || "POST"],
  ];
  if (triggerRequest.body !== undefined) {
    const bodyJson = JSON.stringify(triggerRequest.body);
    tags.push(["payload", await sha256Hex(bodyJson)]);
  }
  const event = await signer.signEvent({
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

$("loginButton").addEventListener("click", loginWithExtension);
$("showNsecLogin")?.addEventListener("click", () => setLoginMethod("nsec"));
$("showExtensionLogin")?.addEventListener("click", () => setLoginMethod("extension"));
$("nsecLoginButton")?.addEventListener("click", loginWithNsec);
$("loginNsec")?.addEventListener("submit", (event) => {
  event.preventDefault();
  void loginWithNsec();
});
$("logoutButton")?.addEventListener("click", logout);
$("newChatButton").addEventListener("click", newChat);
$("homeActButton").addEventListener("click", () => {
  setKindlingView("companies");
  navigate("/companies");
});
$("homeServiceButton").addEventListener("click", () => {
  setKindlingView("service");
  navigate("/service-offerings");
});
$("homeTargetsButton").addEventListener("click", () => {
  setKindlingView("targets");
  navigate("/targets");
});
$("homeEnrichedButton").addEventListener("click", () => {
  setKindlingView("enriched");
  navigate("/enriched-companies");
});
$("homeMatchButton").addEventListener("click", () => {
  setKindlingView("match");
  navigate("/match");
});
$("homeResearchButton").addEventListener("click", () => {
  setKindlingView("research");
  navigate("/researchdesk");
});
$("homeChatButton").addEventListener("click", () => navigate("/chat"));

// Floating Ask Athena widget
$("athenaLauncher")?.addEventListener("click", toggleAthena);
$("athenaPin")?.addEventListener("click", toggleAthenaPin);
$("athenaClose")?.addEventListener("click", closeAthena);
$("athenaExpand")?.addEventListener("click", () => { closeAthena(); navigate("/chat"); });
$("athenaComposer")?.addEventListener("submit", sendAthenaMessage);
$("athenaInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("athenaComposer").requestSubmit();
  }
});
$("homeSettingsButton").addEventListener("click", () => navigate("/settings"));
$("settingsHomeButton").addEventListener("click", () => navigate("/"));
$("homeFocusButton").addEventListener("click", () => navigate("/"));

// Sidebar drawer interactions
$("appNavList").addEventListener("click", (event) => {
  const route = event.target.closest("[data-nav]")?.dataset.nav;
  if (route) navigate(route);
});
$("appNavCollapse").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleNavCollapsed();
});
$("appNavUser").addEventListener("click", (event) => {
  if (event.target.closest("#appNavLogout")) logout();
});
// Clicking the logo toggles the drawer; clicking empty space in a collapsed
// drawer re-expands it (the collapse button is hidden while collapsed).
$("appNav").addEventListener("click", (event) => {
  if (event.target.closest("#appNavCollapse, [data-nav], #appNavUser")) return;
  if (event.target.closest(".appNavBrand")) {
    toggleNavCollapsed();
  } else if (state.navCollapsed) {
    toggleNavCollapsed();
  }
});

// Lightweight page retry buttons
$("servicePage").addEventListener("click", (event) => {
  if (event.target.closest('[data-page-action="retry-service"]')) void loadServicePage({ force: true });
});
$("companyListPage").addEventListener("click", (event) => {
  if (event.target.closest('[data-page-action="retry-companies"]')) {
    void loadCompanyListPage({ force: true });
    return;
  }
  const band = event.target.closest("[data-company-band]")?.dataset.companyBand;
  if (band) {
    setCompanyBand(band);
    return;
  }
  const page = event.target.closest("[data-company-page]")?.dataset.companyPage;
  if (page) { stepCompanyPage(page === "next" ? 1 : -1); return; }
  // Open the shared details overlay for a row — but let the inline website link
  // behave like a normal link.
  if (event.target.closest("a")) return;
  const row = event.target.closest("[data-open-company]");
  if (row) {
    const companyId = row.dataset.openCompany;
    const company = (state.companyListPage.companies || []).find((c) => c.id === companyId) || null;
    openCompanyModal({ companyId, company });
  }
});
$("companyListPage").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest?.("[data-open-company]");
  if (!row) return;
  event.preventDefault();
  const companyId = row.dataset.openCompany;
  const company = (state.companyListPage.companies || []).find((c) => c.id === companyId) || null;
  openCompanyModal({ companyId, company });
});

$("focus").addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-focus-action]");
  const action = trigger?.dataset.focusAction;
  if (!action) return;
  if (action === "prev") focusStep(-1);
  else if (action === "next") focusStep(1);
  else if (action === "contacts-prev") focusContactStep(-1);
  else if (action === "contacts-next") focusContactStep(1);
  else if (action === "open" || action === "details") focusOpenCurrent();
  else if (action === "retry") void loadFocusScreen({ force: true });
  else if (action === "sent") void focusSentCurrent(trigger);
  else if (action === "reach") openReachOutModal();
  else if (action === "snooze") {
    const item = state.focus.items[state.focus.index];
    if (item) void snoozeFromDeck(item.companyId || item.company?.id, trigger);
  }
  else if (action === "dismiss") {
    const item = state.focus.items[state.focus.index];
    if (item) dismissFromDeck(item.companyId || item.company?.id);
  }
});

// Shared company-details overlay interactions (mounted globally so it works from
// any screen).
$("companyModalRoot").addEventListener("click", (event) => {
  // Reviewer feedback controls toggle in place (no re-render) so the note keeps focus.
  const verdictBtn = event.target.closest("[data-feedback-verdict]");
  if (verdictBtn) {
    const wasActive = verdictBtn.classList.contains("active");
    document.querySelectorAll("#companyFeedback [data-feedback-verdict]").forEach((b) => b.classList.remove("active"));
    if (!wasActive) verdictBtn.classList.add("active");
    return;
  }
  const labelBtn = event.target.closest("[data-feedback-label]");
  if (labelBtn) { labelBtn.classList.toggle("active"); return; }
  if (event.target.closest("[data-feedback-save]")) { void saveCompanyFeedback(event.target.closest("[data-feedback-save]")); return; }

  const trigger = event.target.closest("[data-modal-action]");
  const action = trigger?.dataset.modalAction;
  if (!action) return;
  if (action === "close") {
    // Close on the backdrop itself or the Close button — not on clicks inside
    // the panel (links, text selection, draft nav, etc.).
    if (!event.target.closest("[data-modal-panel]") || trigger.tagName === "BUTTON") closeCompanyModal();
    return;
  }
  if (action === "draft-prev") companyModalDraftStep(-1);
  else if (action === "draft-next") companyModalDraftStep(1);
  else if (action === "draft-copy") companyModalDraftCopy(trigger);
});
document.addEventListener("keydown", (event) => {
  if (state.reasonModal) {
    if (event.key === "Escape") closeReasonModal();
    return;
  }
  // The company-details overlay can be open over any screen — Escape closes it
  // and swallows the deck shortcuts while it's up.
  if (state.companyModal.open) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCompanyModal();
    }
    return;
  }
  if ($("focus").classList.contains("hidden")) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    focusStep(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    focusStep(1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    focusOpenCurrent();
  }
});

// Results page interactions
$("resultsPage").addEventListener("click", (event) => {
  if (event.target.closest('[data-page-action="retry-results"]')) { void loadResultsPage({ force: true }); return; }
  const tab = event.target.closest("[data-results-tab]")?.dataset.resultsTab;
  if (tab) { setResultsTab(tab); return; }
  const pg = event.target.closest("[data-results-page]")?.dataset.resultsPage;
  if (pg) { stepResultsPage(pg === "next" ? 1 : -1); return; }
  if (event.target.closest("[data-results-clear]")) {
    state.resultsPage.q = "";
    state.resultsPage.offset = 0;
    void loadResultsPage({ force: true });
    return;
  }
  const meetingId = event.target.closest("[data-result-meeting]")?.dataset.resultMeeting;
  if (meetingId) {
    const btn = event.target.closest("[data-result-meeting]");
    setBusyElement(btn, true, "Saving");
    void api("/api/kindling/outreach/respond", { method: "POST", body: JSON.stringify({ companyId: meetingId, outcome: "meeting" }) })
      .then(() => loadResultsPage({ force: true }))
      .catch((err) => { setBusyElement(btn, false); alert(`Couldn't save: ${err?.message || err}`); });
    return;
  }
  const dropId = event.target.closest("[data-result-drop]")?.dataset.resultDrop;
  if (dropId) { dropFromResults(dropId); return; }
  const menuToggle = event.target.closest("[data-result-menu]");
  if (menuToggle) {
    const menu = menuToggle.closest(".resultMenu");
    const wasOpen = menu.classList.contains("open");
    $("resultsPage").querySelectorAll(".resultMenu.open").forEach((m) => m.classList.remove("open"));
    if (!wasOpen) menu.classList.add("open");
    return;
  }
  const undoId = event.target.closest("[data-result-undo]")?.dataset.resultUndo;
  if (undoId) {
    const btn = event.target.closest("[data-result-undo]");
    setBusyElement(btn, true, "Undoing");
    void api("/api/kindling/outreach/undo", { method: "POST", body: JSON.stringify({ companyId: undoId }) })
      .then(() => {
        state.focus.loaded = false; // deck must refetch — this company is back
        return loadResultsPage({ force: true });
      })
      .catch((err) => { setBusyElement(btn, false); alert(`Couldn't undo: ${err?.message || err}`); });
  }
});
$("resultsPage").addEventListener("submit", (event) => {
  if (!event.target.closest("[data-results-search]")) return;
  event.preventDefault();
  state.resultsPage.q = ($("resultsSearchInput")?.value || "").trim();
  state.resultsPage.offset = 0;
  void loadResultsPage({ force: true });
});
// Close any open row menu when clicking outside of it.
document.addEventListener("click", (event) => {
  if (event.target.closest(".resultMenu")) return;
  $("resultsPage")?.querySelectorAll(".resultMenu.open").forEach((m) => m.classList.remove("open"));
});

// Reason / outcome modal interactions
$("reasonModalRoot").addEventListener("click", (event) => {
  if (event.target.closest("[data-reason-confirm]")) { void confirmReasonModal(); return; }
  if (event.target.closest("[data-reason-close]")) { closeReasonModal(); return; }
  // Only a click on the backdrop itself (outside the modal box) dismisses; clicks
  // on the dropdown/textarea/etc. inside the modal must not close it.
  if (event.target.classList.contains("reasonModalBackdrop")) closeReasonModal();
});

$("researchDeskButton").addEventListener("click", () => {
  setKindlingView("research");
  navigate("/researchdesk");
});
// NOTE: capture the button element synchronously — event.currentTarget is null
// inside the async .finally (after dispatch ends), which previously left the
// button stuck disabled on "Working".
$("saveSettingsButton").addEventListener("click", (event) => {
  const btn = event.currentTarget;
  setBusyElement(btn, true);
  void saveSettings().finally(() => setBusyElement(btn, false));
});
$("saveAutomationButton")?.addEventListener("click", (event) => {
  const btn = event.currentTarget;
  setBusyElement(btn, true);
  void saveAutomation().finally(() => setBusyElement(btn, false));
});
$("loadPipelinesButton").addEventListener("click", (event) => {
  const btn = event.currentTarget;
  setBusyElement(btn, true);
  void loadPipelines().finally(() => setBusyElement(btn, false));
});
$("addAccessButton").addEventListener("click", (event) => {
  const btn = event.currentTarget;
  setBusyElement(btn, true);
  void addAccess().finally(() => setBusyElement(btn, false));
});
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
