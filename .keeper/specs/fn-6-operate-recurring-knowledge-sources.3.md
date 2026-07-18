## Description

**Size:** M
**Files:** src/source-worker.ts, src/worker.ts, src/scrapectl.ts, src/sources.ts, src/store.ts, test/source-worker.test.ts, test/sources.test.ts

### Approach

Execute due blog and X source-run jobs through Scrapectl discovery envelopes, persist observations and warnings, durably admit resource jobs/suppressions, and advance checkpoints only with complete committed windows. Use feed validators/entry IDs for blogs and `since_id` plus bounded overlap for forward X polling; keep historical X traversal separate and disabled.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `/Users/mike/code/arthack/apps/scrapectl/scrapectl/handlers/x.py:1128-1254` — current since-ID, deduplication, warnings, and bounded scrolling.
- `/Users/mike/code/arthack/apps/scrapectl/scrapectl/schemas.py:261-275` — non-seekable `next_cursor` warning.
- `docs/adr/0009-durable-source-fanout-and-checkpoints.md:1` — locked commit boundary.
- `src/worker.ts:1` — durable worker dispatch seam after foundation epic.

**Optional** (reference as needed):
- `hermes-greybird@9ca07e5^:bin/research-twitter-watch:606-656` — historical advance-before-processing bug to avoid.

### Risks

Partial discovery can skip items if checkpoints advance, expired provider cursors can strand backfill, and overlapping source runs can duplicate fanout or abuse rate limits.

### Test notes

Fake Scrapectl feed/timeline envelopes for no-new-content, overlap, edits, duplicates, partial warnings, rate limit, auth block, restart, crash between fanout/checkpoint, and shared discoveries.

### Detailed phases

1. Add provider-specific source-run dispatch and observation normalization.
2. Transactionally admit/suppress discovered resources with safe checkpoint advancement.
3. Add overlap, recovery, health, and failure/pause behavior.

### Alternatives

Waiting for every extracted item before checkpoint commit is rejected; durable admission is the correct boundary. Timestamp-only X checkpoints are also rejected.

### Non-functional targets

Per-run discovery and fanout are bounded, idempotent, cancellation-aware, rate-limit respectful, and free of Agentbrain network implementation.

### Rollout

Exercise source runs with fake providers and disabled manifests before enabling any live source.

## Acceptance

- [ ] Complete blog/X windows advance checkpoints only after every discovery has a durable job, existing intent, or suppression.
- [ ] Partial warnings, auth/config failure, and uncertain boundaries preserve run evidence without unsafe advancement.
- [ ] No-new-content runs succeed and update health without manufacturing resource jobs.
- [ ] Bounded overlap catches edits/delayed items while idempotency prevents duplicate resource/index effects.
- [ ] X forward polling never presents the diagnostic oldest-item cursor as resumable historical pagination.

## Done summary

## Evidence
