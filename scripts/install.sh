#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--install|--uninstall|--help]

Install creates the agentbrain command. Agentbrain owns the durable SQLite
queue and index; the worker leases admitted ingestion jobs from that queue.
The installer does not create or enable recurring remote sources. It uses
~/.local/share/agentbrain/research.db.

The three services that run this code — agentbrain.worker, agentbrain.doctor,
and the opt-in agentbrain.share ingress — are installed by Agentdots, which
owns every fleet launch agent:

  ~/code/agentdots/scripts/install-launchagents --install

Their configuration moved with them and is now read from AGENTDOTS_INSTALL_*:
SHARE_HOST names the tailnet address that exposes the ingress (ADR 0017 admits
no configuration in which it is exposed by default, so an unset value installs
no listener), and CONDUIT_SOCKET and CONDUIT_TOKEN_FILE are passed through to
the worker's environment for Agentscrape, which owns every fetch. Agentbrain
interprets none of them and holds no credential of its own.

Uninstall removes only the known command links. It preserves the database,
Artifacts, and the private worker and share logs, and leaves the services to
Agentdots.
EOF
}

ACTION=install
case "${1:-}" in
  ""|--install) ;;
  --uninstall) ACTION=uninstall ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
if (( $# > 1 )); then
  usage >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BIN_DIR="${AGENTBRAIN_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${AGENTBRAIN_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentbrain}"
DATA_DIR="$HOME/.local/share/agentbrain"
DEFAULT_DB_PATH="$DATA_DIR/research.db"
AGENTBRAIN_SOURCE="$ROOT/src/cli.ts"
LOG_PATH="$STATE_DIR/worker.log"
DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
# The launch agents that supervise this code belong to Agentdots, which
# owns every fleet service (~/code/agentdots/config/launchd/). This
# installer ships the CLI; giving one service two owners would have them
# race to render it.

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

symlink_is_owned() {
  local destination="$1"
  local expected="$2"
  local target candidate
  [[ -L "$destination" ]] || return 1
  target="$(readlink "$destination")"
  if [[ "$target" = /* ]]; then
    candidate="$target"
  else
    candidate="$(dirname "$destination")/$target"
  fi
  [[ "$(canonical_path "$candidate")" == "$expected" ]]
}

check_destination() {
  local destination="$1"
  local expected="$2"
  local known_managed="${3:-}"

  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  fi
  if [[ ! -L "$destination" ]]; then
    echo "refusing to overwrite non-symlink: $destination" >&2
    return 1
  fi
  if symlink_is_owned "$destination" "$expected"; then
    return 0
  fi
  if [[ -n "$known_managed" ]] && symlink_is_owned "$destination" "$known_managed"; then
    return 0
  fi

  echo "refusing to overwrite unrelated symlink: $destination -> $(readlink "$destination")" >&2
  return 1
}

check_private_paths() {
  if [[ -L "$STATE_DIR" || ( -e "$STATE_DIR" && ! -d "$STATE_DIR" ) ]]; then
    echo "refusing unsafe state directory: $STATE_DIR" >&2
    return 1
  fi
  if [[ -L "$LOG_PATH" || ( -e "$LOG_PATH" && ! -f "$LOG_PATH" ) ]]; then
    echo "refusing unsafe worker log: $LOG_PATH" >&2
    return 1
  fi
  if [[ -L "$DEPLOYED_SHA_PATH" || ( -e "$DEPLOYED_SHA_PATH" && ! -f "$DEPLOYED_SHA_PATH" ) ]]; then
    echo "refusing unsafe deployment receipt: $DEPLOYED_SHA_PATH" >&2
    return 1
  fi
}

check_database_location() {
  local target_exists=false
  [[ -e "$DEFAULT_DB_PATH" || -L "$DEFAULT_DB_PATH" ]] && target_exists=true

  if [[ -e "$DATA_DIR" || -L "$DATA_DIR" ]]; then
    if [[ -L "$DATA_DIR" || ! -d "$DATA_DIR" ]]; then
      echo "refusing non-directory or symlinked Agentbrain data root: $DATA_DIR" >&2
      return 1
    fi
  fi
  if [[ "$target_exists" == true && ( -L "$DEFAULT_DB_PATH" || ! -f "$DEFAULT_DB_PATH" ) ]]; then
    echo "refusing non-regular or symlinked Agentbrain database: $DEFAULT_DB_PATH" >&2
    return 1
  fi
}

previous_managed_agentbrain_source() {
  local target_root previous_sha previous_checkout candidate
  local current_origin previous_origin previous_status receipt_size

  [[ "$(basename "$ROOT")" == "$DEPLOYED_SHA" ]] || return 1
  target_root="$(dirname "$ROOT")"
  [[ "$(basename "$target_root")" == agentbrain ]] || return 1
  [[ -f "$DEPLOYED_SHA_PATH" && ! -L "$DEPLOYED_SHA_PATH" ]] || return 1

  receipt_size="$(wc -c <"$DEPLOYED_SHA_PATH")"
  [[ "$receipt_size" -eq 41 ]] || return 1
  IFS= read -r previous_sha <"$DEPLOYED_SHA_PATH" || return 1
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$previous_sha" != "$DEPLOYED_SHA" ]] || return 1

  previous_checkout="$target_root/$previous_sha"
  candidate="$previous_checkout/src/cli.ts"
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(git -C "$previous_checkout" rev-parse HEAD 2>/dev/null)" == "$previous_sha" ]] || return 1
  current_origin="$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null)" || return 1
  previous_origin="$(git -C "$previous_checkout" config --get remote.origin.url 2>/dev/null)" || return 1
  [[ -n "$current_origin" && "$previous_origin" == "$current_origin" ]] || return 1
  previous_status="$(git -C "$previous_checkout" status --porcelain --untracked-files=all 2>/dev/null)" || return 1
  [[ -z "$previous_status" ]] || return 1

  canonical_path "$candidate"
}

write_deployed_sha() {
  local temporary
  check_private_paths
  temporary="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s\n' "$DEPLOYED_SHA" >"$temporary"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$temporary" <<'PY'
import os
import sys
with open(sys.argv[1], "rb") as receipt:
    os.fsync(receipt.fileno())
PY
  fi
  mv -f "$temporary" "$DEPLOYED_SHA_PATH"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$STATE_DIR" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
except OSError:
    pass
finally:
    os.close(fd)
PY
  fi
}

preflight_owned_removal() {
  local destination="$1"
  local expected="$2"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  fi
  if symlink_is_owned "$destination" "$expected"; then
    return 0
  fi
  echo "refusing to remove foreign command: $destination" >&2
  return 1
}

if [[ "$ACTION" == uninstall ]]; then
  preflight_owned_removal "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL"

  if symlink_is_owned "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL"; then
    rm -f "$BIN_DIR/agentbrain"
  fi
  printf 'uninstalled owned Agentbrain commands\n'
  exit 0
fi

check_database_location

DEPLOYED_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [[ ! "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source HEAD is not a full lowercase 40-hex SHA" >&2
  exit 1
fi

check_private_paths
PREVIOUS_MANAGED_AGENTBRAIN_CANONICAL="$(previous_managed_agentbrain_source || true)"
check_destination \
  "$BIN_DIR/agentbrain" \
  "$AGENTBRAIN_CANONICAL" \
  "$PREVIOUS_MANAGED_AGENTBRAIN_CANONICAL"
(
  cd "$ROOT"
  bun install --frozen-lockfile
)

mkdir -p "$BIN_DIR" "$STATE_DIR" "$DATA_DIR"
chmod 700 "$STATE_DIR" "$DATA_DIR"
if [[ -e "$DEFAULT_DB_PATH" ]]; then
  chmod 600 "$DEFAULT_DB_PATH"
fi
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"
chmod +x "$AGENTBRAIN_SOURCE"

ln -sfn "$AGENTBRAIN_SOURCE" "$BIN_DIR/agentbrain"
write_deployed_sha
printf 'installed %s -> %s\n' "$BIN_DIR/agentbrain" "$AGENTBRAIN_SOURCE"
printf 'the agentbrain services are installed by Agentdots: %s\n' \
  "$HOME/code/agentdots/scripts/install-launchagents --install"
