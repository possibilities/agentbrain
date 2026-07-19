#!/usr/bin/env bash
set -euo pipefail

url="${1:-https://example.com/}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentbrain-scrapectl-smoke.XXXXXX")"
db_path="$tmp_dir/brain.db"
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
        bun "$repo_root/src/cli.ts" --db "$db_path" --json jobs list >&2 || true
    fi
  fi
}
trap cleanup EXIT

if ! command -v scrapectl >/dev/null 2>&1; then
  echo "scrapectl is not on PATH; start/install the URL extractor before running this opt-in smoke" >&2
  exit 127
fi

mkdir -p "$home_dir" "$data_home"

agentbrain_json() {
  HOME="$home_dir" XDG_DATA_HOME="$data_home" \
    bun "$repo_root/src/cli.ts" --db "$db_path" --json "$@"
}

json_read() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
let value = payload;
for (const part of process.argv[2].split(".")) value = value?.[part];
if (value === undefined || value === null) process.exit(1);
console.log(value);
' "$1" "$2"
}

require_completed_job() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
const state = payload?.data?.state;
if (state !== "completed") {
  throw new Error("expected submitted job to complete, got " + (state ?? "missing state"));
}
' "$1"
}

select_root_document() {
  bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1], { readonly: true, strict: true });
try {
  const row = db.query(`
    SELECT r.document_id AS document_id
    FROM jobs j
    JOIN resources r ON r.id = j.resource_id
    WHERE j.id = ? AND r.document_id IS NOT NULL
  `).get(Number(process.argv[2]));
  if (!row?.document_id) throw new Error("submitted job did not materialize a searchable document");
  console.log(row.document_id);
} finally {
  db.close();
}
' "$db_path" "$1"
}

select_search_term() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
const data = payload?.data ?? {};
const text = String(data.title ?? "") + "\n" + String(data.content ?? "");
const terms = text.match(/[\p{L}\p{N}_-]{4,}/gu) ?? [];
const term = terms.find((candidate) => !/^https?$/i.test(candidate));
if (!term) throw new Error("materialized document has no searchable term");
console.log(term);
' "$1"
}

require_search_hit() {
  bun -e '
const payload = JSON.parse(await Bun.file(process.argv[1]).text());
const documentId = Number(process.argv[2]);
const results = payload?.data?.results ?? [];
if (!results.some((row) => row.document_id === documentId)) {
  throw new Error("search did not return materialized document " + documentId);
}
' "$1" "$2"
}

submit_json="$tmp_dir/submit.json"
worker_json="$tmp_dir/worker.json"
job_json="$tmp_dir/job.json"
get_json="$tmp_dir/get.json"
search_json="$tmp_dir/search.json"

echo "Using temporary Agentbrain DB: $db_path" >&2
echo "Submitting queued URL ingestion job: $url" >&2
agentbrain_json submit "$url" --kind url --ingress smoke-scrapectl >"$submit_json"
job_id="$(json_read "$submit_json" "data.job_id")"

echo "Draining temporary queue through the Agentbrain worker (job $job_id)" >&2
agentbrain_json worker --once --worker-id smoke-scrapectl >"$worker_json"
agentbrain_json jobs show "$job_id" >"$job_json"
require_completed_job "$job_json"

document_id="$(select_root_document "$job_id")"
agentbrain_json get --document-id "$document_id" --full >"$get_json"
query="$(select_search_term "$get_json")"
agentbrain_json search --query "$query" --limit 5 >"$search_json"
require_search_hit "$search_json" "$document_id"

echo "Smoke passed: job $job_id materialized document $document_id and search found '$query'." >&2
