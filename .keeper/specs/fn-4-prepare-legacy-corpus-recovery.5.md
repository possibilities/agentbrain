## Description

**Size:** M
**Files:** scripts/rehearse-recovery-import.sh, test/recovery.integration.test.ts, README.md

### Approach

Run the frozen 1,088-candidate generation and local artifacts through dry-run and temporary-database import, with fake/forbidden Scrapectl, then validate exact candidate/observation outcomes, catalog ordering, artifacts, FTS, citations, duplicate replay, failure isolation, backup restore, and rollback. Emit only bounded aggregate metadata and opaque safe IDs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/.local/share/agentbrain/recovery/manifests/current.json:1` — authoritative generation descriptor after Task 6.
- `~/.local/share/agentbrain/recovery/telegram/secretary-link-summary-2026-07-18.json:1` — locked body-free Telegram aggregates.
- `~/docs/agentbrain-recovery-report-2026-07-15.md:7-58` — baseline inventory and empty-live-DB evidence.
- `test/cli.integration.test.ts:1` — temporary installed-CLI integration pattern.

**Optional** (reference as needed):
- `~/docs/agentbrain-historical-db-evidence-2026-07-15.json:1` — documentary historical counts, not import IDs.

### Risks

A rehearsal can accidentally point at live DB/artifacts, execute an approved-online job, or leak private recovery content. Candidate, observation, comparison, and resource counts can be confused after provenance union or identity convergence.

### Test notes

Require explicit temporary roots, globally forbid network executables/sockets, capture JSON reconciliation, restore the pre-run snapshot, rerun idempotently, and sample citations/search across resource kinds. Use synthetic fixtures in normal tests; the real generation is an explicit local rehearsal input.

### Detailed phases

1. Prove generation hashes, exact accounting, dry-run parity, and no writes.
2. Import into temporary state and drain only 581 offline jobs while two approved-online jobs remain non-runnable.
3. Validate observation/provenance union, replay, injected failures, restore, retrieval, and sanitized reconciliation output.

### Alternatives

A live first run is rejected; the corpus is small enough for a realistic disposable rehearsal. Fetching the two approved URLs during rehearsal is rejected because it would make recovery nondeterministic.

### Non-functional targets

Rehearsal performs zero network operations, emits no private bodies, identifiers, or exact URLs, and remains repeatable from documented commands.

### Rollout

Publish only counts, opaque IDs, hashes, and sanitized failures needed for the following live operational tasks.

## Acceptance

- [ ] Disposable import accounts for all 1,088 candidates, all 294 Telegram observations, and all 584 ordered catalog memberships.
- [ ] Exactly 581 valid offline artifacts complete when fixtures match; two approved-online jobs remain non-runnable, and all review/exclusion cohorts create no network work.
- [ ] The 118 provenance merges, 13 appended candidates, exact/comparison distinction, and one live-only observation reconcile without candidate collapse or disposition changes.
- [ ] Hash mismatch, mixed generation, parser failure, and interrupted replay isolate only affected jobs and remain resumable.
- [ ] FTS, collection filters, citations, provenance, and representative X/generic resources work after restore and idempotent replay.
- [ ] A verified pre-import snapshot restores the temporary database, artifact references, and generation identity exactly.

## Done summary

## Evidence
