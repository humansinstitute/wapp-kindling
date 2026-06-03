# Bootstrap

This folder contains the repo-local bootstrap assets for installing Kindling on another Wingman server.

- `LLM_INSTRUCTIONS.md` is the handoff file for the target local agent.
- `pipelines/definitions/` contains Kindling Autopilot pipeline definitions.
- `pipelines/functions/` contains Kindling Autopilot pipeline functions.

The SQLite database is intentionally not stored here. Export it separately with:

```bash
bun scripts/export-migration.ts
```
