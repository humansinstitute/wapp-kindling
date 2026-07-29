# RSS Alert Ingestion → Enrich → Score → Deck

## Purpose

Turn hiring-intent signals published on the public web (Google Alerts / SEEK job
ads) into Athena leads. When an ad uses language that matches Adapt's ICP pain
("right hand to the owner", "newly created GM role", "bring structure to a
growing business"), that is a high-value, time-sensitive *buying trigger*: a
company has just decided to spend money on the exact problem Adapt solves.

This feature ingests those triggers via **Google Alerts RSS feeds** (no email
inbox required — see "Why RSS"), resolves the hiring employer, attaches a
`hiring_intent` signal, and pushes the company through Athena's existing
enrichment → scoring → deck pipeline. Companies that clear the ICP bar
(`band = high`, score ≥ 75) land on the call list automatically.

## Why RSS (not an email inbox)

Google Alerts has exactly two delivery mechanisms: **email** and **RSS feed**.
RSS is chosen because:

- **No inbox to run.** A feed is just a URL — no Google Workspace alias, IMAP
  credentials, app passwords, or spam filtering to maintain.
- **Same timeliness** as email delivery.
- **Source-agnostic downstream.** Everything after the fetch step is identical
  regardless of source, so a paid search API (SerpAPI/Bing running the exact
  `site:seek.com.au "…" "…"` Boolean strings) can be swapped in later by
  changing only the fetch step — nothing else is wasted.

Known limitation, recorded honestly: Google **Alerts** is a weaker engine than a
raw Google `site:` search. It fires on *newly indexed* content only and handles
complex Boolean / multi-phrase / `site:` operators poorly, so recall is
lower than running the query strings directly. RSS is the zero-infra way to
prove the end-to-end loop; upgrade the source if volume/quality justify it.

## End-to-end flow

```
Google Alert (RSS)  ─┐
Google Alert (RSS)  ─┤   [1] poll        [2] resolve         [3] enrich     [4] score       [5] promote
Google Alert (RSS)  ─┼──► every N min ─► employer +    ─► existing   ─► existing   ─► band=high →
SEEK-scoped alert   ─┘   fetch+dedup     find-or-create    enrich         scoring         deck (target list)
                                          company +         pipeline       pipeline        auto-picked
                                          hiring_intent
                                          signal
```

Each RSS entry becomes an `alert_hits` row. A processing loop resolves the
employer, finds-or-creates the company, writes the signal, and hands off to the
*existing* enrichment/scoring/deck machinery. The deck itself is unchanged — we
just feed it a new company plus a strong signal.

## Data model (2 new tables)

Follows existing conventions: TEXT UUID PK, `_json` blobs, integer-ms
timestamps, `next_run_after_at` scheduling identical to `coverage_slices`.

### `alert_feeds` — the alerts we monitor

| column | purpose |
|---|---|
| `id` | UUID PK |
| `label` | human label, e.g. "SEEK: right hand to owner" |
| `feed_url` | Google Alerts RSS URL |
| `query_note` | human-readable query behind the alert |
| `signal_type` | signal type to write (default `hiring_intent`) |
| `default_strength` | signal strength (default `high`) |
| `segment_id` | optional cohort tag for hits (FK `target_segments`) |
| `status` | `active` \| `paused` \| `stalled` |
| `last_run_at`, `next_run_after_at` | polling cadence/backoff |
| `stalled_reason` | last fetch error |
| `etag`, `last_entry_seen_at` | HTTP caching + high-water mark |

### `alert_hits` — one row per RSS entry (dedup + audit + state)

| column | purpose |
|---|---|
| `id` | UUID PK |
| `feed_id` | FK `alert_feeds` |
| `guid` | RSS `<id>`/link — the dedup key |
| `title`, `link`, `snippet`, `published_at` | entry contents |
| `status` | `queued`→`resolving`→`matched`→`enriched`/`scored`/`promoted`, or `discarded`/`failed` |
| `company_id` | resolved company (FK, SET NULL) |
| `signal_id` | signal we wrote |
| `discard_reason` | "no employer named", "below ICP", … |
| `attempts`, `error`, `context_json` | processing bookkeeping |

`UNIQUE(feed_id, guid)` is the entire dedup story: `INSERT OR IGNORE` on every
poll silently drops entries already captured.

## Scheduling

Reuses the existing `runAutomatedProspectingLoop()` (`setInterval`, 60s). A new
`runAutomatedAlertLoop()` runs alongside acquisition/enrichment/scoring/outreach:

1. **Poll** the most-overdue `active` feed (`next_run_after_at <= now`), fetch
   via `etag`, `INSERT OR IGNORE` new hits, set `next_run_after_at = now + cadence`.
2. **Process** a small batch of `queued` hits (see below).

Gated by `scheduler_settings.enabled && scheduler_settings.alerts_enabled`.
Cadence lives in `scheduler_settings.cooldowns_json.alertsMs` — controlled from
the Settings → Automation card like every other role.

## Processing a hit (resolve → branch → hand off)

**Resolve employer.** Extract the hiring employer + job title from the entry.
v1 uses heuristic parsing of the ad title/snippet (SEEK titles are typically
`"<Job Title> - <Employer> - <Suburb> WA - SEEK"` or `"<Job Title> at <Employer>"`).
This is the deliberate swap point for an LLM resolver later (an agent step that
reads title+snippet+link and returns `{companyName, website, jobTitle, whyNow}`,
returning `null` when only a recruitment agency is identifiable). If no plausible
employer is found → `status = discarded`, `discard_reason = "no employer named"`.
Recruiter-posted ads are the expected main source of discards.

**Find-or-create company.** Match an existing company by name (case-insensitive,
excluding terminal `processed`/`parked` where a fresh live company is preferred).
Miss → `INSERT` a new company at `data_ring = 'found'`, tagged with the feed's
`segment_id` if set. Either way, write:

- a `sources` row (`source_type = 'job_ad'`) with the ad URL, and
- a `signals` row:
  - `signal_type = 'hiring_intent'`
  - `summary = 'Hiring: <jobTitle> — ad language matches "<query_note>"'`
  - `source_url = <ad link>`, `observed_date = <published>`
  - `strength = feed.default_strength` (`high`), `confidence` from resolver
  - `adapt_relevance = whyNow`, `evidence_json = { feedLabel, matchedQuery, jobTitle, rawSnippet }`

**Branch by ICP state** (this encodes the reviewed decisions):

```
resolve employer
   │
   ├─ Company EXISTS, already scored HIGH (band=high / score≥75)
   │     → FAST PATH: attach signal, record activity, status='promoted'.
   │       Deck already auto-picks scored-high companies; no re-enrichment.
   │
   ├─ Company EXISTS, scored LOW/medium (stale assessment)
   │     → attach signal; the signal is NEW evidence, so clear the current
   │       assessments for the active profile version + reset data_ring to
   │       'enhanced'; the scoring loop re-scores; promote only if now band=high.
   │
   ├─ Company EXISTS but terminal (processed/rejected)
   │     → attach signal, record 're-engagement' activity, status='matched'.
   │       Not auto-un-rejected — surfaced for human judgement.
   │
   └─ Company NEW or not-yet-enriched (found / not_started / failed)
         → attach signal, enqueue HIGH-PRIORITY enrichment (work_queue
           priority 5). enrich_company fills website/people → 'enhanced' →
           scoring loop scores → deck if band=high; else stays in funnel.
           (Companies with no website after enrichment are auto-parked by the
           existing "no website" rule — a natural filter for bad employer names.)
```

**Fast-tracking new companies.** Alert-origin enrichment is enqueued at
`work_queue.priority = 5` (vs the default `100` / batch `50`), so a hot hiring
signal is pulled ahead of the routine industry backlog instead of waiting a day.

## Promotion to the deck

"Fits ICP" already has a definition in the codebase: a `service_fit_assessments`
row with `band = 'high'` (score ≥ 75) (`server.ts` band logic). The deck is the
`target_list_items` of the latest `target_list_runs`, and promotion to
`outreach_ready` is already driven by the scoring→outreach scheduler. So once an
alert company is scored high, **promotion is automatic** — this feature adds no
new deck logic, it only feeds the funnel and gates on the existing ICP bar. The
`why_now` on the resulting call-list card carries the hiring trigger straight to
the caller.

## Scorer nudge (one-line change)

The `hiring_intent` signal is already visible to the scorer via
`localContext.signals`. `kindling-score-company-service-fit` gets one extra rule
line instructing it to treat recent `hiring_intent` signals as strong,
time-sensitive buying triggers and cite them in `fitExplanation`. This is the
only change to an existing pipeline.

## Control surface & observability

- **Feeds CRUD:** `/api/kindling/alert-feeds` (GET/POST/PATCH/DELETE) — register,
  label, pause/activate feeds. Paste a Google Alerts RSS URL here.
- **Automation card:** `alerts_enabled` toggle + `alertsMs` cadence in
  `scheduler_settings` (same pattern as other roles).
- **Hit log:** `/api/kindling/alert-hits` — full audit trail: every entry,
  whether an employer resolved, whether it cleared ICP, and why anything was
  discarded. The discard rate is the real measure of how much signal Google
  Alerts is giving us.

## Failure modes

| Risk | Handling |
|---|---|
| Recruiter-posted ads, no real employer | resolver returns null → `discarded`, logged |
| Google redirect URLs / HTML in titles | parser unwraps `google.com/url?url=` and strips tags/entities |
| Same entry seen repeatedly | `UNIQUE(feed_id, guid)` + `INSERT OR IGNORE` |
| Same company, multiple ads | company match dedups; multiple signals over time = stronger trend, kept |
| Alert on an already-contacted/rejected company | signal attached + re-engagement activity; surfaced, not auto-revived |
| Bad employer name creates junk company | enrichment finds no website → existing auto-park rule filters it |
| Low Google Alerts recall on Boolean queries | source-quality issue; swap fetch step for a search API later |

## Build footprint

- **New:** `alert_feeds` + `alert_hits` tables/migrations/indexes; `src/rss.ts`
  (fetch/parse); `src/alerts.ts` (poll + process); `runAutomatedAlertLoop()`
  wiring; feeds + hits API; Automation-card `alertsEnabled`/`alertsMs`.
- **Reused unchanged:** `enrich_company`, `score_company_service_fit`,
  target-list/deck, outreach flow, scheduler lock/cooldown/concurrency infra.
- **One-line touch:** scorer prompt weighting `hiring_intent`.

## Deferred / v2

- **LLM employer resolver.** Replace the heuristic `extractEmployer` with a
  `kindling-process-alert-hit` Autopilot agent step for far better recall on
  recruiter-posted and awkwardly-titled ads.
- **Search-API source.** Swap Google Alerts RSS for SerpAPI/Bing running the
  exact `site:seek.com.au` Boolean strings for higher recall.
- **WApp UI card** for feeds + hit log (API is built; UI can follow).
