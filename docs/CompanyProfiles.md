# Company Profiles

## Purpose

A company profile is the evolving source of truth for one SME. It should collect public evidence, extracted facts, people, monitoring points, activities, confidence, and service-fit reasoning.

Profiles start incomplete. The WApp should make it easy to see what is known, what is missing, what was attempted, and what should be improved next.

Company profiles are downstream of company discovery. The first scan can create sparse records at scale; profile enrichment should be a later stage that is kicked off manually or by a prioritisation pipeline for selected companies or segments.

Manual create, read, update, and delete workflows should exist from the first implementation for core company profile records. Users should be able to add a company, correct fields, attach notes, adjust duplicate status, edit polished profile text, and request enrichment without waiting for a pipeline to create every record.

Only the company name should be mandatory when creating a company manually. Location, industry, website, source links, and profile detail can be added later by the user or by enrichment pipelines.

## Profile States

Suggested states:

- Sparse: the WApp has a name or weak identifier only.
- Publicly findable: at least one usable source has been linked.
- Basic profile: the WApp has a description, industry, location, and source confidence.
- People found: at least one relevant public individual has been linked.
- Monitored: company or people monitoring points are active.
- Scored: the profile has been scored against the active market profile.
- Outreach candidate: the profile may be worth outreach preparation.
- Outreach-ready: there is enough evidence to create a targeted draft.
- Parked: the profile cannot currently be improved cost-effectively.

## Profile Fields

Core company fields:

- Name.
- Location.
- Industry.
- Website.
- Public profiles.
- Description.
- Size hints.
- Services/products offered.
- Customer types.
- Technology hints.
- Growth or hiring signals.
- Relevant public content.
- Contact paths.
- Confidence score.
- Data ring.
- Parked status and reason.

People fields:

- Name.
- Role.
- Relationship to company.
- Public profile URLs.
- Monitoring points.
- Evidence of AI interest or relevant business pain.
- Confidence that this person is a buyer, influencer, or useful contact.

Source fields:

- URL or source identifier.
- Source type.
- Retrieval timestamp.
- Extracted summary.
- Extracted structured data.
- Confidence.
- Terms or usage notes if relevant.

## Augmentation Flow

When reviewing a profile, the user should be able to click an area and request more information. For example:

- Find more about company size.
- Find staff or likely decision makers.
- Find AI-related activity.
- Find recent hiring signals.
- Find public writing by managers.
- Find the best contact path.
- Improve service match.
- Re-score against the active market profile.

This should create an activity and trigger an Autopilot enrichment pipeline. If the pipeline cannot find the requested information, that failed search should still be recorded and should lower confidence or mark the field as attempted.

People discovery should usually be a separate enrichment request rather than part of the first company discovery scan. The profile can move from company-level enrichment into people-level enrichment when a company appears promising enough to justify the extra work.

Suggested enrichment sequence:

1. Company facts: improve name, website, location, industry, description, source quality, and size hints.
2. People: find public staff, managers, founders, likely buyers, and useful contact paths.
3. Signals: look for public writing, LinkedIn activity, blogs, hiring, events, AI interest, or other trigger evidence.
4. Monitoring: decide which company and person sources should be revisited.
5. Service fit: compare the enriched profile against the active market profile.
6. Outreach readiness: prepare a polished summary, pitch angle, and draft only when confidence is high enough.

## Full vs Polished Profile

A full profile contains broad available evidence, even if some of it is messy or uncertain. It is useful for research and internal reasoning.

A polished profile is a cleaner presentation for action and should be shown first. Raw evidence, extracted fields, source records, and activity detail should be expandable underneath or beside the polished view.

The polished profile should include:

- Short company summary.
- Why this company matters.
- Likely buyer or contact.
- Strongest buying triggers.
- Best matching services.
- Evidence-backed pitch angle.
- Risks or missing data.
- Recommended next action.

The outreach pipeline should use the full profile for reasoning, but present a polished profile for human review.

## Confidence

Confidence should account for:

- Source quality.
- Recency.
- Agreement between sources.
- Whether public people are identifiable.
- Whether monitoring points exist.
- Whether the company matches the active market profile.
- Whether a current trigger exists.
- Whether missing fields have been attempted.

Confidence should not be a single opaque number only. The UI should show the main confidence drivers and gaps.

## UI Elements

The profile screen should include:

- Polished company summary and state.
- Data ring indicator.
- Key facts with expandable raw sources.
- People list.
- Monitoring points.
- Signals and triggers.
- Service match.
- Confidence drivers and gaps.
- Expandable activity timeline.
- Buttons or inline actions to request more information for a profile area.
- Outreach readiness panel.

## Open Questions

- Which profile fields are required before a company can be scored?
- Which fields are required before a company can become outreach-ready?
- Should user edits always override agent-extracted fields, or should both be visible with source attribution?
