#!/usr/bin/env bash
set -euo pipefail

# Disposable rehearsal of the frozen legacy recovery import. It drives the real
# hash-bound generation and local Markdown artifacts through dry-run, admission,
# an offline worker drain, retrieval, backup/restore, and idempotent replay in a
# throwaway database and Artifact store, with a forbidden Scrapectl on PATH so no
# fetch can occur. It prints only counts, opaque generation IDs, and snapshot
# hashes; never exact candidate URLs, bodies, private locators, or paths.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
generation="${AGENTBRAIN_RECOVERY_GENERATION:-$HOME/.local/share/agentbrain/recovery/manifests/current}"
artifact_root="${AGENTBRAIN_RECOVERY_ARTIFACT_ROOT:-$HOME/content/links}"

if [ ! -e "$generation" ]; then
  echo "frozen recovery generation not found at $generation" >&2
  echo "set AGENTBRAIN_RECOVERY_GENERATION to the generation directory or generation.json" >&2
  exit 2
fi
if [ ! -d "$artifact_root" ]; then
  echo "legacy artifact root not found at $artifact_root" >&2
  echo "set AGENTBRAIN_RECOVERY_ARTIFACT_ROOT to the declared legacy Markdown root" >&2
  exit 2
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentbrain-recovery-rehearsal.XXXXXX")"
db_path="$tmp_dir/rehearsal.db"
home_dir="$tmp_dir/home"
data_home="$tmp_dir/data"
bin_dir="$tmp_dir/bin"
sentinel="$tmp_dir/scrapectl-invoked"

cleanup() {
  local status=$?
  if [ "$status" -eq 0 ]; then
    rm -rf "$tmp_dir"
  else
    echo "Rehearsal failed; disposable evidence preserved at $tmp_dir" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$home_dir" "$data_home" "$bin_dir"

# A forbidden Scrapectl: any invocation trips the sentinel and fails, so a run
# that reached the network cannot pass.
cat >"$bin_dir/scrapectl" <<EOF
#!/bin/sh
touch "$sentinel"
exit 97
EOF
chmod 0755 "$bin_dir/scrapectl"

agentbrain_json() {
  HOME="$home_dir" XDG_DATA_HOME="$data_home" PATH="$bin_dir:$PATH" \
    bun "$repo_root/src/cli.ts" --db "$db_path" --json "$@"
}

# Asserts that data.<path> in a captured JSON envelope equals an expected value.
assert_field() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
let value = payload?.data;
for (const part of process.argv[2].split(".")) value = value?.[part];
const expected = process.argv[3];
if (String(value) !== expected) {
  throw new Error("expected " + process.argv[2] + "=" + expected + ", got " + String(value));
}
' "$1" "$2" "$3"
}

assert_absent() {
  if [ -e "$1" ]; then
    echo "network guard tripped: $1 exists (Scrapectl was invoked)" >&2
    exit 1
  fi
}

dry_json="$tmp_dir/dry-run.json"
pre_backup_json="$tmp_dir/pre-backup.json"
import_json="$tmp_dir/import.json"
drain_json="$tmp_dir/drain.json"
stats_json="$tmp_dir/stats.json"
search_json="$tmp_dir/search.json"
context_json="$tmp_dir/context.json"
post_backup_json="$tmp_dir/post-backup.json"
verify_json="$tmp_dir/verify.json"
replay_json="$tmp_dir/replay.json"

echo "Rehearsing frozen recovery import in disposable roots under $tmp_dir" >&2

# Phase 1: dry-run verifies hashes and exact accounting with no writes.
echo "Phase 1: dry-run verification" >&2
agentbrain_json recovery import \
  --manifest-generation "$generation" \
  --artifact-root "$artifact_root" \
  --dry-run >"$dry_json"
assert_field "$dry_json" "status" "verified"
assert_field "$dry_json" "counts.candidate_rows" "1088"
assert_field "$dry_json" "counts.telegram_observations" "294"
assert_field "$dry_json" "counts.catalog_memberships" "584"
assert_field "$dry_json" "counts.approved_offline_artifacts" "581"
assert_field "$dry_json" "jobs.queued" "581"
assert_field "$dry_json" "jobs.blocked" "11"
assert_field "$dry_json" "jobs.excluded" "37"
assert_field "$dry_json" "jobs.evidence_only" "459"
if [ -e "$db_path" ]; then
  echo "dry-run wrote a database; expected none" >&2
  exit 1
fi
assert_absent "$sentinel"

# Materialize the empty database and capture the verified pre-import snapshot.
echo "Phase 1: pre-import snapshot" >&2
agentbrain_json worker --once --worker-id rehearsal-migrate >/dev/null
agentbrain_json backup create --output "$tmp_dir/pre-import-snapshot" >"$pre_backup_json"

# Phase 2: admit into the disposable database.
echo "Phase 2: admission" >&2
agentbrain_json recovery import \
  --manifest-generation "$generation" \
  --artifact-root "$artifact_root" \
  --authorize-offline >"$import_json"
assert_field "$import_json" "status" "queued"
assert_field "$import_json" "jobs.created" "629"
assert_field "$import_json" "effects.candidate_outcomes_created" "1088"
assert_field "$import_json" "effects.observations_created" "294"
assert_field "$import_json" "run.operator_controlled" "true"
assert_field "$import_json" "run.expected_job_count" "581"

offline_run_id="$(bun -e '
const data = JSON.parse(await Bun.file(process.argv[1]).text()).data;
process.stdout.write(String(data.run.id));
' "$import_json")"
authorization_digest="$(bun -e '
const data = JSON.parse(await Bun.file(process.argv[1]).text()).data;
process.stdout.write(String(data.run.authorization_digest));
' "$import_json")"

# Phase 2: drain only the 581 offline jobs; approved-online jobs stay blocked.
echo "Phase 2: offline worker drain" >&2
agentbrain_json worker --once --worker-id rehearsal-drain \
  --run "$offline_run_id" \
  --authorization-digest "$authorization_digest" \
  --allowed-kind recovery_offline >"$drain_json"
assert_field "$drain_json" "claimed" "581"
assert_field "$drain_json" "completed" "581"
assert_field "$drain_json" "failed" "0"
assert_absent "$sentinel"

agentbrain_json jobs stats >"$stats_json"
assert_field "$stats_json" "by_state.completed" "581"
assert_field "$stats_json" "by_state.blocked" "11"
assert_field "$stats_json" "by_state.queued" "0"
assert_field "$stats_json" "runnable_due" "0"

# Phase 3: retrieval and citations across restored resources.
echo "Phase 3: retrieval, restore, replay" >&2
agentbrain_json search --query "the" --collection legacy-links --limit 5 \
  >"$search_json"
agentbrain_json context "the" --limit 3 >"$context_json"
bun -e '
const search = JSON.parse(await Bun.file(process.argv[1]).text());
const context = JSON.parse(await Bun.file(process.argv[2]).text());
if ((search?.data?.results ?? []).length === 0) throw new Error("no FTS results after import");
const hits = context?.data?.hits ?? [];
if (hits.length === 0 || !hits[0].citation) throw new Error("context returned no citation");
' "$search_json" "$context_json"

# Phase 3: verified post-import snapshot restores in isolation.
agentbrain_json backup create --output "$tmp_dir/post-import-snapshot" \
  >"$post_backup_json"
agentbrain_json backup verify --backup "$tmp_dir/post-import-snapshot" \
  >"$verify_json"
assert_field "$verify_json" "verified" "true"

# Phase 3: idempotent replay creates no new work.
agentbrain_json recovery import \
  --manifest-generation "$generation" \
  --artifact-root "$artifact_root" \
  --authorize-offline >"$replay_json"
assert_field "$replay_json" "jobs.created" "0"
assert_field "$replay_json" "jobs.existing" "629"
assert_field "$replay_json" "effects.candidate_outcomes_existing" "1088"

assert_absent "$sentinel"

# Emit a sanitized, aggregate-only summary: counts, opaque IDs, and hashes.
bun -e '
const imported = JSON.parse(await Bun.file(process.argv[1]).text()).data;
const drain = JSON.parse(await Bun.file(process.argv[2]).text()).data;
const stats = JSON.parse(await Bun.file(process.argv[3]).text()).data;
const preBackup = JSON.parse(await Bun.file(process.argv[4]).text()).data;
const postBackup = JSON.parse(await Bun.file(process.argv[5]).text()).data;
const verify = JSON.parse(await Bun.file(process.argv[6]).text()).data;
const summary = {
  schema_version: 1,
  rehearsal: "legacy_recovery_import",
  network_fetches: 0,
  generation_id: imported.generation_id,
  counts: imported.counts,
  dispositions: imported.dispositions,
  jobs: {
    created: imported.jobs.created,
    completed_offline: drain.completed,
    failed: drain.failed,
    blocked: stats.by_state.blocked,
    excluded: stats.by_state.excluded,
    runnable_remaining: stats.runnable_due,
  },
  snapshots: {
    pre_import_schema_version: preBackup.schema_version,
    pre_import_database_sha256: preBackup.database_sha256,
    post_import_schema_version: postBackup.schema_version,
    post_import_database_sha256: postBackup.database_sha256,
    post_import_required_artifacts: postBackup.artifact_count,
    restore_verified: verify.verified,
  },
};
console.log(JSON.stringify(summary, null, 2));
' "$import_json" "$drain_json" "$stats_json" "$pre_backup_json" "$post_backup_json" "$verify_json"

echo "Rehearsal passed: 581 offline completions, two blocked approved-online jobs, zero network calls." >&2
