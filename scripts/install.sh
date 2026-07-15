#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${AGENTBRAIN_INSTALL_BIN_DIR:-$HOME/.local/bin}"
AGENTBRAIN_SOURCE="$ROOT/src/cli.ts"
ADAPTER_SOURCE="$ROOT/src/research-ingest-link.ts"
EXPECTED_LEGACY_SOURCE="$(dirname "$ROOT")/hermes-greybird/bin/research-ingest-link"

canonical_path() {
  bun -e '
    import { existsSync, realpathSync } from "node:fs";
    import { basename, dirname, resolve } from "node:path";
    let current = resolve(Bun.argv.at(-1));
    const suffix = [];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) break;
      suffix.unshift(basename(current));
      current = parent;
    }
    const base = existsSync(current) ? realpathSync(current) : current;
    console.log(resolve(base, ...suffix));
  ' "$1"
}

AGENTBRAIN_CANONICAL="$(canonical_path "$AGENTBRAIN_SOURCE")"
ADAPTER_CANONICAL="$(canonical_path "$ADAPTER_SOURCE")"
LEGACY_CANONICAL="$(canonical_path "$EXPECTED_LEGACY_SOURCE")"

check_destination() {
  local destination="$1"
  local expected="$2"
  local allow_legacy="$3"

  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  fi
  if [[ ! -L "$destination" ]]; then
    echo "refusing to overwrite non-symlink: $destination" >&2
    return 1
  fi

  local target candidate canonical
  target="$(readlink "$destination")"
  if [[ "$target" = /* ]]; then
    candidate="$target"
  else
    candidate="$(dirname "$destination")/$target"
  fi
  canonical="$(canonical_path "$candidate")"
  if [[ "$canonical" == "$expected" ]]; then
    return 0
  fi
  if [[ "$allow_legacy" == "yes" && "$canonical" == "$LEGACY_CANONICAL" ]]; then
    return 0
  fi

  echo "refusing to overwrite unrelated symlink: $destination -> $target" >&2
  return 1
}

mkdir -p "$BIN_DIR"

# Preflight both destinations so a refusal cannot leave a half-installed pair.
check_destination "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" no
check_destination "$BIN_DIR/research-ingest-link" "$ADAPTER_CANONICAL" yes

chmod +x "$AGENTBRAIN_SOURCE" "$ADAPTER_SOURCE"
ln -sfn "$AGENTBRAIN_SOURCE" "$BIN_DIR/agentbrain"
ln -sfn "$ADAPTER_SOURCE" "$BIN_DIR/research-ingest-link"

printf 'installed %s -> %s\n' "$BIN_DIR/agentbrain" "$AGENTBRAIN_SOURCE"
printf 'installed %s -> %s\n' "$BIN_DIR/research-ingest-link" "$ADAPTER_SOURCE"
