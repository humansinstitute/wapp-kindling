# Kindling FE integration-agent prompt and checklist

## Prompt

```text
Review and integrate feat/collaborative-kindling-frontend into Kindling FE main.
Preserve both divergent histories: do not reset, rebase, force-push, or choose
one whole side of conflicts. Verify browser-mediated NIP-98 canonical reads,
explicit stale/current cache UI and health, runtime KINDLING_API_URL, Docker
secret/state exclusions, and the collaboration docs. Run bun run validate and
bun test; classify the documented inherited failures. Merge into main only
after review. Do not deploy. When production is approved separately, deployed
must fast-forward from main only.
```

## Checklist

- Confirm the feature branch descends from `adp`/`df4dae3`; inspect
  `git merge-base`, left/right commit counts, and both logs.
- Confirm concurrent `AGENTS.md` Conventional Commit instructions and the
  original handoff document are preserved.
- Search tracked files, Docker context, and generated browser assets for raw
  signing-key reads, nsec-like secrets, private-key blocks, `.env`, and SQLite.
- Review the relay allowlist: only bootstrap, snapshot pages, change pages, and
  target detail GETs may reach the runtime canonical API base.
- Confirm each forwarded NIP-98 event is signed by the current FE session actor
  and bound to the exact URL/method with a short expiry.
- Confirm bootstrap cursor finalization and per-change-page cursor advancement.
- Confirm stale/offline/denied cache remains readable but is never called live.
- Confirm `/api/health` separates process readiness, data readiness, and
  `liveCurrent` without returning an authorization event or credential.
- Run `bun run validate`; run `bun test` and compare any failures with the
  documented 81/3 inherited baseline.
- Build the Docker image and smoke it on an isolated non-WApp port; do not
  start/restart the managed app card.
- Merge deliberately into `main` after review. Do not push or deploy unless Rick
  separately authorizes it.
- For a later deployment, require `deployed` to fast-forward from `main`, use
  one CapRover instance with persistent `/data`, and verify the public health
  and browser-authorized sync.
