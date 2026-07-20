## Description

**Size:** S
**Files:** bin/.local/bin/restic-backup, bin/.local/bin/restic-backup-silverbird, the fake-binary test assets for these scripts

### Approach

The close audit halted fn-4 on a fatal cross-repo contract mismatch: both landed backup
scripts invoke `agentbrain backup create --destination "$SNAPSHOT_DIR" --json` after
`mkdir -p "$SNAPSHOT_DIR"` (restic-backup:175, restic-backup-silverbird:173), but the
real CLI shipped on the fn-4 agentbrain lane accepts ONLY a positional backup path or
`--output <path>` (which MUST NOT already exist) plus `--artifact-root` — there is no
`--destination` flag, so every scheduled run exits 2 at the snapshot gate and restic
never runs. The shell tests passed because their fake agentbrain binary accepted the
invented flag: the fakes encoded a contract the real CLI never had.

Fix the scripts to call the contract the CLI actually implements: point the create at a
fresh non-existent bundle path (e.g. a timestamped child under the snapshot parent),
pre-create only the parent, and align the JSON success check with the CLI's real success
envelope (the current `.success == true or .ok == true or .status == "success"` guess must
be verified against actual output — the CLI emits a `{schema_version, ok, ...}` envelope).
Preserve fail-closed semantics on every non-success path. Then make the fake-binary tests
enforce the REAL contract: the fake must reject `--destination` and assert the accepted
invocation shape, so contract drift can never pass green again.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- bin/.local/bin/restic-backup:160-185 — snapshot gate, SNAPSHOT_DIR pre-create, success-envelope check
- bin/.local/bin/restic-backup-silverbird:158-183 — same gate in the Silverbird variant
- The agentbrain CLI backup contract — source of truth is the fn-4 agentbrain lane at
  /Users/mike/worktrees/agentbrain-demflj--keeper-epic-fn-4-prepare-legacy-corpus-recovery
  (src/help.ts:272-283, src/cli.ts backup dispatch, src/backup.ts). If that lane is gone,
  the agentbrain side has landed — read /Users/mike/code/agentbrain instead. Run the lane
  CLI via bun to capture the LITERAL success envelope of `backup create`.
- The existing fake-binary test assets for these scripts (added by fn-4.2) — find them via
  the dotfiles test layout; they currently accept the wrong flag.

### Risks

- `--output` must-not-exist semantics: a retry or leftover bundle path must not wedge the
  nightly run — generate a fresh path per run and handle collision by failing closed with
  a clear message, never by deleting data.
- The envelope check is load-bearing: a lenient check that passes on a failure envelope
  silently reverts to backing up an inconsistent DB.
- Do not widen backup source lists or touch exclusion rules — this task is only the
  snapshot-gate contract.

### Test notes

Update the fake agentbrain binary to mirror the real contract (reject `--destination`
with exit 2 unknown_option, accept `--output <fresh path>`, emit the real success
envelope shape captured from the lane CLI). Assert both scripts' snapshot gates succeed
against the corrected fake and abort fail-closed against the rejecting fake. Shell-level
only; no repository, credential, or network access.

## Acceptance

- [ ] Both scripts invoke `agentbrain backup create` in a form the real CLI accepts, with a
  fresh non-existent output path per run; the literal invocation is proven against the
  lane-built (or landed) agentbrain binary in a sandbox, including the second-run case
- [ ] The JSON success check matches the CLI's actual success envelope and every
  non-success path aborts fail-closed before restic runs
- [ ] The fake-binary tests enforce the real contract (fake rejects `--destination`,
  asserts the accepted shape) and all touched shell tests pass via their named gates

## Done summary
Fixed both restic-backup scripts to invoke agentbrain backup create with --output <fresh-path> instead of the invented --destination flag, tightened the JSON success check to the CLI's real {schema_version,ok,command,data.backup_path} envelope, and rewrote the fake-binary test to reject --destination, enforce the real invocation shape, and prove consecutive runs never collide on output paths.
## Evidence
