#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--install|--uninstall|--help]

Install creates the agentbrain command plus one owned user LaunchAgent for
`agentbrain worker`. Agentbrain owns the durable SQLite queue and index; the
worker leases admitted ingestion jobs from that queue.
The installer does not create or enable recurring remote sources.

Uninstall gracefully unloads and removes only the owned LaunchAgent and known
command links. It preserves the database, Artifacts, and private worker log.
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
LAUNCH_AGENTS_DIR="${AGENTBRAIN_INSTALL_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
STATE_DIR="${AGENTBRAIN_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agentbrain}"
AGENTBRAIN_SOURCE="$ROOT/src/cli.ts"
KNOWN_LEGACY_AGENTBRAIN_SOURCE="${AGENTBRAIN_INSTALL_LEGACY_SOURCE:-/Users/mike/code/agentbrain/src/cli.ts}"
RETIRED_ADAPTER_SOURCE="$ROOT/src/research-ingest-link.ts"
PLIST_SOURCE="$ROOT/system/Library/LaunchAgents/agentbrain.worker.plist"
SERVICE_DEST="$LAUNCH_AGENTS_DIR/agentbrain.worker.plist"
LOG_PATH="$STATE_DIR/worker.log"
DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
SERVICE_LABEL="agentbrain.worker"
OWNERSHIP_MARKER="agentbrain-installer-owned: agentbrain.worker.v1"
EXPECTED_LEGACY_SOURCE="$(dirname "$ROOT")/hermes-greybird/bin/research-ingest-link"
LAUNCHCTL="${AGENTBRAIN_INSTALL_LAUNCHCTL:-launchctl}"

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
KNOWN_LEGACY_AGENTBRAIN_CANONICAL="$(canonical_path "$KNOWN_LEGACY_AGENTBRAIN_SOURCE")"
RETIRED_ADAPTER_CANONICAL="$(canonical_path "$RETIRED_ADAPTER_SOURCE")"
LEGACY_CANONICAL="$(canonical_path "$EXPECTED_LEGACY_SOURCE")"

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
  local known_legacy="${3:-}"

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
  if [[ -n "$known_legacy" ]] && symlink_is_owned "$destination" "$known_legacy"; then
    return 0
  fi

  echo "refusing to overwrite unrelated symlink: $destination -> $(readlink "$destination")" >&2
  return 1
}

remove_known_retired_link() {
  local destination="$BIN_DIR/research-ingest-link"
  if symlink_is_owned "$destination" "$RETIRED_ADAPTER_CANONICAL" ||
    symlink_is_owned "$destination" "$LEGACY_CANONICAL"; then
    rm -f "$destination"
  fi
}

service_is_owned() {
  [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] &&
    grep -Fq "$OWNERSHIP_MARKER" "$SERVICE_DEST" &&
    grep -Fq '<string>agentbrain.worker</string>' "$SERVICE_DEST"
}

check_service_destination() {
  if [[ ! -e "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]]; then
    return 0
  fi
  if service_is_owned; then
    return 0
  fi
  echo "refusing to overwrite foreign service: $SERVICE_DEST" >&2
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

launchctl_available() {
  [[ "$LAUNCHCTL" != none ]] && command -v "$LAUNCHCTL" >/dev/null 2>&1
}

LOADED_SERVICE_STATE=absent
inspect_loaded_service() {
  LOADED_SERVICE_STATE=absent
  launchctl_available || return 0
  local description line
  description="$("$LAUNCHCTL" print "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null)" || return 0
  LOADED_SERVICE_STATE=foreign
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == "program = $BIN_DIR/agentbrain" ]]; then
      LOADED_SERVICE_STATE=owned
      return 0
    fi
  done <<<"$description"
}

check_loaded_service() {
  inspect_loaded_service
  if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
    echo "refusing to unload foreign service: $SERVICE_LABEL" >&2
    return 1
  fi
}

unload_owned_service() {
  launchctl_available || return 0
  local target
  target="gui/$(id -u)/$SERVICE_LABEL"
  if "$LAUNCHCTL" bootout "$target" >/dev/null 2>&1; then
    LOADED_SERVICE_STATE=absent
    return 0
  fi

  inspect_loaded_service
  if [[ "$LOADED_SERVICE_STATE" == absent ]]; then
    return 0
  fi
  if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
    echo "refusing to unload foreign service after bootout race: $SERVICE_LABEL" >&2
  else
    echo "failed to unload owned service: $SERVICE_LABEL" >&2
  fi
  return 1
}

preflight_owned_removal() {
  local destination="$1"
  local expected="$2"
  local known_legacy="${3:-}"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  fi
  if symlink_is_owned "$destination" "$expected"; then
    return 0
  fi
  if [[ -n "$known_legacy" ]] && symlink_is_owned "$destination" "$known_legacy"; then
    return 0
  fi
  echo "refusing to remove foreign command: $destination" >&2
  return 1
}

if [[ "$ACTION" == uninstall ]]; then
  preflight_owned_removal "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL"
  check_service_destination
  check_loaded_service

  if service_is_owned || [[ "$LOADED_SERVICE_STATE" == owned ]]; then
    unload_owned_service
  fi
  if service_is_owned; then
    rm -f "$SERVICE_DEST"
  fi
  if symlink_is_owned "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" ||
    symlink_is_owned "$BIN_DIR/agentbrain" "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL"; then
    rm -f "$BIN_DIR/agentbrain"
  fi
  remove_known_retired_link
  printf 'uninstalled owned Agentbrain commands and service\n'
  exit 0
fi

DEPLOYED_SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [[ ! "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source HEAD is not a full lowercase 40-hex SHA" >&2
  exit 1
fi

check_destination "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL"
check_service_destination
check_private_paths
check_loaded_service

(
  cd "$ROOT"
  bun install --frozen-lockfile
)

mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR"
chmod 700 "$STATE_DIR"
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"
chmod +x "$AGENTBRAIN_SOURCE"

BUN_BIN="$(command -v bun)"
SERVICE_PATH="$(dirname "$BUN_BIN"):$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TEMP_PLIST="$(mktemp "$LAUNCH_AGENTS_DIR/.agentbrain.worker.plist.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT
export AGENTBRAIN_RENDER_PROGRAM="$BIN_DIR/agentbrain"
export AGENTBRAIN_RENDER_HOME="$HOME"
export AGENTBRAIN_RENDER_PATH="$SERVICE_PATH"
export AGENTBRAIN_RENDER_LOG="$LOG_PATH"
# The single-quoted argument intentionally contains JavaScript template literals.
# shellcheck disable=SC2016
bun -e '
  const [source, destination] = Bun.argv.slice(-2);
  const escapeXml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("\u0027", "&apos;");
  const replacements = {
    __AGENTBRAIN_PROGRAM__: process.env.AGENTBRAIN_RENDER_PROGRAM,
    __AGENTBRAIN_HOME__: process.env.AGENTBRAIN_RENDER_HOME,
    __AGENTBRAIN_PATH__: process.env.AGENTBRAIN_RENDER_PATH,
    __AGENTBRAIN_LOG__: process.env.AGENTBRAIN_RENDER_LOG,
  };
  let rendered = await Bun.file(source).text();
  for (const [token, value] of Object.entries(replacements)) {
    if (value === undefined) throw new Error(`missing render value for ${token}`);
    rendered = rendered.replaceAll(token, escapeXml(value));
  }
  if (rendered.includes("__AGENTBRAIN_")) throw new Error("unrendered plist token");
  await Bun.write(destination, rendered);
' "$PLIST_SOURCE" "$TEMP_PLIST"
chmod 600 "$TEMP_PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TEMP_PLIST" >/dev/null
fi

if service_is_owned || [[ "$LOADED_SERVICE_STATE" == owned ]]; then
  unload_owned_service
fi
mv -f "$TEMP_PLIST" "$SERVICE_DEST"
trap - EXIT
remove_known_retired_link
ln -sfn "$AGENTBRAIN_SOURCE" "$BIN_DIR/agentbrain"

if launchctl_available; then
  "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$SERVICE_DEST"
  inspect_loaded_service
  if [[ "$LOADED_SERVICE_STATE" != owned ]]; then
    echo "loaded service failed ownership verification: $SERVICE_LABEL" >&2
    exit 1
  fi
  write_deployed_sha
  printf 'installed and loaded %s\n' "$SERVICE_DEST"
else
  printf 'installed %s (launchctl unavailable; service not loaded)\n' "$SERVICE_DEST"
fi
printf 'installed %s -> %s\n' "$BIN_DIR/agentbrain" "$AGENTBRAIN_SOURCE"
