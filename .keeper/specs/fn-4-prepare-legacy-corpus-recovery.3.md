## Description

**Size:** M
**Files:** src/recovery.ts, src/admission.ts, src/cli.ts, src/help.ts, src/types.ts, test/recovery.test.ts

### Approach

Build a bounded JSONL manifest reader that validates candidate IDs, exact URLs, dispositions, artifact paths/hashes, catalog positions, and provenance before admitting one queued recovery run and idempotent child jobs. Parse Linkctl frontmatter locally, preserve exact evidence, strip it from searchable bodies, and prohibit all network work during import.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `~/docs/agentbrain-recovery-manifest-2026-07-15.jsonl:1` — authoritative candidate format; read-only.
- `~/.local/share/agentbrain/recovery/tools/build_agentbrain_recovery_manifest.py:219-284` — disposition derivation; do not duplicate heuristics.
- `src/completed-link-input.ts:24-120` — bounded validation pattern.
- `docs/adr/0010-legacy-recovery-import-contract.md:1` — exact cohort contract.

**Optional** (reference as needed):
- `~/content/links/links.yaml:1` — ordered catalog evidence.

### Risks

External paths may be missing or malicious, private records must not leak, and canonicalization can accidentally reduce exact candidate accounting.

### Test notes

Generate synthetic manifests for every disposition plus duplicate IDs, unsafe paths, hash mismatch, malformed frontmatter, alias convergence, partial rerun, and non-empty database merge.

### Detailed phases

1. Validate and summarize manifest/evidence without mutation.
2. Admit the import run, memberships, evidence, excluded records, blocked review jobs, and approved offline jobs.
3. Add resumable per-candidate outcome reporting and dry-run parity.

### Alternatives

Re-running recovery heuristics inside Agentbrain is rejected; the verified manifest is the immutable import contract.

### Non-functional targets

Input is streaming and bounded, file access stays within declared roots, no private body is emitted, and dry-run creates no DB/artifact state.

### Rollout

Use synthetic fixtures and read-only real-manifest dry runs; live admission is deferred to the operational recovery epic.

## Acceptance

- [ ] Dry-run reports exactly 1,075 candidate rows and the locked disposition counts without writing state or making network calls.
- [ ] Approved artifacts are hash-verified and admitted with original URL identity, summary, catalog position, and legacy provenance.
- [ ] Fetch/retry cohorts become blocked review jobs; review-only and excluded cohorts create no fetch work.
- [ ] Partial rerun and non-empty database merge preserve one outcome per candidate without duplicate effects.
- [ ] Private message bodies and unsafe external paths never enter output, artifacts, or searchable content.

## Done summary

## Evidence
