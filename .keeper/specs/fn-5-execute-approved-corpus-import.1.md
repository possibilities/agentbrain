## Description

**Size:** M
**Files:** ~/.hermes/research-cache/research.db, ~/.local/share/agentbrain/artifacts/, ~/.local/share/agentbrain/recovery/, ~/content/links/, ~/docs/agentbrain-recovery-manifest-2026-07-15.jsonl

### Approach

Verify backup freshness and SHA-256 inventory, create and restore-check a pre-import snapshot, run exact dry-run, admit the recovery run, drain only offline jobs, and reconcile every candidate/membership/artifact. Preserve blocked and excluded evidence, test representative retrieval/provenance, and record bounded task evidence rather than committing private or historical content into source docs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `docs/adr/0010-legacy-recovery-import-contract.md:1` — locked counts and dispositions.
- `~/docs/agentbrain-recovery-manifest-2026-07-15.jsonl:1` — authoritative candidates.
- `~/docs/agentbrain-recovery-report-2026-07-15.md:47-58` — live DB and backup cautions.
- `~/.local/share/agentbrain/recovery/SHA256SUMS:1` — protected evidence integrity.

**Optional** (reference as needed):
- `~/docs/agentbrain-historical-db-evidence-2026-07-15.json:1` — documentary historical aggregates only.

### Risks

This task mutates authoritative local state. A stale backup, unexpected live jobs, disk exhaustion, hash mismatch, or path error must stop before or isolate mutation; evidence output must not leak private recovery content.

### Test notes

Re-run the already-landed disposable rehearsal first, then use production commands with explicit live paths. Sample exact URL, X status/article, shared-link, legacy position, sensitivity, citation, and blocked-job cases.

### Detailed phases

1. Verify backups, permissions, disk space, current DB integrity, queue quiescence, and exact dry-run.
2. Snapshot, admit, and drain the 581 offline cohort without network executables.
3. Reconcile counts/hashes/provenance, run retrieval and restore checks, and retain rollback state.

### Alternatives

Direct SQL or per-file synchronous ingest is rejected because it bypasses jobs, provenance, idempotency, and reconciliation.

### Non-functional targets

Zero network access, no private bodies in logs/evidence, bounded worker concurrency, deterministic outcomes, and reversible DB/artifact mutation.

### Rollout

Keep the worker limited to offline recovery kinds during the run. Resume ordinary ingress only after integrity and retrieval checks pass; retain blocked fetch/retry jobs without executing them.

## Acceptance

- [ ] Preflight proves current backups, snapshot restoration, DB integrity, artifact permissions, disk capacity, and exact dry-run counts before admission.
- [ ] All 581 approved artifacts either complete and index or have isolated evidence-backed failures; no sibling success is rolled back.
- [ ] The 584 ordered memberships, 2 excluded catalog tests, 4 blocked fetches, 5 blocked retries, 98 human review, 356 Discord review, 25 infrastructure exclusions, and all 6 probable-test exclusions reconcile exactly without double counting candidates.
- [ ] Live search and context return representative citations with original URLs, catalog evidence, collection membership, and historical provenance.
- [ ] Job/attempt history, artifact digests, FTS integrity, backup verification, and rollback instructions are captured as sanitized task evidence.

## Done summary

## Evidence
