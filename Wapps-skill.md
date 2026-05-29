---
name: wapps
description: Use when building, integrating, or operating Wingman WApps that talk to Autopilot through NIP-98 APIs, trigger pipelines, expose local app APIs, and return results by webhook.
---

# WApps + Autopilot Skill

Use this skill when an agent needs to build or work with a Wingman WApp: a local business-specific web app that owns its UI and app data while using Wingman Autopilot for AI pipelines, agent sessions, tasks, and code execution.

## Architecture

A WApp is the business app boundary:

- local UI and routes;
- local SQLite or app-specific database;
- local business logic;
- local Nostr login and access control;
- NIP-98 APIs for agents to read or edit app data;
- webhook endpoint for Autopilot pipeline results.

Autopilot is the AI worker boundary:

- pipeline definitions and runs;
- agent sessions;
- code steps;
- task creation and updates;
- follow-on pipeline calls;
- NIP-98 APIs for WApps to trigger and inspect work.

Do not give Autopilot direct DB access to the WApp. If an agent needs app context, call the WApp NIP-98 API. If a WApp needs AI work, call Autopilot NIP-98 APIs.

## Standard Request Flow

1. User acts in the WApp.
2. WApp stores local state immediately.
3. WApp creates a local AI request or pending message record.
4. WApp sends a NIP-98 signed `POST` to Autopilot:

```txt
POST /api/pipelines/triggers/http/:pipelineSlug
```

5. Autopilot responds quickly with HTTP `202` or `200` and a pipeline run reference.
6. Pipeline performs extraction, retrieval, agent work, code steps, task creation, or child pipeline calls.
7. Pipeline posts the final result to the WApp webhook.
8. WApp verifies the callback and updates local state.

The Autopilot trigger route should return quickly. Long-running work belongs in the pipeline, not in the HTTP request handler.

## Trigger Payload Convention

Use this shape unless the WApp has a reason to extend it:

```json
{
  "input": {
    "source": "business-wapp",
    "wappId": "wapp_123",
    "appId": "app_123",
    "requestId": "req_123",
    "userNpub": "npub1...",
    "message": "latest user input",
    "history": [],
    "localContext": {
      "records": [],
      "references": []
    },
    "webhook": {
      "url": "https://wapp.example/api/pipeline-webhook",
      "authHeader": "x-wapp-callback-token",
      "token": "run-scoped secret"
    }
  }
}
```

Embed compact context directly. Use references for large or sensitive data. References must be readable through WApp or Tower NIP-98 APIs.

## Webhook Convention

The pipeline should send one final user-facing result back to the WApp:

```txt
POST <webhook.url>
<webhook.authHeader>: <webhook.token>
content-type: application/json
```

```json
{
  "requestId": "req_123",
  "chatId": "chat_123",
  "runId": "pipeline-run-id",
  "status": "ok",
  "response": "final response for the user",
  "metadata": {
    "source": "pipeline-slug",
    "graphUsed": true
  }
}
```

The WApp must verify the callback token and, for production WApps, should also accept NIP-98 signed callbacks from allowed Autopilot or bot npubs.

## WApp NIP-98 API Convention

Expose predictable agent routes:

```txt
GET    /api/nip98/me
GET    /api/nip98/chats
GET    /api/nip98/chats/:chatId/messages
POST   /api/nip98/chats/:chatId/messages
PATCH  /api/nip98/chats/:chatId
```

Use WApp-specific routes for business data:

```txt
GET    /api/nip98/context/:requestId
POST   /api/nip98/edits/:requestId
GET    /api/nip98/records/:recordId
PATCH  /api/nip98/records/:recordId
```

NIP-98 verification must check:

- event kind `27235`;
- signature;
- URL tag matches the exact request URL;
- method tag matches the HTTP method;
- timestamp is recent;
- payload hash tag matches the request body for `POST`, `PUT`, and `PATCH`.

## Access Model

Keep roles simple:

- `read`: can log in and read WApp data/API context.
- `edit`: can read and mutate WApp data/settings/API context.

The configured WApp owner npub has read and edit access. Do not create a role that can log in but cannot read anything.

## Pipeline Design Pattern

WApp-triggered pipelines should usually follow this sequence:

1. Validate and normalize WApp input.
2. Extract intent and entities.
3. Read extra WApp context over NIP-98 only if needed.
4. Query Tower graph memory if useful.
5. Consolidate current input, history, WApp context, and graph context.
6. Run the answer/action agent.
7. Optionally call WApp edit APIs with explicit edit access.
8. Send the final webhook response.

Return one final response to the WApp. Intermediate agent thinking should not be treated as the final answer.

## Agent Behavior

When you are the Autopilot agent in a WApp pipeline:

- treat the WApp as the source of truth for its local app records;
- use WApp NIP-98 APIs rather than filesystem or DB shortcuts;
- only call edit APIs when the pipeline or prompt explicitly grants edit intent;
- keep webhook responses user-facing and concise;
- never reveal callback tokens, private keys, or internal API auth values;
- include enough metadata for the WApp to associate the response with the local request.

## Future SSE Convention

Future WApps may subscribe to Autopilot Server-Sent Events for live run updates.

Expected direction:

```txt
GET /api/pipelines/runs/:runId/events
Authorization: Nostr <nip98-event>
```

Events should be scoped to the run and safe for the WApp UI:

- `run.started`
- `step.started`
- `agent.status`
- `agent.thinking.summary`
- `step.completed`
- `run.completed`
- `run.failed`

Use SSE for progress, status, and optional thinking summaries. Keep webhook delivery as the authoritative completion path.
