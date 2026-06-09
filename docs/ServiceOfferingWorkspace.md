# Service Offering Workspace

## Purpose

The service offering workspace is where a user develops the structured market profile that drives scoring, target selection, and outreach. It should feel like a working conversation with an Autopilot agent, not a static settings page.

The first useful build should let the user start with a rough business description and a set of reference documents, then progressively improve the profile through chat.

## Starting Inputs

The WApp should support creating a positioning workspace from:

- A written description of the organisation.
- A written description of service offerings.
- PDF documents uploaded or attached for the Autopilot agent to read.
- Existing service documents, proposals, workshop notes, sales notes, or case studies.
- Website copy or profile text pasted into the workspace.

Reference documents may live in the Autopilot pipeline environment. The WApp should store enough metadata to know which documents were used, when they were loaded, and which profile versions depended on them. The WApp should not assume direct database or filesystem access to Autopilot internals.

The first implementation should support both reference paths:

- Documents placed directly into the Autopilot environment for a pipeline to read.
- Documents uploaded through the WApp.

For WApp uploads, prefer an API-based access model even if the WApp and Autopilot are initially running on the same machine. The WApp can save the file locally, create a document record, and pass a document reference to Autopilot. Autopilot should retrieve the document through a WApp NIP-98-protected API rather than relying on a shared filesystem path. This keeps the design deployable later when the WApp is not running on the Wingman box.

## WApp and Autopilot Split

The WApp owns:

- The current market profile.
- Profile version history.
- Chat messages visible to the user.
- References to uploaded or attached source documents.
- NIP-98-protected document access APIs for Autopilot.
- Change summaries, rationale notes, and rollback/comparison UI.
- User-visible status of pipeline runs.

Autopilot owns:

- Reading and interpreting loaded reference documents.
- Fetching WApp-uploaded reference documents through the WApp API when needed.
- Asking the next useful interview question.
- Synthesising user answers and source documents.
- Producing a new structured profile version.
- Explaining what changed and why.

## Profile Versioning

Each meaningful positioning update should create a new profile version. The active version can move forward automatically after a pipeline response, but older versions must remain available.

Profile versions should store:

- Version number.
- Created timestamp.
- Triggering chat message or pipeline run.
- Structured profile content.
- Narrative summary of what changed.
- Rationale notes for important changes.
- Source document references used.
- Optional structured diff by section.

The first version can skip a rich diff if needed. The chat response should still tell the user what changed and why.

Scoring reads extracted `service_offerings` rows for the active profile version. The editable profile content still lives in `market_profile_versions.structured_json`; extraction provides stable IDs/keys for company x offering assessment rows so older scores remain interpretable after later profile versions are created.

## Baseline Profile Shape

The profile should include:

- Positioning statement.
- Service lines.
- Benefits and outcomes.
- USPs and proof points.
- Ideal client profile rules.
- Exclusion rules.
- Buying triggers.
- Monitoring priorities.
- Outreach voice.
- Offer-to-client matching rules.

For the initial owner deployment, known service lines are:

- AI consulting.
- Wingman implementations.
- Custom WApps.
- Training.

## UI Elements

The workspace should include:

- A split layout.
- Current profile panel on the profile side.
- Version history, source documents, and change notes on the profile side.
- Chat panel for the positioning interview on the interaction side.
- Pipeline run status and latest pipeline response on the interaction side.
- Version selector.
- Change summary attached to each pipeline response.
- Source/reference document list.
- Run status for the current pipeline.
- A way to view earlier versions.
- Later: a structured section diff for services, benefits, ICP, triggers, and outreach voice.

The positioning/interview pipeline should be selected through the WApp's pipeline role settings. This workspace should call the active "develop service offering" pipeline role rather than hard-coding one pipeline slug in the screen.

## Pipeline Contract Sketch

Input:

- Current market profile version.
- User chat message.
- Recent positioning chat history.
- Reference document handles, IDs, or API URLs.
- Deployment context, such as owner profile and WApp ID.

Output:

- Assistant chat response.
- New market profile version.
- Change summary.
- Rationale notes.
- Follow-up question.
- Source references used.
- Confidence or completeness notes.

## Open Questions

- How much profile editing should be possible manually outside the chat flow?
- What document formats should the first version support beyond PDF?
- Should source documents be attached per deployment, per profile, or per profile version?
