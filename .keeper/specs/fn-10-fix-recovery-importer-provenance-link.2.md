## Description

Fixes finding F8. In bin/.local/bin/restic-backup (and its silverbird
sibling), `SNAPSHOT_PATH="$SNAPSHOT_DIR/backup-<ts>-$$"` (~line 173)
creates a fresh full-DB snapshot directory every run under $SNAPSHOT_DIR
($HOME/.local/state/agentbrain/restic-snapshot), which is itself in the
restic source set (~line 234). Nothing prunes prior snapshot dirs, so local
disk grows unbounded and restic re-walks every accumulated snapshot on each
run. Prune prior snapshot dirs (keep-last-N or rm after a successful
create), or write to a per-run temp path removed on exit. Also tidy the
double-coverage of $SNAPSHOT_DIR (covered explicitly and via
$HOME/.local/state).

Files: bin/.local/bin/restic-backup and the silverbird variant, plus the
shell test suite.

## Acceptance

- [ ] Old snapshot dirs are reclaimed so $SNAPSHOT_DIR does not grow unbounded across runs.
- [ ] Restic no longer re-walks stale snapshot dirs on each run.
- [ ] Shell test covers the prune/cleanup behavior.

## Done summary

## Evidence
