## Description

**Size:** M
**Files:** src/store.ts, src/db.ts, src/types.ts, test/store.test.ts

### Approach

Add the next merge-available additive schema step for resources, typed keys and aliases, artifact metadata, sources, collections and ordered membership, observations, runs, typed provenance, and sensitivity. Preserve current documents/chunks/FTS and map their legacy identity without inventing historical evidence; keep ResearchCache structurally read-only and ResearchStore the sole migration/write surface.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/store.ts:55-170` — current schema and writable migration path.
- `src/store.ts:176-315` — transactional document upsert and FTS maintenance.
- `src/db.ts:436-454` — independent read-side schema-version guard.
- `test/store.test.ts:53-78` — additive migration preservation pattern.

**Optional** (reference as needed):
- `src/url.ts:1-79` — existing conservative URL and X identity behavior.

### Risks

A broad migration can orphan existing document IDs or desynchronize FTS. Resource aliases must not turn redirects or content hashes into implicit destructive merges.

### Test notes

Build populated schema-v2 fixtures, migrate them, compare document/chunk/relation IDs and FTS results, and reject unsupported newer schemas from both read and write paths.

### Detailed phases

1. Introduce typed domain records and constraints with merge-time schema numbering.
2. Add compatibility mapping for existing document rows and relation provenance.
3. Add store/query APIs and migration/integrity tests.

### Alternatives

Replacing `documents` wholesale is rejected; an additive bridge preserves current readers and rollback evidence.

### Non-functional targets

Migration is transactional, deterministic, idempotent, and completes without network access or artifact reads.

### Rollout

Exercise only temporary databases in this task; no live database mutation is part of acceptance.

## Acceptance

- [ ] A legacy-populated database migrates without changing existing document, chunk, relation, or FTS behavior.
- [ ] Resources, aliases, artifacts, sources, collections, memberships, observations, runs, provenance, and sensitivity have enforceable cardinalities and uniqueness constraints.
- [ ] Equal artifact hashes and observed canonical URLs do not automatically merge resource identities.
- [ ] Read-only commands still open without creating or migrating any state.
- [ ] Unsupported future schema versions fail clearly on both read and write paths.

## Done summary
Added additive schema-v3 migration for the durable ingestion domain model (resources, typed keys, aliases, content-addressed artifacts, sources, collections with ordered membership, observations, runs, typed provenance, ranked sensitivity), backfilling legacy documents/relations while keeping equal digests and canonical URLs from merging identities and preserving the read-only query boundary.
## Evidence
