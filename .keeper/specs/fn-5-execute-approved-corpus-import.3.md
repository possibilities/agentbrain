## Description

**Size:** S
**Files:** ~/.hermes/research-cache/research.db, ~/.local/share/agentbrain/artifacts/, ~/.local/share/agentbrain/recovery/manifests/, ~/.local/share/agentbrain/recovery/snapshots/, ~/.local/share/agentbrain/recovery/SHA256SUMS

### Approach

After the offline Run reaches fully reconciled terminal state and passes backup, integrity, artifact, FTS, and retrieval gates, create and restore-check a post-offline snapshot. With the ordinary worker quiesced, verify the pinned generation digest and immutable approval manifest contains exactly two distinct human-approved candidate evidence row IDs, then activate and drain only the linked online Run through the scoped concurrency-one worker and Scrapectl. Preserve per-item isolation, durable retries, and safe evidence; never substitute another candidate or reveal the exact URLs in ordinary output.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before execution):
- `docs/adr/0010-legacy-recovery-import-contract.md:19-38` — exact two-link authorization, eligibility, failure, and rollback contract.
- `docs/adr/0007-synchronous-scrapectl-extraction-contract.md:13-29` — Scrapectl envelope and single-attempt ownership.
- `~/.local/share/agentbrain/recovery/manifests/online-allowlist.json:1` — private immutable authorization tuple produced by recovery preparation.
- `~/.local/share/agentbrain/recovery/manifests/current.json:1` — pinned generation descriptor and digest.

**Optional** (reference as needed):
- `docs/adr/0004-durable-ingestion-job-lifecycle.md:13-27` — retry and blocked-state interpretation.
- `~/.local/share/agentbrain/recovery/SHA256SUMS:1` — protected evidence fixity.

### Risks

The remote request cannot be undone. A mutable query, broad worker, background-worker race, altered generation, wrong cardinality, stale backup, shared provider outage, or unsafe evidence output can widen scope or make results unverifiable.

### Test notes

Re-run the synthetic scoped-execution tests and disposable recovery rehearsal, then use live commands only with explicit generation/approval digests and private paths. Do not add a live network test to normal suites; capture only bounded counts, opaque IDs, states, hashes, and sanitized failure classes.

### Detailed phases

1. Verify offline terminal reconciliation, post-offline snapshot restore, generation/allowlist hashes, exact cardinality two, disk, permissions, and worker quiescence.
2. Activate the separate linked online Run and execute one approved URL job at a time through Scrapectl.
3. Reconcile attempts, artifacts, resources/documents, FTS, citations, provenance, and local rollback instructions; preserve retryable or review outcomes without widening scope.

### Alternatives

Fetching during the offline Run is rejected because it destroys zero-egress proof. Selecting all approved pending jobs is rejected because mutable state can widen beyond the human-reviewed pair.

### Non-functional targets

Concurrency one, exact immutable scope, no direct Agentbrain egress, bounded provider attempts, safe structured output, resumable local effects, and no tight polling.

### Rollout

Item-specific terminal failure permits the sibling to proceed; shared infrastructure, authorization/configuration, generation, or integrity failure pauses before further egress. The operator observation window may end while durable infrastructure retry remains scheduled; do not cancel or blindly retry. Resume the same Run after inspection. Re-enable the ordinary worker only after no scoped lease remains and reconciliation is durable.

## Acceptance

- [ ] A verified post-offline snapshot preserves the reconciled 581-artifact corpus and restores independently of online local effects.
- [ ] The command fails before egress unless the generation digest matches and the immutable allowlist contains exactly two distinct approved human candidate evidence row IDs mapped to exactly two jobs in the linked Run.
- [ ] Only those two jobs receive online Attempts; all five bot-output, 12 probable-test, review, excluded, and unrelated due jobs remain unchanged.
- [ ] Each Attempt invokes Scrapectl as the sole network extractor and commits artifact, document, provenance, and terminal job state through normal fenced completion.
- [ ] Item-specific failure does not roll back or suppress its sibling; shared provider/auth/config/integrity failure pauses the Run with inspectable state and no scope widening.
- [ ] Replaying the same approval/run skips completed logical effects, resumes only eligible incomplete work, and never substitutes candidates.
- [ ] The Run completes only when both jobs succeed or duplicate safely; terminal non-success produces `completed_with_review` plus durable per-item evidence and no false claim that remote requests were rolled back.
- [ ] Sanitized evidence records generation, approval, Run, snapshot and artifact digests, counts, states, Attempts, timings, and classifications without message bodies, Telegram identifiers, credentials, or exact unsafe URLs.

## Done summary
Added digest-pinned, snapshot-gated controlled online backfill (recovery online): validates offline reconciliation, restore-verifies the post-offline snapshot, enforces the exact two-candidate immutable allowlist, and drains only those two jobs concurrency-one through the existing scoped worker and Scrapectl, with replay safety, per-item isolation, and sanitized evidence.
## Evidence
