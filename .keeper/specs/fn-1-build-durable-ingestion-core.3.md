## Description

**Size:** M
**Files:** src/artifacts.ts, src/store.ts, src/sanitize.ts, test/artifacts.test.ts

### Approach

Implement SHA-256-addressed staging, verification, atomic promotion, typed metadata registration, local-file snapshots, strict permissions, and orphan/staging reconciliation. Keep bytes outside hot SQLite rows while making normalized content sufficient for offline rebuilds.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/link-ingest.ts:262-280` — current optional artifact side effect.
- `src/extract.ts:73-108` — local secret-component filtering.
- `docs/adr/0008-content-addressed-artifact-storage.md:1` — locked storage and backup boundary.

**Optional** (reference as needed):
- `test/link-hardening.test.ts:114-198` — existing artifact failure and sanitization tests.

### Risks

SQLite and filesystem promotion cannot be one transaction. Symlinks, changing local files, oversized content, permission drift, and digest mismatch need explicit dispositions.

### Test notes

Use private temporary roots; assert atomic deduplication, file modes, snapshot immutability, interrupted staging recovery, digest mismatch, and orphan reporting.

### Detailed phases

1. Implement staging and content-addressed promotion.
2. Register typed artifact metadata and derivation.
3. Add snapshot and reconciliation APIs with permission tests.

### Alternatives

SQLite blobs and mutable source paths are rejected because they harm queue scans and reproducibility.

### Non-functional targets

Artifact promotion is streaming and bounded, repeated digest writes are idempotent, and private paths never appear in default diagnostics.

### Rollout

Default to a temporary artifact root in tests; do not touch live XDG state.

## Acceptance

- [ ] Accepted local-file intent references immutable bytes even if the original path changes or disappears.
- [ ] Artifact paths are derived from verified SHA-256 digests and duplicate bytes reuse storage without merging resources.
- [ ] Private directories and files are created with `0700` and `0600` permissions.
- [ ] Stale staging and promoted-orphan states are reported and safely reconcilable.
- [ ] Normalized artifacts can rebuild indexed content without source files or network access.

## Done summary

## Evidence
