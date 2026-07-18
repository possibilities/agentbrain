## Description

**Size:** M
**Files:** src/backup.ts, src/store.ts, src/cli.ts, src/help.ts, test/backup.test.ts

### Approach

Add `agentbrain backup create` and `backup verify` using a SQLite-consistent snapshot mechanism coordinated with the sole writer, plus an artifact/reference manifest and restore verification. Snapshot creation must not embed secrets or assume the worker is permanently stopped.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/store.ts:148-170` — writable SQLite ownership and connection setup.
- `src/db.ts:28-53` — structurally read-only connection behavior.
- `docs/adr/0008-content-addressed-artifact-storage.md:1` — backup and artifact guarantees.

**Optional** (reference as needed):
- `test/store.test.ts:210-251` — concurrent connection test pattern.

### Risks

Copying a live file can omit WAL state; quiescing incorrectly can stall or kill active work. A restore verifier must not accidentally open/migrate the source database.

### Test notes

Snapshot a temporary WAL database with concurrent reads and committed writes, restore elsewhere, run integrity/reference/FTS checks, and simulate interrupted destination writes.

### Detailed phases

1. Select and implement a consistent SQLite snapshot primitive.
2. Emit artifact/reference and configuration metadata without content leakage.
3. Add isolated restore verification and cleanup behavior.

### Alternatives

Raw file copy and forced global worker shutdown are rejected as unreliable or operationally brittle.

### Non-functional targets

Snapshot paths are private, writes are atomic, verification is read-only against the source, and failure cannot overwrite a previous good snapshot.

### Rollout

Use only temporary databases until restore tests pass; live snapshot creation belongs to the operational recovery epic.

## Acceptance

- [ ] Snapshot captures all committed SQLite state from a WAL-mode database and restores with integrity `ok`.
- [ ] Snapshot metadata identifies schema, timestamps, required artifact digests, and source paths without secrets or content bodies.
- [ ] Verification detects missing/corrupt DB bytes, artifact references, and unrebuildable FTS.
- [ ] Interrupted snapshot creation leaves no acknowledged partial backup.
- [ ] Normal backup tests require no live worker, Restic repository, or network.

## Done summary

## Evidence
