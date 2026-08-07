#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--install|--uninstall|--help]

Install creates the agentbrain command plus one owned user LaunchAgent for
`agentbrain worker`. Agentbrain owns the durable SQLite queue and index; the
worker leases admitted ingestion jobs from that queue.
The installer does not create or enable recurring remote sources. It uses
~/.local/share/agentbrain/research.db and refuses unmigrated legacy DB state.

The share ingress is a second, opt-in service. Set

  AGENTBRAIN_INSTALL_SHARE_HOST=<tailnet-address>

to also own a LaunchAgent for `agentbrain share serve --host <address>`. ADR
0017 admits no configuration in which the ingress is exposed by default, so an
unset value installs no listener; naming the address is the operator's act of
exposing one. Set the value to `none` to remove an ingress installed earlier.
An unset value leaves an already-installed ingress alone rather than silently
withdrawing a service the operator asked for.

AGENTBRAIN_INSTALL_CONDUIT_SOCKET and AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE are
passed through to the worker's environment for Agentscrape, which owns every
fetch. They let it replay a browser session an operator established for a site
that requires signing in. Agentbrain does not interpret them, holds no
credential of its own for them, and extraction proceeds without a session when
they are unset.

Uninstall gracefully unloads and removes only the owned LaunchAgents and known
command links. It preserves the database, Artifacts, and the private worker and
share logs.
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
DATA_DIR="$HOME/.local/share/agentbrain"
DEFAULT_DB_PATH="$DATA_DIR/research.db"
LEGACY_DB_PATH="$HOME/.hermes/research-cache/research.db"
AGENTBRAIN_SOURCE="$ROOT/src/cli.ts"
KNOWN_LEGACY_AGENTBRAIN_SOURCE="${AGENTBRAIN_INSTALL_LEGACY_SOURCE:-/Users/mike/code/agentbrain/src/cli.ts}"
RETIRED_ADAPTER_SOURCE="$ROOT/src/research-ingest-link.ts"
PLIST_SOURCE="$ROOT/system/Library/LaunchAgents/agentbrain.worker.plist"
SERVICE_DEST="$LAUNCH_AGENTS_DIR/agentbrain.worker.plist"
LOG_PATH="$STATE_DIR/worker.log"
DEPLOYED_SHA_PATH="$STATE_DIR/deployed-sha"
SERVICE_LABEL="agentbrain.worker"
OWNERSHIP_MARKER="agentbrain-installer-owned: agentbrain.worker.v1"
SHARE_PLIST_SOURCE="$ROOT/system/Library/LaunchAgents/agentbrain.share.plist"
SHARE_SERVICE_DEST="$LAUNCH_AGENTS_DIR/agentbrain.share.plist"
SHARE_LOG_PATH="$STATE_DIR/share.log"
SHARE_SERVICE_LABEL="agentbrain.share"
SHARE_OWNERSHIP_MARKER="agentbrain-installer-owned: agentbrain.share.v1"
SHARE_HOST="${AGENTBRAIN_INSTALL_SHARE_HOST:-}"
# Reads one environment value out of the service already installed, so a
# reinstall that says nothing about the conduit keeps the one in use rather than
# silently blanking it. plutil is macOS-only and optional here: without it the
# value reads empty, which is the same answer as an unconfigured conduit.
installed_service_env() {
  local key="$1"
  [[ -f "$SERVICE_DEST" && ! -L "$SERVICE_DEST" ]] || return 0
  command -v plutil >/dev/null 2>&1 || return 0
  plutil -extract "EnvironmentVariables.$key" raw -o - "$SERVICE_DEST" 2>/dev/null ||
    true
}

# Unset preserves what is installed; set — including set to empty — is taken as
# given, so clearing the conduit stays possible and stays explicit.
if [[ -n "${AGENTBRAIN_INSTALL_CONDUIT_SOCKET+set}" ]]; then
  CONDUIT_SOCKET="$AGENTBRAIN_INSTALL_CONDUIT_SOCKET"
else
  CONDUIT_SOCKET="$(installed_service_env AGENTSCRAPE_CONDUIT_SOCKET)"
fi
if [[ -n "${AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE+set}" ]]; then
  CONDUIT_TOKEN_FILE="$AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE"
else
  CONDUIT_TOKEN_FILE="$(installed_service_env AGENTSCRAPE_CONDUIT_TOKEN_FILE)"
fi
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
  local known_managed="${4:-}"

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
  if [[ -n "$known_managed" ]] && symlink_is_owned "$destination" "$known_managed"; then
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

# Each owned service is identified by its own destination, marker, and label so
# the worker and the share ingress can never be mistaken for one another. The
# loaded-service check below cannot tell them apart by program — both run the
# same agentbrain command — so the label is the only discriminator.
service_is_owned() {
  local destination="$1" marker="$2" label="$3"
  [[ -f "$destination" && ! -L "$destination" ]] &&
    grep -Fq "$marker" "$destination" &&
    grep -Fq "<string>$label</string>" "$destination"
}

check_service_destination() {
  local destination="$1" marker="$2" label="$3"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    return 0
  fi
  if service_is_owned "$destination" "$marker" "$label"; then
    return 0
  fi
  echo "refusing to overwrite foreign service: $destination" >&2
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
  if [[ -L "$SHARE_LOG_PATH" || ( -e "$SHARE_LOG_PATH" && ! -f "$SHARE_LOG_PATH" ) ]]; then
    echo "refusing unsafe share log: $SHARE_LOG_PATH" >&2
    return 1
  fi
  if [[ -L "$DEPLOYED_SHA_PATH" || ( -e "$DEPLOYED_SHA_PATH" && ! -f "$DEPLOYED_SHA_PATH" ) ]]; then
    echo "refusing unsafe deployment receipt: $DEPLOYED_SHA_PATH" >&2
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

launchctl_available() {
  [[ "$LAUNCHCTL" != none ]] && command -v "$LAUNCHCTL" >/dev/null 2>&1
}

LOADED_SERVICE_STATE=absent
inspect_loaded_service() {
  local label="$1"
  LOADED_SERVICE_STATE=absent
  launchctl_available || return 0
  local description line
  description="$("$LAUNCHCTL" print "gui/$(id -u)/$label" 2>/dev/null)" || return 0
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
  local label="$1"
  inspect_loaded_service "$label"
  if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
    echo "refusing to unload foreign service: $label" >&2
    return 1
  fi
}

unload_owned_service() {
  local label="$1"
  launchctl_available || return 0
  local target
  target="gui/$(id -u)/$label"
  if "$LAUNCHCTL" bootout "$target" >/dev/null 2>&1; then
    for _ in {1..30}; do
      inspect_loaded_service "$label"
      if [[ "$LOADED_SERVICE_STATE" == absent ]]; then
        return 0
      fi
      if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
        echo "service identity changed while waiting for unload: $label" >&2
        return 1
      fi
      sleep 0.1
    done
    echo "service remained loaded after unload: $label" >&2
    return 1
  fi

  inspect_loaded_service "$label"
  if [[ "$LOADED_SERVICE_STATE" == absent ]]; then
    return 0
  fi
  if [[ "$LOADED_SERVICE_STATE" == foreign ]]; then
    echo "refusing to unload foreign service after bootout race: $label" >&2
  else
    echo "failed to unload owned service: $label" >&2
  fi
  return 1
}

check_database_location() {
  local target_exists=false
  local legacy_exists=false
  [[ -e "$DEFAULT_DB_PATH" || -L "$DEFAULT_DB_PATH" ]] && target_exists=true
  [[ -e "$LEGACY_DB_PATH" || -L "$LEGACY_DB_PATH" ]] && legacy_exists=true

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
  if [[ "$legacy_exists" == true && "$target_exists" == true ]]; then
    echo "refusing conflicting legacy and Agentbrain databases: $LEGACY_DB_PATH and $DEFAULT_DB_PATH" >&2
    return 1
  fi
  if [[ "$legacy_exists" == true ]]; then
    echo "legacy Agentbrain database requires migration: $LEGACY_DB_PATH -> $DEFAULT_DB_PATH" >&2
    return 1
  fi
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

# Withdraws the opt-in ingress. Unlike the worker, this is driven by the owned
# plist on disk rather than by the loaded state: the ingress may never have been
# installed at all, and probing launchd for a service the operator never asked
# for would be the installer inventing work.
remove_owned_share_service() {
  check_service_destination \
    "$SHARE_SERVICE_DEST" "$SHARE_OWNERSHIP_MARKER" "$SHARE_SERVICE_LABEL"
  if service_is_owned \
    "$SHARE_SERVICE_DEST" "$SHARE_OWNERSHIP_MARKER" "$SHARE_SERVICE_LABEL"; then
    check_loaded_service "$SHARE_SERVICE_LABEL"
    unload_owned_service "$SHARE_SERVICE_LABEL"
    rm -f "$SHARE_SERVICE_DEST"
    return 0
  fi
  return 1
}

if [[ "$ACTION" == uninstall ]]; then
  preflight_owned_removal "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL"
  check_service_destination "$SERVICE_DEST" "$OWNERSHIP_MARKER" "$SERVICE_LABEL"
  check_loaded_service "$SERVICE_LABEL"

  remove_owned_share_service || true

  # remove_owned_share_service leaves LOADED_SERVICE_STATE describing the
  # ingress, so the worker's state has to be read again before it decides.
  inspect_loaded_service "$SERVICE_LABEL"
  if service_is_owned "$SERVICE_DEST" "$OWNERSHIP_MARKER" "$SERVICE_LABEL" ||
    [[ "$LOADED_SERVICE_STATE" == owned ]]; then
    unload_owned_service "$SERVICE_LABEL"
  fi
  if service_is_owned "$SERVICE_DEST" "$OWNERSHIP_MARKER" "$SERVICE_LABEL"; then
    rm -f "$SERVICE_DEST"
  fi
  if symlink_is_owned "$BIN_DIR/agentbrain" "$AGENTBRAIN_CANONICAL" ||
    symlink_is_owned "$BIN_DIR/agentbrain" "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL"; then
    rm -f "$BIN_DIR/agentbrain"
  fi
  remove_known_retired_link
  printf 'uninstalled owned Agentbrain commands and services\n'
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
  "$KNOWN_LEGACY_AGENTBRAIN_CANONICAL" \
  "$PREVIOUS_MANAGED_AGENTBRAIN_CANONICAL"
check_service_destination "$SERVICE_DEST" "$OWNERSHIP_MARKER" "$SERVICE_LABEL"
check_loaded_service "$SERVICE_LABEL"
check_service_destination \
  "$SHARE_SERVICE_DEST" "$SHARE_OWNERSHIP_MARKER" "$SHARE_SERVICE_LABEL"

# A bind address is the operator's decision to expose a listener, so it is
# validated before anything is written rather than discovered by a service that
# starts, is refused by the CLI, and is restarted forever by KeepAlive.
case "$SHARE_HOST" in
  "" | none) ;;
  0.0.0.0 | ::)
    echo "refusing to supervise an any-interface share bind: $SHARE_HOST" >&2
    exit 1
    ;;
  *[![:alnum:].:_-]* | -*)
    echo "refusing unsafe share bind address: $SHARE_HOST" >&2
    exit 1
    ;;
esac

(
  cd "$ROOT"
  bun install --frozen-lockfile
)

mkdir -p "$BIN_DIR" "$LAUNCH_AGENTS_DIR" "$STATE_DIR" "$DATA_DIR"
chmod 700 "$STATE_DIR" "$DATA_DIR"
if [[ -e "$DEFAULT_DB_PATH" ]]; then
  chmod 600 "$DEFAULT_DB_PATH"
fi
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"
chmod +x "$AGENTBRAIN_SOURCE"

BUN_BIN="$(command -v bun)"
SERVICE_PATH="$(dirname "$BUN_BIN"):$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Renders one owned template and publishes it by rename, so a reader never
# observes a half-written service. The temporary file is created inside the
# LaunchAgents directory to keep that rename on one filesystem.
render_service_plist() {
  local source="$1" destination="$2" log="$3" label="$4"
TEMP_PLIST="$(mktemp "$LAUNCH_AGENTS_DIR/.$label.plist.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT
export AGENTBRAIN_RENDER_PROGRAM="$BIN_DIR/agentbrain"
export AGENTBRAIN_RENDER_HOME="$HOME"
export AGENTBRAIN_RENDER_PATH="$SERVICE_PATH"
export AGENTBRAIN_RENDER_LOG="$log"
export AGENTBRAIN_RENDER_SHARE_HOST="$SHARE_HOST"
export AGENTBRAIN_RENDER_CONDUIT_SOCKET="$CONDUIT_SOCKET"
export AGENTBRAIN_RENDER_CONDUIT_TOKEN_FILE="$CONDUIT_TOKEN_FILE"
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
    __AGENTBRAIN_SHARE_HOST__: process.env.AGENTBRAIN_RENDER_SHARE_HOST,
    __AGENTBRAIN_CONDUIT_SOCKET__: process.env.AGENTBRAIN_RENDER_CONDUIT_SOCKET,
    __AGENTBRAIN_CONDUIT_TOKEN_FILE__:
      process.env.AGENTBRAIN_RENDER_CONDUIT_TOKEN_FILE,
  };
  let rendered = await Bun.file(source).text();
  for (const [token, value] of Object.entries(replacements)) {
    if (value === undefined) throw new Error(`missing render value for ${token}`);
    rendered = rendered.replaceAll(token, escapeXml(value));
  }
  if (rendered.includes("__AGENTBRAIN_")) throw new Error("unrendered plist token");
  await Bun.write(destination, rendered);
' "$source" "$TEMP_PLIST"
chmod 600 "$TEMP_PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TEMP_PLIST" >/dev/null
fi
  mv -f "$TEMP_PLIST" "$destination"
  trap - EXIT
}

if service_is_owned "$SERVICE_DEST" "$OWNERSHIP_MARKER" "$SERVICE_LABEL" ||
  [[ "$LOADED_SERVICE_STATE" == owned ]]; then
  unload_owned_service "$SERVICE_LABEL"
fi
render_service_plist "$PLIST_SOURCE" "$SERVICE_DEST" "$LOG_PATH" "$SERVICE_LABEL"
remove_known_retired_link
ln -sfn "$AGENTBRAIN_SOURCE" "$BIN_DIR/agentbrain"

if launchctl_available; then
  "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$SERVICE_DEST"
  inspect_loaded_service "$SERVICE_LABEL"
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

# The ingress is deliberately last: it is the only optional artifact, and the
# worker is what makes an admitted share become searchable, so a half-finished
# run leaves the queue draining rather than a listener with nothing behind it.
case "$SHARE_HOST" in
  "")
    if service_is_owned \
      "$SHARE_SERVICE_DEST" "$SHARE_OWNERSHIP_MARKER" "$SHARE_SERVICE_LABEL"; then
      printf 'left the existing share ingress alone (no bind address named)\n'
    fi
    ;;
  none)
    if remove_owned_share_service; then
      printf 'removed the share ingress service\n'
    fi
    ;;
  *)
    touch "$SHARE_LOG_PATH"
    chmod 600 "$SHARE_LOG_PATH"
    inspect_loaded_service "$SHARE_SERVICE_LABEL"
    if service_is_owned \
      "$SHARE_SERVICE_DEST" "$SHARE_OWNERSHIP_MARKER" "$SHARE_SERVICE_LABEL" ||
      [[ "$LOADED_SERVICE_STATE" == owned ]]; then
      unload_owned_service "$SHARE_SERVICE_LABEL"
    fi
    render_service_plist \
      "$SHARE_PLIST_SOURCE" "$SHARE_SERVICE_DEST" "$SHARE_LOG_PATH" "$SHARE_SERVICE_LABEL"
    if launchctl_available; then
      "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$SHARE_SERVICE_DEST"
      inspect_loaded_service "$SHARE_SERVICE_LABEL"
      if [[ "$LOADED_SERVICE_STATE" != owned ]]; then
        echo "loaded service failed ownership verification: $SHARE_SERVICE_LABEL" >&2
        exit 1
      fi
      printf 'installed and loaded %s on %s\n' "$SHARE_SERVICE_DEST" "$SHARE_HOST"
    else
      printf 'installed %s (launchctl unavailable; service not loaded)\n' "$SHARE_SERVICE_DEST"
    fi
    ;;
esac
