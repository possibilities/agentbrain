## Description

**Size:** M
**Files:** src/sources.ts, src/store.ts, src/types.ts, src/cli.ts, src/help.ts, test/sources.test.ts, test/sources-cli.test.ts

### Approach

Implement versioned declarative source definitions, optional private overlay, durable source state, source runs, checkpoints versus in-progress cursors, schedule intent, pause/health, limits, sensitivity, and collection policy. Source sync commands admit jobs; they never discover remote content inline or write documents directly.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `docs/adr/0003-agentbrain-owns-durable-ingestion.md:1` — source/run/collection distinctions.
- `docs/adr/0009-durable-source-fanout-and-checkpoints.md:1` — checkpoint and partial semantics.
- `src/store.ts:148-315` — sole-writer API conventions after foundation epic.
- `src/cli.ts:41-47` — current mutation command registration baseline.

**Optional** (reference as needed):
- `~/docs/agentbrain-source-recovery-2026-07-15.jsonl:1` — recovered source evidence, read-only.

### Risks

Mutable handles or homepages cannot be primary IDs, schedule duplicates can create overlapping runs, and config changes can invalidate cursors without an audit trail.

### Test notes

Cover version validation, duplicate stable IDs, overlays, cadence, sleep catch-up, pause/resume, checkpoint/cursor separation, source disablement, and unknown future kinds.

### Detailed phases

1. Define source manifest and source/run/checkpoint store APIs.
2. Add schedule admission, idempotency, health, and pause semantics.
3. Add list/show/status/sync/pause/resume CLI envelopes.

### Alternatives

Storing source state in ad hoc files or tags is rejected because it cannot commit with durable fanout or support many-to-many provenance.

### Non-functional targets

Source evaluation is local, bounded, deterministic across restarts, and stores credential references only.

### Rollout

Support definitions and dry-run with every source disabled before worker dispatch is enabled.

## Acceptance

- [ ] Source manifests have stable IDs, versions, kind-specific validated payloads, schedules, collection/sensitivity policy, and credential references only.
- [ ] Runs distinguish attempted cursor, committed checkpoint, warnings, discovered/admitted/suppressed counts, and terminal outcome.
- [ ] Overdue schedule evaluation creates at most one idempotent catch-up run per source.
- [ ] Pause/resume and config changes append audit evidence without deleting prior checkpoints or runs.
- [ ] Unknown source kinds remain inspectable but cannot execute destructively.

## Done summary

## Evidence
