#!/usr/bin/env bash
set -euo pipefail

url="${1:-https://example.com/}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/agentbrain-scrapectl-smoke.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

db_path="$tmp_dir/research.db"

if ! command -v scrapectl >/dev/null 2>&1; then
  echo "scrapectl is not on PATH; start/install the provider before running this opt-in smoke" >&2
  exit 127
fi

echo "Using temporary Agentbrain DB: $db_path" >&2
echo "Smoking URL through Scrapectl provider: $url" >&2
bun "$repo_root/src/cli.ts" --db "$db_path" ingest "$url" --source-type url --json
