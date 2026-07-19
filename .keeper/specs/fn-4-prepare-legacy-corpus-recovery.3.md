## Description
**AUDIT-SEVERE FIX ROUND — read this block before anything else.** A prior worker landed this task's implementation as `a25265c` and the close audit CONFIRMED SEVERE defects in it. The implementation is ALREADY ON THE LANE; your job is NOT to re-implement the task and NOT to re-mark it done on the existing lane state. Your job is to FIX the audited defects, prove the fixes, and only then mark done with NEW commit evidence.

Read the persisted finding first: `/Users/mike/code/agentbrain/.keeper/state/audits/fn-4-prepare-legacy-corpus-recovery/tasks/fn-4-prepare-legacy-corpus-recovery.3.json`. Ground-truth every item. The two severe findings, per the audit:

1. `worker.ts:582-586` performs a blind `UPDATE` against the UNIQUE `resources.document_id` — it collides on foreign-resource same-URL re-import (per-resource alias uniqueness plus the resource-scoped identity guard admit that scenario cleanly; it is exactly Acceptance item 5's scenario). Aggravator: the forced `'infra'` failureClass retries uncapped with no dead-letter — a silent retry_wait spin. The shipped AC5 test structurally cannot collide (text-typed fixture); write one that does.
2. The ~816-line admission fail-closed surface has zero direct tests — add direct coverage for its fail-closed paths.

Thirteen mild findings are persisted alongside; address them only where they intersect the severe fixes. Marking this task done with empty evidence (`commits: []`) or without a test that reproduces the document_id collision is a phantom done and will be reset.

---

**Size:** M
**Files:** src/recovery.ts, src/admission.ts, src/cli.ts, src/help.ts, src/types.ts, test/recovery.test.ts

### Approach

Build a bounded generation reader that verifies the atomic generation descriptor and every JSONL/hash before admitting one queued recovery run and idempotent child jobs. Validate exact URLs, stable candidate IDs, dispositions, artifact paths/hashes, catalog positions, and body-free provenance; parse Linkctl frontmatter locally, strip it from searchable bodies, and prohibit all network work during import. Comparison URIs aid diagnostics only and cannot collapse candidate outcomes or authorize identity merges.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/.local/share/agentbrain/recovery/manifests/current.json:1` — final generation descriptor after Task 6; verify before relying.
- `~/.local/share/agentbrain/recovery/tools/build_agentbot_secretary_link_index.py:302-450` — frozen Telegram disposition and reconciliation derivation; do not duplicate heuristics.
- `src/completed-link-input.ts:24-120` — bounded validation pattern.
- `docs/adr/0010-legacy-recovery-import-contract.md:13-35` — exact cohort and generation contract.

**Optional** (reference as needed):
- `~/content/links/links.yaml:1` — ordered catalog evidence.
- `docs/adr/0006-conservative-resource-identity.md:13-24` — exact identity and comparison boundary.

### Risks

External paths may be missing or malicious, generation files can be mixed or replaced, private identifiers must not leak, and canonicalization can accidentally reduce exact candidate accounting. A queued approved-online job can fetch too early if offline gating is incomplete.

### Test notes

Generate synthetic generations for every disposition plus duplicate IDs, unsafe/symlink paths, hash mismatch, mixed generation IDs, malformed frontmatter, exact/comparison convergence, private provenance, partial rerun, and non-empty database merge. Install a fake Scrapectl that fails the test if invoked.

### Detailed phases

1. Validate generation identity, hashes, safe roots, counts, and summaries without mutation.
2. Admit the import run, memberships, evidence, exclusions, blocked reviews, non-runnable approved-online jobs, and approved offline jobs.
3. Add resumable per-candidate and per-observation reconciliation with dry-run parity and safe opaque diagnostics.

### Alternatives

Re-running recovery heuristics inside Agentbrain is rejected; the verified generation is the immutable import contract. Direct SQL is rejected because all outcomes belong in the durable ledger.

### Non-functional targets

Input is streaming and bounded, generation publication is fail-closed, file access stays within declared roots, no private body or raw Telegram identifier is emitted, and dry-run creates no DB/artifact state.

### Rollout

Use synthetic fixtures and the read-only frozen-generation dry run; live admission is deferred to the operational recovery epic.
## Acceptance

- [ ] Dry-run verifies one complete generation and reports exactly 1,088 candidate rows, 294 Telegram observations, and the locked disposition counts without writing state or making network calls.
- [ ] Approved artifacts are hash-verified and admitted with original URL identity, summary, catalog position, and legacy provenance.
- [ ] The two approved-online Secretary candidates are durably admitted but cannot run during offline recovery; legacy fetch/retry and bot-output review cohorts remain blocked or evidence-only as specified.
- [ ] All 118 existing exact candidates gain idempotent Telegram provenance without changed disposition or duplicate candidate outcomes.
- [ ] Partial rerun, old 1,075-generation evidence, and non-empty database merge preserve stable IDs and one outcome per candidate without duplicate effects.
- [ ] Private message bodies, credentials, raw Telegram identifiers, unsafe paths, and exact URLs in ordinary diagnostics never enter output, artifacts, or searchable content.

## Done summary

## Evidence
