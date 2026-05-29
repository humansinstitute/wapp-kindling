# Target Scanning

## Purpose

Target scanning builds the raw and partially enriched SME dataset. The goal is to create a large list quickly, preserve whatever evidence is found, and then improve records in a structured way over time.

The first version should not only save names. When a company is found, the WApp should store the name plus any discovered links, public data, inferred attributes, source records, and confidence notes available from the initial scan.

## First Screen Flow

From the initial "what do we want to do today?" screen, the user can choose Build target list.

The scan form should include:

- Location.
- Industry or niche.
- Optional company size hints.
- Optional targeting notes.
- Optional source preferences.
- Batch size or effort level.

The first version should start with a structured form rather than a free-form instruction box. The core fields are industry and location. The WApp should send these fields to the configured Autopilot scan pipeline, which can expand, clean, and decompose the search into smaller slices.

Location should be normalised. For the first owner deployment, the app should bias toward a standard list of Western Australian locations and allow the pipeline to clean user-entered locations into canonical records where possible. For example, "Perth", "Perth metro", "Fremantle", "Subiaco", and "Northbridge" should resolve to known geography nodes rather than being stored only as raw strings.

The WApp should show current dataset counts before and after a scan:

- Total companies.
- Companies by data ring.
- Companies by location.
- Companies by industry.
- Companies with public websites.
- Companies with identified people.
- Companies parked for insufficient data.

The primary progress view should be coverage, not a live transcript. The user should be able to answer questions such as:

- How many companies do we have in this industry?
- Which geographies have been covered?
- Which industry and location combinations have not been touched yet?
- How many companies were found in each geography, industry, and data ring?
- How many records have likely duplicates, weak sources, websites, or no usable public data?

Agent notes are useful as an expandable audit trail, but the default scan progress view should be the structured dataset view: counts, coverage, filters, and drill-downs.

Geography should be nested. A user should be able to start broad, such as Western Australia, then drill down into Perth, suburbs, regions, or named search slices. Industry should work similarly, so "professional services" can contain accountants, lawyers, engineers, consultants, and other narrower categories.

## Scan Behaviour

A scan should:

1. Create a discovery job in the WApp.
2. Trigger an Autopilot search planning or discovery pipeline.
3. Use tools/APIs where possible to search by location, industry, and targeting notes.
4. Save each discovered company record.
5. Save every useful discovered source, link, and extracted field.
6. Record which fields are missing.
7. Create activities describing what was attempted and what was found.
8. Mark records for follow-up enrichment when promising but incomplete.

The WApp should prefer breadth first, then depth. A first scan can produce many partial records, then later enrichment jobs improve the promising parts of the list.

The first practical scan mode can be agent-led: the user gives a plain instruction such as "find up to 1,000 air conditioning companies in the Perth metro area" or "find every accountant in Subiaco and Northbridge". Autopilot can then run one or more long-running agent sessions, search the public web, break the request into smaller geography or sub-industry slices, and write discovered records back into the WApp database through WApp APIs.

These scans may run for hours. The WApp should treat them as background discovery jobs with visible progress, partial results, and resumable state rather than as synchronous UI requests.

The discovery session should stay focused on company discovery. It should not try to deeply profile every company, identify every person, score fit, monitor signals, and draft outreach in the same pass. Those activities belong to later pipeline stages.

## Agent-Led Discovery

Agent-led discovery should support:

- A natural language search instruction.
- Structured constraints such as geography, industry, sub-industry, size, and maximum target count.
- Automatic decomposition into smaller search slices, such as suburbs, neighbouring locations, or subcategories.
- Multiple agent sessions or pipeline steps where useful.
- Continuous writes of found companies, sources, and activities into the WApp.
- Possible duplicate marking as records arrive.
- A clear final summary of what was searched, what was found, what failed, and what should be scanned next.

Example search slices:

- Air conditioning companies in Perth metro.
- Air conditioning companies in Fremantle.
- Air conditioning companies in Applecross.
- Accountants in Subiaco.
- Accountants in Northbridge.

Autopilot agents should not write directly to the WApp database. They should use WApp NIP-98 APIs to create or update companies, sources, possible duplicate groups, and activities. Later enrichment agents can use the same API boundary for people, monitoring points, scoring, and outreach records.

## Discovery Waterfall

Discovery should move through staged pipelines:

1. Company discovery: find companies and save basic records, candidate websites, directory links, source notes, and scan activities.
2. Duplicate resolution: review possible duplicate groups and merge or link records when there is enough evidence.
3. Company prioritisation: decide which discovered companies are worth deeper work based on coverage, segment, public source quality, and current market profile.
4. Company enrichment: improve selected company records with better descriptions, public sources, size hints, categories, technology hints, and contact paths.
5. People discovery: identify public people, likely decision makers, staff profiles, blogs, LinkedIn activity, and other person-level signals.
6. Monitoring setup: decide which company and person sources are worth checking again.
7. Scoring and outreach preparation: score fit, timing, confidence, and service match, then prepare drafts only for strong candidates.

The WApp should pass records down the waterfall explicitly. A scan can create a large list, but the user or a later pipeline should choose which slice moves into enrichment.

## Progress and Coverage UI

The scan area should show a coverage explorer rather than only a job log.

Useful filters and groupings:

- Industry and sub-industry.
- Geography hierarchy, such as country, state, region, city, suburb, and custom search slice.
- Data ring.
- Source quality.
- Has website.
- Has possible duplicate.
- Has people found.
- Parked reason.
- Last scan or enrichment activity.

The top-level scan job view should show:

- Scan instruction.
- Current status.
- Started and last-updated timestamps.
- Coverage slices searched.
- Companies found.
- Sources captured.
- Possible duplicate count.
- Parked or weak-source count.
- Next recommended search slices.
- Expandable agent/session notes.

The default view should help the user choose the next structured slice of work, such as "engineering companies in Perth", "accountants in Subiaco", or "air conditioning businesses in Fremantle".

## Duplicate Handling

The first version should mark likely duplicates for review rather than merging automatically during discovery. Discovery agents should preserve candidate records and attach duplicate evidence such as matching names, websites, addresses, phone numbers, ABNs, directory links, or source overlap.

Duplicate cleanup can be handled by a regular Autopilot pipeline, including overnight runs. That pipeline can review possible duplicate groups, decide whether records are truly the same company, merge confirmed duplicates through WApp NIP-98 APIs, and leave ambiguous groups for user review.

Duplicate states:

- Not checked.
- Possible duplicate.
- Confirmed duplicate.
- Merged.
- Not duplicate.
- Needs human review.

Duplicate resolution activities should record what evidence was compared and why the merge or non-merge decision was made.

## Discovery Outputs

Each discovered company should ideally store:

- Name.
- Location.
- Industry or inferred category.
- Website or candidate website.
- Directory or source links.
- Basic description.
- Size hints, if found.
- Public people found, if any.
- Contact paths, if any.
- Source confidence.
- Missing fields.
- Next recommended enrichment actions.

In the first company-discovery stage, public people and contact paths are optional. It is enough to save the company, likely source links, and available public evidence. People-finding should normally happen in a later enrichment stage after the company list exists and a slice has been prioritised.

## Activities

Activities are important because they explain how the profile changed.

Examples:

- Created from scan.
- Website candidate found.
- Public profile found.
- Person identified.
- Tried to find staff but found none.
- Tried to find website but found none.
- Agent enriched company summary.
- User manually edited field.
- Monitoring rule added.
- Company parked for insufficient data.

Activities should record:

- Actor: user, WApp, Autopilot pipeline, tool, or agent.
- Timestamp.
- Action type.
- Target record.
- Summary.
- Inputs or source references.
- Outcome.
- Confidence impact.

## Parking and Revisit

Parking does not mean deleting. If the system cannot find enough data, the record should remain in the database with a clear status and reason.

Common parking reasons:

- No website or source could be confidently linked.
- No staff or public people could be found.
- Only weak or duplicate directory data exists.
- The company appears irrelevant to the current market profile.
- Confidence is too low to justify deeper work today.

Parked records can be revisited when new tools, sources, or campaign priorities become available.

## Open Questions

- What is a sensible first batch size for an interactive scan?
- What geography and industry taxonomy should the first version ship with?
- When should a discovered slice be considered covered enough to move on?
