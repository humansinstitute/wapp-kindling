# WApp Implementation Shape

## Purpose

Kindling is not just a chat wrapper around Autopilot. It needs its own screens, local data model, business rules, pipeline configuration, and review workflows. Autopilot pipelines are worker capabilities that the WApp calls for specific roles.

## Storage

The first implementation should use local SQLite owned by the WApp.

Tower/shared storage is not required for the first version. The WApp should expose NIP-98 APIs so Autopilot agents and pipelines can read and write app records without direct database access.

## Primary Navigation

The first screen should be an action hub titled around the question: "What will we do today?"

Initial actions:

- Build service offering.
- Build target list.
- Review today's targets.
- Act.

The four primary action buttons should have equal visual weight. The starting screen should not imply that one workflow is always more important than the others.

The action hub can also show small status summaries, such as active market profile, total companies, active scans, enrichment backlog, and outreach-ready targets.

## First Happy Path

The first complete demo should support:

1. Define or improve a service offering.
2. Build a target list for one industry and location.
3. Enrich a small number of companies from that list.
4. Draft one outreach email or pitch.

The goal is not to automate the whole business-development machine in the first pass. The goal is to prove the WApp can own structured business records while handing bounded AI work to Autopilot pipelines.

## Required Screen Families

Early screens should include:

- Action hub: the starting "what will we do today?" screen.
- Service offering workspace: split layout with the current profile, versions, documents, and change notes on one side, and the interview chat, pipeline interaction, and run status on the other.
- Target list builder: free-text industry/location research form, scan jobs, coverage view, and generated company list.
- Company list: filtering, duplicate status, data rings, source quality, and manual record actions.
- Company profile: polished profile, expandable evidence, activities, enrichment actions, people, signals, and outreach readiness.
- Admin-only pipeline settings: role-to-pipeline mappings and default pipeline selection.
- Outreach workspace: generated draft, evidence basis, service match, and review actions.
- Today's targets: priority-ordered list of the best current targets.

Manual CRUD should be available from day one for core records such as companies, sources, notes, profile fields, duplicate status, and activities. Pipeline-created records should not be the only editable records.

Manual company creation should require only a company name. Location, industry, website, source links, notes, and confidence fields should be optional because Kindling is designed to support sparse records that improve over time.

The first-class company list filters should be industry, location, data ring, duplicate status, has website, and enrichment status.

The outreach workspace should produce a pitch that can be copied and pasted into an email. It should not send email in the first version.

## Pipeline Role Configuration

The WApp should support configurable pipeline roles. Each role maps a business action to an Autopilot pipeline slug or definition.

Initial pipeline roles:

- Develop service offering.
- Scan target list.
- Resolve duplicates.
- Enrich company.
- Find people.
- Monitor and score.
- Draft outreach.

The app should let an admin/operator load available Autopilot pipelines, select the active pipeline for each role, and store those selections locally. Normal users should not need to choose pipelines during ordinary use. This follows the WApp starter pattern where a chat pipeline can be selected, but expands it into role-specific pipeline configuration.

Pipeline configuration records should store:

- Role key.
- Display name.
- Active pipeline slug or ID.
- Pipeline label.
- Required input fields.
- Expected output shape.
- Enabled/disabled state.
- Last verified timestamp.

The WApp should treat pipeline selection as configuration, not hard-coded application behavior.

Pipeline settings should be admin-only. During early development this admin screen can be visible to builders and operators, but it should not be part of the normal user workflow.

## Business Rule Boundary

Business rules that determine how Kindling behaves should live in the WApp when they affect records, screens, review state, or user workflow. Examples:

- Which records are editable.
- Which data rings exist.
- Which duplicate states exist.
- Which pipeline role is called from each action.
- Which fields are required before an enrichment or outreach action is available.
- How scan jobs, activities, and pipeline runs are displayed.

Autopilot should handle reasoning-heavy or long-running work, such as interpreting source documents, searching public data, extracting company details, proposing profile changes, and drafting outreach.

Normal users should see high-level pipeline status only, such as queued, running, completed, failed, and the resulting app records or summaries. Pipeline internals, agent notes, and logs should stay in Autopilot or admin/operator surfaces for now. The user interacts with the WApp, not with the running pipeline.

## API Boundary

Autopilot pipelines should interact with Kindling through WApp NIP-98 APIs.

Likely API groups:

- Pipeline context: read compact context for a run.
- Pipeline roles: list role configuration for debugging and verification.
- Documents: read uploaded reference documents.
- Market profiles: read current profile and create proposed versions.
- Discovery jobs: create and update scan jobs and slices.
- Companies: create, update, list, and mark duplicates.
- Sources: create and link source records.
- Activities: append user, WApp, tool, or agent activities.
- Enrichment: create enrichment requests and update results.
- Outreach: create draft artifacts and update review state.

The local SQLite database remains the source of truth for these records.

## Implementation Plan Shape

The implementation should be planned as a set of vertical slices rather than one large platform build:

1. Local data model and migrations for pipeline roles, market profiles, companies, sources, activities, discovery jobs, enrichment status, and outreach drafts.
2. Action hub and navigation shell.
3. Admin-only pipeline role settings.
4. Service offering workspace with split profile/chat layout and version records.
5. Target list builder with free-text industry/location scan request and company list filters.
6. Manual company CRUD and company profile screen.
7. WApp NIP-98 APIs for Autopilot to read context and write companies, sources, activities, profile versions, enrichment results, and outreach drafts.
8. Pipeline trigger/webhook integration for service offering, scan target list, enrichment, and outreach draft roles.
9. Today's targets priority list and copyable pitch workflow.

The first implementation plan should identify which of these slices are required for the first demo and which can be stubbed with local/manual data.
