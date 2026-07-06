#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/src/cli.ts" "$HOME/.local/bin/agentbrain"
chmod +x "$PWD/src/cli.ts"
echo "installed $HOME/.local/bin/agentbrain -> $PWD/src/cli.ts"
