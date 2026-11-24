#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ELYTRAS_ENV_FILE:-$ROOT/.env.local}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
OPENCLAW_ROOT="${CONTROL_TOWER_BACKEND_ROOT:-${OPENCLAW_ROOT:-$ROOT}}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
ELYTRAS_RUNTIME_ROOT_DEFAULT="$OPENCLAW_HOME/elytras/runtime"
DEFAULT_WORKSPACE_ROOT="$OPENCLAW_HOME/workspaces/default"
if [ ! -f "$OPENCLAW_ROOT/openclaw.mjs" ] && [ -f "$ROOT/../openclaw/openclaw.mjs" ]; then
  OPENCLAW_ROOT="$(cd "$ROOT/../openclaw" && pwd)"
elif [ ! -f "$OPENCLAW_ROOT/openclaw.mjs" ] && [ -f "$ROOT/../openclaw.mjs" ]; then
  OPENCLAW_ROOT="$(cd "$ROOT/.." && pwd)"
fi
RUNTIME_DIR="${OPENCLAW_RUNTIME_DIR:-$ELYTRAS_RUNTIME_ROOT_DEFAULT}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$OPENCLAW_HOME}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$DEFAULT_WORKSPACE_ROOT}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_HOME/openclaw.json}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-openclaw-local-token}"
CLI_BIN="${OPENCLAW_CLI_BIN:-}"
PREFER_GLOBAL_CLI="${OPENCLAW_PREFER_GLOBAL_CLI:-1}"
SUPERVISOR_PID_PATH="${OPENCLAW_SUPERVISOR_PID_PATH:-$RUNTIME_DIR/backend-supervisor.pid}"

mkdir -p "$RUNTIME_DIR" "$STATE_DIR" "$WORKSPACE_DIR"
printf '%s\n' "$$" >"$SUPERVISOR_PID_PATH"
trap 'rm -f "$SUPERVISOR_PID_PATH"' EXIT

if [ ! -f "$CONFIG_PATH" ]; then
cat >"$CONFIG_PATH" <<EOF
{
  "agents": {
    "defaults": {
      "workspace": "$WORKSPACE_DIR"
    },
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "$WORKSPACE_DIR"
      }
    ]
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "$TOKEN"
    },
    "controlUi": {
      "enabled": true,
      "basePath": "/openclaw"
    }
  }
}
EOF
fi

cd "$OPENCLAW_ROOT"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
export OPENCLAW_GATEWAY_TOKEN="$TOKEN"

# Prefer the installed OpenClaw CLI so Elytras remains a thin overlay on top
# of an existing runtime instead of coupling itself to this checkout.
if [ -n "$CLI_BIN" ]; then
  OPENCLAW_CMD=("$CLI_BIN")
elif [ "$PREFER_GLOBAL_CLI" != "0" ] && command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_CMD=("openclaw")
elif [ -f "$OPENCLAW_ROOT/openclaw.mjs" ]; then
  OPENCLAW_CMD=("node" "$OPENCLAW_ROOT/openclaw.mjs")
else
  OPENCLAW_CMD=("node" "$OPENCLAW_ROOT/openclaw.mjs")
fi

while true; do
  "${OPENCLAW_CMD[@]}" gateway --port "$PORT" --verbose
  sleep 1
done
