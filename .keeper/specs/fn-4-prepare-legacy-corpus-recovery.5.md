## Description

**Size:** M
**Files:** scripts/rehearse-recovery-import.sh, test/recovery.integration.test.ts, README.md

### Approach

Run the real manifest and local artifacts through dry-run and temporary-database import, with fake/forbidden Scrapectl, then validate exact cohort outcomes, catalog ordering, artifacts, FTS, citations, duplicate replay, failure isolation, backup restore, and rollback. Emit bounded public metadata only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/docs/agentbrain-recovery-report-2026-07-15.md:7-58` — locked inventory and empty-live-DB evidence.
- `~/docs/agentbrain-recovery-manifest-2026-07-15.jsonl:1` — authoritative input.
- `test/cli.integration.test.ts:1` — temporary installed-CLI integration pattern.

**Optional** (reference as needed):
- `~/docs/agentbrain-historical-db-evidence-2026-07-15.json:1` — documentary historical counts, not import IDs.

### Risks

A rehearsal can accidentally point at live DB/artifacts or leak private recovery content into test output. Exact candidate count can be confused with resource count after alias convergence.

### Test notes

Require explicit temporary roots, block network executables, capture JSON reconciliation, restore the pre-run snapshot, rerun idempotently, and sample citations/search across resource kinds.

### Detailed phases

1. Prove dry-run exactness and no writes.
2. Import into temporary state and drain offline jobs.
3. Validate, replay, inject failures, restore, and compare reconciliation output.

### Alternatives

A live first run is rejected; the complete corpus is small enough for a realistic disposable rehearsal.

### Non-functional targets

Rehearsal performs zero network operations, emits no private bodies, and remains repeatable from documented commands.

### Rollout

Publish only counts, IDs, hashes, and sanitized failures needed for the following live operational task.

## Acceptance

- [ ] Disposable import accounts for all 1,075 candidates and all 584 ordered catalog memberships.
- [ ] Exactly 581 valid offline artifacts complete when fixtures match, while locked review/exclusion cohorts create no network work.
- [ ] Hash mismatch and parser failure block only affected jobs and remain resumable.
- [ ] FTS, collection filters, citations, provenance, and representative X/generic resources work after restore and idempotent replay.
- [ ] A verified pre-import snapshot restores the temporary database and artifact references exactly.

## Done summary

## Evidence
