// RSS alert ingestion orchestration: poll feeds, resolve the hiring employer,
// find-or-create the company, attach a hiring_intent signal, and hand off to the
// existing enrichment → scoring → deck pipeline. See docs/RssAlertIngestion.md.
//
// All persistence is done directly against the shared `db` so this module has no
// import cycle with server.ts (which only imports the two loop entry points).

import {
  db,
  getSchedulerSettings,
  selectDueAlertFeeds,
  recordAlertFeedPoll,
  insertAlertHit,
  listQueuedAlertHits,
  updateAlertHit,
  type AlertHit,
} from "./db.ts";
import { fetchFeed } from "./rss.ts";

const DEFAULT_ALERTS_CADENCE_MS = 15 * 60 * 1000;
const ALERT_ENRICHMENT_PRIORITY = 5; // ahead of standard (10) and batch (50)
const ICP_HIGH_BAND_MIN_SCORE = 75; // matches server.ts band=high threshold

// ---------------------------------------------------------------------------
// Employer resolution (heuristic v1 — swap point for an LLM resolver, see docs)
// ---------------------------------------------------------------------------

const JOB_BOARD_NOISE = /\b(seek|seek\.com\.au|jobs?|careers?|indeed|linkedin|glassdoor|jora|apply now|full time|part time|hiring)\b/i;
const LOCATION_NOISE = /\b(perth|western australia|wa|australia|nsw|vic|qld|sa|nt|act|tas|cbd|remote|hybrid)\b/i;
// Global variants for stripping (replace needs the g flag to remove every match).
const JOB_BOARD_NOISE_G = /\b(seek|seek\.com\.au|jobs?|careers?|indeed|linkedin|glassdoor|jora|apply now|full time|part time|hiring)\b/gi;
const LOCATION_NOISE_G = /\b(perth|western australia|wa|australia|nsw|vic|qld|sa|nt|act|tas|cbd|remote|hybrid)\b/gi;

export type ResolvedEmployer = { companyName: string; jobTitle: string };

function cleanCompanyName(raw: string): string {
  return raw
    .replace(/\b(pty\.?\s*ltd\.?|ltd\.?|inc\.?|llc)\b/gi, " ")
    .replace(/[|•·–—]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-,:]+|[\s\-,:]+$/g, "")
    .trim();
}

function plausibleCompany(name: string): boolean {
  const cleaned = cleanCompanyName(name);
  if (cleaned.length < 2 || cleaned.length > 90) return false;
  // Reject fragments that are only job-board or location noise.
  const stripped = cleaned.replace(JOB_BOARD_NOISE_G, "").replace(LOCATION_NOISE_G, "").replace(/\s+/g, " ").trim();
  if (stripped.length < 2) return false;
  return true;
}

// Best-effort extraction of employer + job title from a Google Alerts entry.
// Handles common SEEK/LinkedIn title shapes; returns null when no plausible
// employer can be isolated (e.g. recruiter-posted ads with no named end client).
export function extractEmployer(title: string, snippet = ""): ResolvedEmployer | null {
  let text = String(title ?? "").trim();
  if (!text) return null;
  // Drop trailing job-board branding: "... - SEEK", "... | SEEK".
  text = text.replace(/\s*[-|]\s*(seek(\.com\.au)?|indeed|linkedin|jora|careerone)\s*$/i, "").trim();

  // LinkedIn shape: "<Company> hiring <Job Title> in <Location>".
  const hiring = text.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+.+)?$/i);
  if (hiring) {
    const company = cleanCompanyName(hiring[1]!);
    if (plausibleCompany(company)) return { companyName: company, jobTitle: cleanCompanyName(hiring[2]!) };
  }

  // "<Job Title> at <Company>" (optionally "... in <Location>").
  const at = text.match(/^(.+?)\s+at\s+(.+?)(?:\s+in\s+.+)?$/i);
  if (at) {
    const company = cleanCompanyName(at[2]!.replace(/\s*-\s*.*$/, ""));
    if (plausibleCompany(company)) return { companyName: company, jobTitle: cleanCompanyName(at[1]!) };
  }

  // Dash-separated: "<Job Title> - <Company> - <Location> - SEEK".
  const parts = text.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Prefer the first segment that is neither the job title (parts[0]) nor pure
    // location/board noise as the employer.
    for (let i = 1; i < parts.length; i++) {
      const candidate = cleanCompanyName(parts[i]!);
      if (LOCATION_NOISE.test(candidate) && !plausibleCompany(candidate)) continue;
      if (JOB_BOARD_NOISE.test(candidate) && !plausibleCompany(candidate)) continue;
      if (plausibleCompany(candidate)) {
        return { companyName: candidate, jobTitle: cleanCompanyName(parts[0]!) };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// DB helpers (direct, to avoid a server.ts import cycle)
// ---------------------------------------------------------------------------

function activeMarketProfileVersionId(): string | null {
  const row = db.query(`
    SELECT current_version_id FROM market_profiles
    WHERE current_version_id IS NOT NULL AND current_version_id != ''
    ORDER BY updated_at DESC LIMIT 1
  `).get() as Record<string, unknown> | null;
  return row?.current_version_id ? String(row.current_version_id) : null;
}

function findCompanyByName(name: string): Record<string, unknown> | null {
  return db.query(`
    SELECT * FROM companies
    WHERE lower(name) = lower(?1)
    ORDER BY CASE WHEN data_ring NOT IN ('processed', 'parked') THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 1
  `).get(name) as Record<string, unknown> | null;
}

function recordActivity(targetId: string, actionType: string, summary: string, payload: Record<string, unknown>, now: number): void {
  db.query(`
    INSERT INTO activities(id, target_type, target_id, actor, action_type, summary, payload_json, created_at)
    VALUES (?1, 'company', ?2, 'alert_ingestion', ?3, ?4, ?5, ?6)
  `).run(crypto.randomUUID(), targetId, actionType, summary, JSON.stringify(payload), now);
}

function primarySegmentForCompany(companyId: string): { id: string; label: string } | null {
  const row = db.query(`
    SELECT ts.id AS id, ts.label AS label
    FROM company_segments cs
    JOIN target_segments ts ON ts.id = cs.segment_id
    WHERE cs.company_id = ?1
    ORDER BY ts.priority ASC, cs.confidence DESC, ts.label ASC
    LIMIT 1
  `).get(companyId) as Record<string, unknown> | null;
  return row ? { id: String(row.id), label: String(row.label) } : null;
}

function hasPendingEnrichment(companyId: string): boolean {
  const row = db.query(`
    SELECT 1 FROM work_queue
    WHERE kind = 'company_enrichment' AND target_type = 'company' AND target_id = ?1
      AND status IN ('queued', 'running')
    LIMIT 1
  `).get(companyId);
  return Boolean(row);
}

function enqueueAlertEnrichment(companyId: string, company: Record<string, unknown>, reason: string, now: number): void {
  if (hasPendingEnrichment(companyId)) return;
  const segment = primarySegmentForCompany(companyId);
  db.query(`
    INSERT INTO work_queue(
      id, kind, target_type, target_id, segment_id, segment, priority, status, reason, attempts,
      next_run_after_at, locked_by_run_id, error, context_json, created_at, updated_at
    )
    VALUES (?1, 'company_enrichment', 'company', ?2, ?3, ?4, ?5, 'queued', ?6, 0, NULL, NULL, '', ?7, ?8, ?8)
  `).run(
    crypto.randomUUID(),
    companyId,
    segment?.id ?? null,
    segment?.label ?? String(company.industry ?? ""),
    ALERT_ENRICHMENT_PRIORITY,
    reason,
    JSON.stringify({ requestKind: "alert", source: "alert_ingestion", companyName: String(company.name ?? "") }),
    now,
  );
  db.query(`
    UPDATE companies SET enrichment_status = 'queued', updated_at = ?1
    WHERE id = ?2 AND enrichment_status IN ('not_started', 'failed')
  `).run(now, companyId);
}

// ---------------------------------------------------------------------------
// Poll: fetch the most-overdue active feed and record new hits.
// ---------------------------------------------------------------------------

export async function pollAlertFeeds(now = Date.now()): Promise<Record<string, unknown> | null> {
  const feeds = selectDueAlertFeeds(now, 1);
  if (!feeds.length) return null;
  const feed = feeds[0]!;
  const cadence = Math.max(60 * 1000, Number(getSchedulerSettings().cooldowns.alertsMs ?? DEFAULT_ALERTS_CADENCE_MS));
  const nextRunAfterAt = now + cadence;

  const result = await fetchFeed(feed.feedUrl, feed.etag);
  if (!result.ok) {
    recordAlertFeedPoll(feed.id, { nextRunAfterAt, stalledReason: result.error ?? "fetch failed", now });
    return { action: "alerts_poll", feedId: feed.id, error: result.error ?? "fetch failed" };
  }
  if (result.notModified) {
    recordAlertFeedPoll(feed.id, { nextRunAfterAt, stalledReason: null, now });
    return { action: "alerts_poll", feedId: feed.id, notModified: true };
  }

  let inserted = 0;
  let latest = feed.lastEntrySeenAt;
  for (const entry of result.entries) {
    if (insertAlertHit({
      feedId: feed.id,
      guid: entry.guid,
      title: entry.title,
      link: entry.link,
      snippet: entry.snippet,
      publishedAt: entry.publishedAt,
      now,
    })) inserted++;
    if (entry.publishedAt != null && (latest == null || entry.publishedAt > latest)) latest = entry.publishedAt;
  }
  recordAlertFeedPoll(feed.id, { nextRunAfterAt, etag: result.etag, lastEntrySeenAt: latest, stalledReason: null, now });
  return { action: "alerts_poll", feedId: feed.id, seen: result.entries.length, inserted };
}

// ---------------------------------------------------------------------------
// Process: resolve queued hits and hand off to enrichment/scoring/deck.
// ---------------------------------------------------------------------------

function processOneHit(hit: AlertHit, now: number): Record<string, unknown> {
  updateAlertHit(hit.id, { status: "resolving", incrementAttempts: true, now });
  const feed = db.query("SELECT * FROM alert_feeds WHERE id = ?1").get(hit.feedId) as Record<string, unknown> | null;
  const queryNote = String(feed?.query_note ?? feed?.label ?? "");
  const signalType = String(feed?.signal_type ?? "hiring_intent");
  const strength = String(feed?.default_strength ?? "high");
  const segmentId = feed?.segment_id ? String(feed.segment_id) : null;

  const employer = extractEmployer(hit.title, hit.snippet);
  if (!employer) {
    updateAlertHit(hit.id, { status: "discarded", discardReason: "no employer named", now });
    return { hitId: hit.id, outcome: "discarded", reason: "no employer named" };
  }

  let company = findCompanyByName(employer.companyName);
  let created = false;
  if (!company) {
    const companyId = crypto.randomUUID();
    db.query(`
      INSERT INTO companies(
        id, name, location, industry, website, data_ring, duplicate_status, enrichment_status,
        confidence, profile_json, created_at, updated_at
      )
      VALUES (?1, ?2, '', '', '', 'found', 'unknown', 'not_started', 0, ?3, ?4, ?4)
    `).run(
      companyId,
      employer.companyName,
      JSON.stringify({ notes: `Discovered via hiring alert: ${queryNote}` }),
      now,
    );
    if (segmentId) {
      db.query(`
        INSERT OR IGNORE INTO company_segments(company_id, segment_id, confidence, source, created_at)
        VALUES (?1, ?2, 0.5, 'alert', ?3)
      `).run(companyId, segmentId, now);
    }
    recordActivity(companyId, "company_created", `Discovered via hiring alert: ${employer.jobTitle || queryNote}`, {
      feedId: hit.feedId,
      alertHitId: hit.id,
      jobTitle: employer.jobTitle,
    }, now);
    company = db.query("SELECT * FROM companies WHERE id = ?1").get(companyId) as Record<string, unknown>;
    created = true;
  }

  const companyId = String(company!.id);

  // Attach the ad as a source and the hiring trigger as a signal.
  const sourceId = crypto.randomUUID();
  db.query(`
    INSERT INTO sources(
      id, company_id, source_type, url, title, summary, extracted_data_json, confidence,
      last_checked_at, last_checked_by_run_id, terms_notes, created_at
    )
    VALUES (?1, ?2, 'job_ad', ?3, ?4, ?5, ?6, 0.6, ?7, NULL, '', ?7)
  `).run(
    sourceId,
    companyId,
    hit.link,
    hit.title,
    hit.snippet || hit.title,
    JSON.stringify({ jobTitle: employer.jobTitle, matchedQuery: queryNote }),
    now,
  );

  const signalId = crypto.randomUUID();
  const summary = `Hiring: ${employer.jobTitle || "role"}${queryNote ? ` — ad language matches "${queryNote}"` : ""}`;
  db.query(`
    INSERT INTO signals(
      id, company_id, signal_type, summary, source_id, source_url, observed_date, strength,
      confidence, adapt_relevance, evidence_json, created_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0.6, ?9, ?10, ?11)
  `).run(
    signalId,
    companyId,
    signalType,
    summary,
    sourceId,
    hit.link,
    hit.publishedAt != null ? new Date(hit.publishedAt).toISOString().slice(0, 10) : null,
    strength,
    `Hiring signal indicates active investment in the exact operational pain Adapt addresses (${employer.jobTitle || "leadership/ops hire"}).`,
    JSON.stringify({
      feedLabel: String(feed?.label ?? ""),
      matchedQuery: queryNote,
      jobTitle: employer.jobTitle,
      rawTitle: hit.title,
      rawSnippet: hit.snippet,
      alertHitId: hit.id,
    }),
    now,
  );
  updateAlertHit(hit.id, { companyId, signalId, now });

  // Branch on ICP state (see docs/RssAlertIngestion.md decision tree).
  const dataRing = String(company!.data_ring ?? "found");
  const rejected = Boolean(
    db.query("SELECT 1 FROM outreach_results WHERE company_id = ?1 AND state = 'rejected' LIMIT 1").get(companyId),
  );
  const scoreRow = db.query(
    "SELECT MAX(score) AS max_score, COUNT(*) AS n FROM service_fit_assessments WHERE company_id = ?1",
  ).get(companyId) as Record<string, unknown> | null;
  const maxScore = scoreRow?.max_score != null ? Number(scoreRow.max_score) : null;
  const assessmentCount = Number(scoreRow?.n ?? 0);

  if (dataRing === "processed" || dataRing === "parked" || rejected) {
    recordActivity(companyId, "alert_reengagement", `Fresh hiring signal on a ${rejected ? "rejected" : dataRing} company — review for re-engagement.`, {
      alertHitId: hit.id,
      signalId,
    }, now);
    updateAlertHit(hit.id, { status: "matched", context: { branch: "reengagement", created }, now });
    return { hitId: hit.id, outcome: "reengagement", companyId, created };
  }

  if (maxScore != null && maxScore >= ICP_HIGH_BAND_MIN_SCORE) {
    // Already qualifies for the deck — the signal simply reinforces "why now".
    recordActivity(companyId, "alert_promoted", "Hiring signal on an already-qualified (band=high) company; reinforced on deck.", {
      alertHitId: hit.id,
      signalId,
      maxScore,
    }, now);
    updateAlertHit(hit.id, { status: "promoted", context: { branch: "fast_path_high", maxScore }, now });
    return { hitId: hit.id, outcome: "promoted", companyId, maxScore };
  }

  if (assessmentCount > 0) {
    // Scored low/medium: the signal is new evidence. Clear current-version
    // assessments and reset to 'enhanced' so the scoring loop re-scores it.
    const versionId = activeMarketProfileVersionId();
    if (versionId) {
      db.query("DELETE FROM service_fit_assessments WHERE company_id = ?1 AND market_profile_version_id = ?2")
        .run(companyId, versionId);
    } else {
      db.query("DELETE FROM service_fit_assessments WHERE company_id = ?1").run(companyId);
    }
    db.query("UPDATE companies SET data_ring = 'enhanced', updated_at = ?1 WHERE id = ?2").run(now, companyId);
    recordActivity(companyId, "alert_rescore", "Hiring signal on a low/medium company; cleared assessments for re-scoring.", {
      alertHitId: hit.id,
      signalId,
    }, now);
    updateAlertHit(hit.id, { status: "matched", context: { branch: "rescore" }, now });
    return { hitId: hit.id, outcome: "rescore", companyId };
  }

  // New or not-yet-scored: ensure it gets enriched (fast-tracked) then scored.
  const enrichmentStatus = String(company!.enrichment_status ?? "not_started");
  if (created || dataRing === "found" || enrichmentStatus === "not_started" || enrichmentStatus === "failed") {
    enqueueAlertEnrichment(companyId, company!, `Hiring alert: enrich ${employer.companyName}`, now);
    updateAlertHit(hit.id, { status: "matched", context: { branch: "enrich", created }, now });
    return { hitId: hit.id, outcome: "queued_enrichment", companyId, created };
  }

  // Already enhanced but unscored — the scoring loop will pick it up naturally.
  updateAlertHit(hit.id, { status: "matched", context: { branch: "awaiting_score" }, now });
  return { hitId: hit.id, outcome: "awaiting_score", companyId };
}

export async function processAlertHits(now = Date.now(), limit = 5): Promise<Record<string, unknown> | null> {
  const hits = listQueuedAlertHits(limit);
  if (!hits.length) return null;
  const results: Record<string, unknown>[] = [];
  for (const hit of hits) {
    try {
      results.push(processOneHit(hit, now));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateAlertHit(hit.id, { status: "failed", error: message, now });
      results.push({ hitId: hit.id, outcome: "failed", error: message });
    }
  }
  return { action: "alerts_process", processed: results.length, results };
}

// Poll one due feed, then process a batch of queued hits. Called from the
// automated prospecting loop.
export async function runAutomatedAlertLoop(now = Date.now()): Promise<Record<string, unknown> | null> {
  const settings = getSchedulerSettings();
  if (!settings.enabled || !settings.alertsEnabled) return null;
  const poll = await pollAlertFeeds(now);
  const process = await processAlertHits(now, 5);
  if (!poll && !process) return null;
  return { action: "alerts", poll, process };
}
