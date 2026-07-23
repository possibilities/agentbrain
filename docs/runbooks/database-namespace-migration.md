# Agentbrain database namespace migration runbook

This one-time runbook moves the live database from `~/.hermes/research-cache/research.db` to `~/.local/share/agentbrain/research.db`. Run it only from the matching Agentbrain checkout after its full test suite passes. Never create a compatibility symlink.

## Preconditions and baseline

```bash
set -euo pipefail
umask 077
OLD="$HOME/.hermes/research-cache/research.db"
NEW_DIR="$HOME/.local/share/agentbrain"
NEW="$NEW_DIR/research.db"
ARTIFACTS="$NEW_DIR/artifacts"
STAMP=$(date -u '+%Y%m%dT%H%M%SZ')
EVIDENCE="$HOME/.local/state/agentbrain/database-migrations/$STAMP"
ONLINE_BACKUP="$EVIDENCE/online-backup"
FINAL_BACKUP="$EVIDENCE/final-backup"
ARCHIVE="$EVIDENCE/legacy-database-set"
DEPLOY_SHA=$(git rev-parse HEAD)
DEPLOY="$HOME/.local/share/agentbuilds/checkouts/agentbrain/$DEPLOY_SHA"
test "$(git -C "$DEPLOY" rev-parse HEAD)" = "$DEPLOY_SHA"
test -z "$(git -C "$DEPLOY" status --porcelain --untracked-files=all)"
mkdir -p "$EVIDENCE"
chmod 700 "$EVIDENCE"

test -f "$OLD"
test ! -e "$NEW"
test ! -L "$NEW_DIR"
test ! -L "$NEW"

agentbrain --db "$OLD" doctor --json >"$EVIDENCE/old-doctor.json"
agentbrain --db "$OLD" stats --json >"$EVIDENCE/old-stats.json"
agentbrain --db "$OLD" jobs stats --json >"$EVIDENCE/old-jobs.json"
jq -e '
  .data.by_state.queued == 0 and
  .data.by_state.running == 0 and
  .data.by_state.retry_wait == 0 and
  .data.active_leases == 0
' "$EVIDENCE/old-jobs.json"

agentbrain --db "$OLD" backup create --output "$ONLINE_BACKUP" --json \
  >"$EVIDENCE/online-backup-create.json"
agentbrain backup verify --backup "$ONLINE_BACKUP" \
  --artifact-root "$ARTIFACTS" --json \
  >"$EVIDENCE/online-backup-verify.json"
jq -e '.data.verified == true' "$EVIDENCE/online-backup-verify.json"
```

Blocked, failed, excluded, and cancelled jobs are durable terminal evidence and do not prevent migration. Queued, running, retry-delayed jobs or active leases do.

## Stop the writer and create the final image

```bash
launchctl bootout "gui/$(id -u)/agentbrain.worker"
for _ in $(seq 1 120); do
  if ! launchctl print "gui/$(id -u)/agentbrain.worker" >/dev/null 2>&1 && \
     ! lsof "$OLD" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
! launchctl print "gui/$(id -u)/agentbrain.worker" >/dev/null 2>&1
! lsof "$OLD" >/dev/null 2>&1

agentbrain --db "$OLD" backup create --output "$FINAL_BACKUP" --json \
  >"$EVIDENCE/final-backup-create.json"
agentbrain backup verify --backup "$FINAL_BACKUP" \
  --artifact-root "$ARTIFACTS" --json \
  >"$EVIDENCE/final-backup-verify.json"
jq -e '.data.verified == true' "$EVIDENCE/final-backup-verify.json"
```

`backup create` uses SQLite `VACUUM INTO`; its `database.sqlite` is standalone and includes committed WAL state.

## Publish privately and verify before retiring the old path

```bash
install -d -m 700 "$NEW_DIR" "$ARCHIVE"
TMP="$NEW_DIR/.research.db.migrating.$$"
install -m 600 "$FINAL_BACKUP/database.sqlite" "$TMP"
python3 - "$TMP" "$NEW_DIR" <<'PY'
import os, sys
file_path, directory = sys.argv[1:]
fd = os.open(file_path, os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
dfd = os.open(directory, os.O_RDONLY)
try: os.fsync(dfd)
finally: os.close(dfd)
PY
mv "$TMP" "$NEW"
chmod 600 "$NEW"

agentbrain --db "$NEW" doctor --json >"$EVIDENCE/new-doctor.json"
agentbrain --db "$NEW" stats --json >"$EVIDENCE/new-stats.json"
agentbrain --db "$NEW" jobs stats --json >"$EVIDENCE/new-jobs.json"
jq -e '.data.healthy == true' "$EVIDENCE/new-doctor.json"
# VACUUM INTO compacts bytes and the path intentionally changes; compare logical stats.
diff -u \
  <(jq -S '.data | del(.db_path,.db_size_bytes)' "$EVIDENCE/old-stats.json") \
  <(jq -S '.data | del(.db_path,.db_size_bytes)' "$EVIDENCE/new-stats.json")
diff -u \
  <(jq -S '.data' "$EVIDENCE/old-jobs.json") \
  <(jq -S '.data' "$EVIDENCE/new-jobs.json")

for path in "$OLD" "$OLD-wal" "$OLD-shm"; do
  if [[ -e "$path" ]]; then mv "$path" "$ARCHIVE/"; fi
done
chmod -R go-rwx "$ARCHIVE"
test ! -e "$OLD"

(
  cd "$DEPLOY"
  ./scripts/install.sh --install
)
agentbrain doctor --json >"$EVIDENCE/default-doctor.json"
agentbrain jobs stats --json >"$EVIDENCE/default-jobs.json"
jq -e --arg path "$NEW" \
  '.ok == true and .data.healthy == true and .meta.db_path == $path' \
  "$EVIDENCE/default-doctor.json"
launchctl print "gui/$(id -u)/agentbrain.worker" >/dev/null
lsof "$NEW" | tee "$EVIDENCE/new-open-handles.txt"
! lsof "$OLD" >/dev/null 2>&1
```

Keep the final verified backup and private legacy set through at least one successful backup cycle.

## Rollback

```bash
launchctl bootout "gui/$(id -u)/agentbrain.worker"
for _ in $(seq 1 120); do
  ! lsof "$NEW" >/dev/null 2>&1 && break
  sleep 0.25
done
! lsof "$NEW" >/dev/null 2>&1

ROLLBACK_SAVE="$EVIDENCE/namespaced-state-before-rollback"
install -d -m 700 "$ROLLBACK_SAVE"
for path in "$NEW" "$NEW-wal" "$NEW-shm"; do
  if [[ -e "$path" ]]; then mv "$path" "$ROLLBACK_SAVE/"; fi
done
install -d -m 700 "$(dirname "$OLD")"
install -m 600 "$FINAL_BACKUP/database.sqlite" "$OLD"
agentbrain --db "$OLD" doctor --json
```

Then restore the pre-ADR-0014 Agentbrain revision, run its temporary-database smoke, and install that revision's Worker. Never run old- and new-default Workers concurrently.
