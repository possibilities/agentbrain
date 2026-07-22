#!/usr/bin/env bash
set -euo pipefail

# Opt-in, temporary-state smoke for recurring Source activation. It applies the
# bundled manifest plus the activation overlay to a throwaway database, then
# drives one confirmed blog and one confirmed X account through the durable
# schedule -> discovery -> checkpoint loop and checks the operational contract:
# runs are recorded and inspectable, repeated overlap indexes nothing new,
# absence deletes nothing, and pause immediately blocks admission. It never
# touches the configured production database or Artifact store.
#
# Bring Agentscrape and any required browser farm / X session up first. Live
# discovery may legitimately yield zero items or a classified failure; the smoke
# still passes when the durable ledger behaves, and prints per-source status so
# the operator can judge provider health.

blog_id="${1:-blog.simon-willison}"
x_id="${2:-x.simonw}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
overlay_path="$repo_root/config/sources.activation.yaml"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentbrain-recurring-sources-smoke.XXXXXX")"
db_path="$tmp_dir/research.db"
home_dir="$tmp_dir/home"
data_home="$tmp_dir/data"

cleanup() {
  local status=$?
  if [ "$status" -eq 0 ]; then
    rm -rf "$tmp_dir"
  else
    echo "Smoke failed; temporary evidence preserved at $tmp_dir" >&2
    if [ -f "$db_path" ]; then
      HOME="$home_dir" XDG_DATA_HOME="$data_home" \
        bun "$repo_root/src/cli.ts" --db "$db_path" --json sources status >&2 || true
      HOME="$home_dir" XDG_DATA_HOME="$data_home" \
        bun "$repo_root/src/cli.ts" --db "$db_path" --json jobs list >&2 || true
    fi
  fi
}
trap cleanup EXIT

if ! command -v agentscrape >/dev/null 2>&1; then
  echo "agentscrape is not on PATH; bring the URL extractor and browser farm up before running this opt-in smoke" >&2
  exit 127
fi

mkdir -p "$home_dir" "$data_home"

agentbrain_json() {
  HOME="$home_dir" XDG_DATA_HOME="$data_home" \
    bun "$repo_root/src/cli.ts" --db "$db_path" --json "$@"
}

json_field() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
let value = payload;
for (const part of process.argv[2].split(".")) value = value?.[part];
if (value === undefined || value === null) process.exit(1);
console.log(typeof value === "object" ? JSON.stringify(value) : value);
' "$1" "$2"
}

db_scalar() {
  bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1], { readonly: true, strict: true });
try {
  const row = db.query(process.argv[2]).get();
  const value = row ? Object.values(row)[0] : 0;
  console.log(value ?? 0);
} finally {
  db.close();
}
' "$db_path" "$1"
}

require_enabled() {
  local source_id="$1"
  local show_json="$tmp_dir/show-${source_id}.json"
  agentbrain_json sources show "$source_id" >"$show_json"
  if [ "$(json_field "$show_json" "data.enabled")" != "true" ]; then
    echo "expected $source_id to be enabled after applying the activation overlay" >&2
    exit 1
  fi
  if [ "$(json_field "$show_json" "data.executable")" != "true" ]; then
    echo "expected $source_id to be an executable source kind" >&2
    exit 1
  fi
}

require_queued() {
  local source_id="$1"
  local sync_json="$tmp_dir/sync-${source_id}.json"
  agentbrain_json sources sync "$source_id" >"$sync_json"
  local status
  status="$(json_field "$sync_json" "data.0.status")"
  if [ "$status" != "queued" ]; then
    echo "expected sync of $source_id to queue a run, got '$status'" >&2
    exit 1
  fi
}

drain_worker() {
  # A source_sync job discovers items and fans out url jobs; those url jobs are
  # materialized on a later pass. Three bounded passes drain discovery and the
  # fanned-out extraction without looping forever.
  local pass
  for pass in 1 2 3; do
    agentbrain_json worker --once --worker-id smoke-recurring-sources \
      >"$tmp_dir/worker-${pass}.json"
  done
}

require_processed_run() {
  local source_id="$1"
  local runs
  runs="$(db_scalar "SELECT COUNT(*) AS c FROM runs r JOIN sources s ON s.id=r.source_id WHERE s.identifier='${source_id}' AND r.run_type='source_sync'")"
  if [ "$runs" -lt 1 ]; then
    echo "expected a durable source_sync run for $source_id" >&2
    exit 1
  fi
  local unclaimed
  unclaimed="$(db_scalar "SELECT COUNT(*) AS c FROM jobs j JOIN runs r ON r.id=j.run_id JOIN sources s ON s.id=r.source_id WHERE s.identifier='${source_id}' AND j.kind='source_sync' AND j.state='queued'")"
  if [ "$unclaimed" -ne 0 ]; then
    echo "expected the worker to claim $source_id's source_sync job, but it is still queued" >&2
    exit 1
  fi
  echo "Durable status for $source_id:" >&2
  agentbrain_json sources status "$source_id" >&2
}

require_pause_blocks_admission() {
  local source_id="$1"
  local paused_sync_json="$tmp_dir/paused-sync-${source_id}.json"
  agentbrain_json sources pause "$source_id" --reason "smoke pause control" \
    >"$tmp_dir/pause-${source_id}.json"
  agentbrain_json sources sync "$source_id" >"$paused_sync_json"
  local paused_status
  paused_status="$(json_field "$paused_sync_json" "data.0.status")"
  if [ "$paused_status" != "paused" ]; then
    echo "expected admission for $source_id to be blocked while paused, got '$paused_status'" >&2
    exit 1
  fi
  agentbrain_json sources resume "$source_id" >"$tmp_dir/resume-${source_id}.json"
}

echo "Using temporary Agentbrain DB: $db_path" >&2
echo "Applying bundled manifest + activation overlay: $overlay_path" >&2
agentbrain_json sources apply --overlay "$overlay_path" \
  --reason "recurring-sources smoke" >"$tmp_dir/apply.json"

require_enabled "$blog_id"
require_enabled "$x_id"

echo "Scheduling first runs for $blog_id and $x_id" >&2
require_queued "$blog_id"
require_queued "$x_id"
drain_worker
require_processed_run "$blog_id"
require_processed_run "$x_id"

docs_first="$(db_scalar "SELECT COUNT(*) AS c FROM documents")"
resources_first="$(db_scalar "SELECT COUNT(*) AS c FROM resources")"

echo "Re-observing the same windows to prove overlap is idempotent" >&2
require_queued "$blog_id"
require_queued "$x_id"
drain_worker
docs_overlap="$(db_scalar "SELECT COUNT(*) AS c FROM documents")"
resources_overlap="$(db_scalar "SELECT COUNT(*) AS c FROM resources")"

if [ "$docs_overlap" -ne "$docs_first" ] || [ "$resources_overlap" -ne "$resources_first" ]; then
  echo "overlap changed the index: documents $docs_first->$docs_overlap, resources $resources_first->$resources_overlap" >&2
  exit 1
fi

echo "Verifying pause immediately blocks admission" >&2
require_pause_blocks_admission "$blog_id"
require_pause_blocks_admission "$x_id"

echo "Smoke passed: $blog_id and $x_id recorded durable runs; overlap indexed nothing new (documents=$docs_first, resources=$resources_first); pause blocked and resumed admission." >&2
