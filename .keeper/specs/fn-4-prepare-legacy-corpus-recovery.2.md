## Description

**Size:** M
**Files:** bin/.local/bin/restic-backup, bin/.local/bin/restic-backup-silverbird, readme.md

### Approach

Invoke the supported Agentbrain snapshot primitive before Restic and include the consistent snapshot, `~/.hermes/research-cache`, `~/content/links`, `~/docs/agentbrain-*`, Agentbrain artifact/state roots, the frozen recovery generation, and protected derived Telegram evidence in both encrypted repositories. Fail closed if generation verification fails, while explicitly excluding Agentbot/Telegram session credentials and disposable database/session working copies even when a broader parent path is covered.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `bin/.local/bin/restic-backup:140-178` — current B2 source list already covering XDG state and docs but not `.hermes` or content.
- `bin/.local/bin/restic-backup-silverbird:140-177` — current Silverbird source list missing `.hermes`, content, and docs.
- `docs/adr/0010-legacy-recovery-import-contract.md:27-31` — derived-evidence inclusion and credential exclusion.
- `CLAUDE.md:1` — repository conventions.

**Optional** (reference as needed):
- `readme.md:1` — current manual/operations documentation style.

### Risks

Restic can back up a live inconsistent DB if snapshot preparation fails open. Broad roots can capture MTProto sessions, temporary credential copies, unintended secrets, or noisy private filenames in logs.

### Test notes

Add shell-level dry-run/source-list checks with fake Restic and Agentbrain binaries; verify snapshot or generation failure aborts backup, required roots occur exactly once, and explicit exclusions cover session/working-copy patterns. No repository, credential, or network access is allowed.

### Detailed phases

1. Add pre-backup consistent snapshot and frozen-generation verification with fail-closed handling.
2. Extend B2 and Silverbird source coverage for durable evidence and add exact credential/working-copy exclusions.
3. Add restore-verification instructions and fake-command tests or assertions.

### Alternatives

Depending on `.local/share` alone is rejected because the DB and link corpus live outside it; backing up the whole Agentbot config tree is rejected because session material is a credential.

### Non-functional targets

Credentials remain environment/file sourced, logs contain no private bodies, URLs, or identifiers, and existing monitoring/integrity exit semantics remain unchanged.

### Rollout

Run a tagged/dry snapshot in each repository, restore the frozen generation and required roots, verify exclusions, then allow normal schedules to continue before live import.

## Acceptance

- [ ] Both backup scripts fail closed if a consistent Agentbrain snapshot or frozen-generation verification cannot complete.
- [ ] Both repositories cover the DB snapshot, artifact store, link corpus, final manifests, protected Telegram-derived evidence, and checksum inventory.
- [ ] MTProto recorder sessions, bot secrets, temporary session snapshots, and disposable working database copies are excluded even under broad roots.
- [ ] Backup logs and state files expose no credentials, exact recovered URLs, message identifiers, or private bodies.
- [ ] A documented sampled restore verifies DB integrity, artifact hashes, the complete 1,088-candidate generation, and required corpus files with restrictive modes.
- [ ] Existing backup monitoring, retry-lock, and scheduled integrity behavior remains intact.

## Done summary
Both Restic backup scripts now fail closed unless the Agentbrain recovery generation checksum verifies and a consistent snapshot succeeds; extended B2/Silverbird source coverage, added credential/session exclusions, documented sampled restore verification, and added an isolated shell test suite.
## Evidence
