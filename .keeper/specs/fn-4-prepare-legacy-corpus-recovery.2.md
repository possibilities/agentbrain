## Description

**Size:** M
**Files:** bin/.local/bin/restic-backup, bin/.local/bin/restic-backup-silverbird, readme.md

### Approach

Invoke the supported Agentbrain snapshot primitive before Restic and include the consistent snapshot, `~/.hermes/research-cache`, `~/content/links`, `~/docs/agentbrain-*`, Agentbrain artifact/state roots, and protected recovery tree in both encrypted repositories. Verify path inclusion and restore readability without logging credentials or private filenames/bodies.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `bin/.local/bin/restic-backup:140-178` — current B2 source list already covering XDG state and docs but not `.hermes` or content.
- `bin/.local/bin/restic-backup-silverbird:140-177` — current Silverbird list missing `.hermes`, content, and docs.
- `CLAUDE.md:1` — repository conventions.

**Optional** (reference as needed):
- `readme.md:1` — current manual/operations documentation style.

### Risks

Restic can back up a live inconsistent DB if snapshot preparation fails open. Broad paths can capture unintended secrets or produce noisy logs.

### Test notes

Add shell-level dry-run/source-list checks with fake Restic and Agentbrain binaries; verify snapshot failure aborts backup and path arguments contain required roots exactly once.

### Detailed phases

1. Add pre-backup consistent snapshot and fail-closed handling.
2. Extend B2 and Silverbird source coverage.
3. Add restore-verification instructions and fake-command tests or assertions.

### Alternatives

Depending on `.local/share` alone is rejected because the DB and link corpus live outside it.

### Non-functional targets

Credentials remain environment/file sourced, logs contain no private bodies, and existing monitoring/integrity exit semantics remain unchanged.

### Rollout

Run a tagged/dry snapshot in each repository, verify path restoration, then allow normal schedules to continue before live import.

## Acceptance

- [ ] Both backup scripts fail closed if a consistent Agentbrain snapshot cannot be created.
- [ ] Both repositories cover the DB snapshot, artifact store, link corpus, recovery manifests, and private recovery tree.
- [ ] Backup logs and state files expose no credentials or recovered private content.
- [ ] A documented sampled restore verifies DB integrity, artifact hashes, and required corpus files.
- [ ] Existing backup monitoring, retry-lock, and scheduled integrity behavior remains intact.

## Done summary

## Evidence
