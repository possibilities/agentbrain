## Description

**PRIOR-ATTEMPT PARK NOTE (supervisor, verified).** The frozen generation EXISTS and is checksummed — the earlier DEPENDENCY_BLOCKED park chased a spec typo (`manifests/current.json`); the real artifact is the atomic pointer `~/.local/share/agentbrain/recovery/manifests/current` (directory with generation.json, candidate-manifest.jsonl, SHA256SUMS). Do not park on the missing `.json` literal; run preflight against the pointer.


**Size:** M
**Files:** ~/.hermes/research-cache/research.db, ~/.local/share/agentbrain/artifacts/, ~/.local/share/agentbrain/recovery/, ~/content/links/

### Approach

Verify the frozen generation digest, encrypted backup freshness, checksum inventory, and a restore-checked pre-import snapshot; then dry-run and admit the recovery generation. With the ordinary worker quiesced, use the run-scoped offline executor to drain only the 581 local-artifact jobs while URL/external kinds are forbidden, then reconcile all 1,088 candidates, 294 Telegram observations, 584 memberships, artifacts, and provenance. Preserve the separately linked two-job online Run in a non-runnable state and record bounded evidence rather than private content.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before execution):
- `docs/adr/0010-legacy-recovery-import-contract.md:13-38` — locked generation, cohort, isolation, and reconciliation contract.
- `~/.local/share/agentbrain/recovery/manifests/current` — the ATOMIC GENERATION POINTER (a symlink to the frozen sha256-named generation directory; its `generation.json` carries the bound checksum inventory). The landed importer accepts pointer, directory, or generation.json for `--manifest-generation` — there is NO `current.json` file; a prior attempt parked on that literal path. Verified present and frozen 2026-07-19.
- `~/.local/share/agentbrain/recovery/SHA256SUMS:1` — protected evidence integrity.
- `~/docs/agentbrain-recovery-report-2026-07-15.md:47-58` — baseline live DB and backup cautions.

**Optional** (reference as needed):
- `~/docs/agentbrain-historical-db-evidence-2026-07-15.json:1` — documentary historical aggregates only.

### Risks

This task mutates authoritative local state. A changed generation, stale backup, active generic worker, wrong scope, unexpected live jobs, disk exhaustion, hash mismatch, or path error must stop before or isolate mutation. Evidence output must not leak exact URLs or private recovery context.

### Test notes

Re-run the disposable offline rehearsal and scoped-worker isolation tests first, then use production commands with explicit generation digest, Run ID, allowed kind, and live paths. No network executable or URL job may be eligible during this task.

### Detailed phases

1. Verify generation/approval hashes, backups, permissions, disk, current DB integrity, worker quiescence, and exact dry-run.
2. Snapshot, admit, and run-scope drain only the 581 offline jobs with URL kinds forbidden.
3. Reconcile all candidates/observations/memberships/provenance, run retrieval and restore checks, freeze the two-ID online Run, and retain rollback state.

### Alternatives

Direct SQL, per-file synchronous ingest, and broad queue draining are rejected because they bypass or widen jobs, provenance, idempotency, and reconciliation.

### Non-functional targets

Zero network access, no unrelated claims, no private bodies or unsafe URLs in evidence, bounded concurrency, deterministic outcomes, and reversible DB/artifact mutation.

### Rollout

Stop on any preflight discrepancy. Keep the generic worker quiesced until scoped leases finish and exact reconciliation is durable. Isolated candidate failures may remain only when they are terminal, evidence-backed, and all integrity gates pass; systemic mismatch blocks the online phase.

## Acceptance

- [ ] Preflight proves the expected generation digest, current encrypted backups, snapshot restoration, DB integrity, artifact permissions, disk capacity, worker quiescence, and exact dry-run counts before admission.
- [ ] Scoped execution creates Attempts only for the 581 offline artifact jobs and proves zero Scrapectl invocation, URL-kind claim, source scheduling, or unrelated due-job execution.
- [ ] All 1,088 candidates, 294 Telegram observations, 584 memberships, 118 provenance merges, and 13 appended candidates reconcile without candidate or resource-count confusion.
- [ ] The 581 offline artifacts either complete or retain isolated evidence-backed terminal failures; backup, DB, artifact, FTS, retrieval, and reconciliation invariants all pass before online eligibility.
- [ ] Cohorts reconcile as 12 probable-test exclusions, 25 infrastructure exclusions, four legacy fetch reviews, five retries, 98 human reviews, 356 Discord reviews, five bot-output reviews, and exactly two approved-online jobs in a linked non-runnable Run.
- [ ] Live search and context return representative citations with original URLs, catalog evidence, collection membership, and historical/Telegram provenance without exposing private message metadata.
- [ ] Job/Attempt history, generation/artifact digests, backup verification, post-offline eligibility, and rollback instructions are captured as sanitized task evidence.

## Done summary

## Evidence
