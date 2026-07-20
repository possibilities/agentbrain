## Description

**Size:** S
**Files:** src/backup.ts, src/db.ts, test/backup.test.ts

### Approach

Backup verification currently compares a backup image only against its
OWN manifest and opens it with a raw database handle, bypassing the
store's schema guards — so an old-schema backup reports VERIFIED under
newer code and that green asserts nothing about restorability. Make the
verify report state the version relationship explicitly: current,
older-migratable, or newer-unsupported. Separately, the read path
rejects only newer-than-current schemas; give it the matching lower
bound so an old image surfaces a structured unsupported-schema error
instead of dying on missing columns. Migrate-on-restore is explicitly
OUT of scope: no restore command exists yet; the migrate posture lands
with it in the import-execution epic.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/backup.ts:196-215 — manifest schema_version sourced from the snapshot DB itself
- src/backup.ts:651 — the raw Database open that bypasses store guards
- src/db.ts:805-824 — the read-path version gate (upper bound only today)

### Risks

- The verify report shape is consumed by rehearsal tooling; additive fields only, no breaking change to existing green outputs

### Test notes

Fixtures: a current-version image verifies "current"; an older image verifies "older-migratable" (never bare green); a newer image verifies "newer-unsupported"; the read path returns the structured error for an old image.

## Acceptance

- [ ] Verify output names the version relationship for current, older, and newer images, proven by fixture tests
- [ ] Opening an older-schema database through the store returns a structured unsupported-schema error, never a raw missing-column failure
- [ ] Existing backup create/verify behavior for current-version images is unchanged

## Done summary
Verify report now names the schema version relationship (current, older-migratable, newer-unsupported) against the running schema, and the read-only cache open path rejects older-than-supported schemas with a structured unsupported_schema_version error instead of failing on missing columns.
## Evidence
