#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${CONTROL_TOWER_CLIPROXY_DIR:-$ROOT/control-tower-ui/.runtime/cliproxyapi}"
SRC_DIR="${CLIPROXY_SOURCE_DIR:-$RUNTIME_DIR/src/CLIProxyAPI}"
BIN_DIR="$RUNTIME_DIR/bin"
BIN_PATH="${CLIPROXY_BINARY_PATH:-$BIN_DIR/CLIProxyAPIPlus}"
CONFIG_PATH="${CLIPROXY_CONFIG_PATH:-$RUNTIME_DIR/config.yaml}"
LOG_DIR="${CLIPROXY_LOG_DIR:-$RUNTIME_DIR/logs}"
LOG_PATH="${CLIPROXY_STDOUT_LOG_PATH:-$LOG_DIR/runtime-stdout.log}"
PID_PATH="${CLIPROXY_PID_PATH:-$RUNTIME_DIR/cliproxyapi.pid}"
REPO_URL="${CLIPROXY_REPO_URL:-https://github.com/router-for-me/CLIProxyAPI}"
REPO_REF="${CLIPROXY_REPO_REF:-v6.9.1}"
PORT="${CLIPROXY_PORT:-8317}"

ensure_source() {
  mkdir -p "$RUNTIME_DIR" "$BIN_DIR" "$LOG_DIR"
  if [ ! -d "$SRC_DIR/.git" ]; then
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR"
  fi
}

ensure_binary() {
  ensure_source
  if [ ! -x "$BIN_PATH" ] || find "$SRC_DIR/cmd" "$SRC_DIR/internal" -type f -newer "$BIN_PATH" | grep -q . 2>/dev/null; then
    (cd "$SRC_DIR" && GOWORK=off go build -o "$BIN_PATH" ./cmd/server)
  fi
}

stop_docker_runtime() {
  if command -v docker >/dev/null 2>&1; then
    docker compose -f "$RUNTIME_DIR/docker-compose.yml" down >/dev/null 2>&1 || true
  fi
}

is_running() {
  if [ ! -f "$PID_PATH" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_PATH" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_runtime() {
  ensure_binary
  stop_docker_runtime
  if is_running; then
    echo "cliproxyapi already running (pid $(cat "$PID_PATH"))"
    return 0
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $PORT already in use" >&2
    return 1
  fi
  nohup "$BIN_PATH" -config "$CONFIG_PATH" >"$LOG_PATH" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$PID_PATH"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      echo "cliproxyapi started on :$PORT"
      return 0
    fi
    sleep 1
  done
  echo "cliproxyapi failed to start" >&2
  return 1
}

stop_runtime() {
  local pid=""
  if [ -f "$PID_PATH" ]; then
    pid="$(cat "$PID_PATH" 2>/dev/null || true)"
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_PATH"
        echo "cliproxyapi stopped"
        return 0
      fi
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_PATH"
  echo "cliproxyapi stopped"
}

status_runtime() {
  if is_running; then
    echo "cliproxyapi running pid=$(cat "$PID_PATH")"
    curl -fsS "http://127.0.0.1:$PORT/" || true
    return 0
  fi
  echo "cliproxyapi stopped"
  return 1
}

case "${1:-start}" in
  start)
    start_runtime
    ;;
  stop)
    stop_runtime
    ;;
  restart)
    stop_runtime || true
    start_runtime
    ;;
  build)
    ensure_binary
    echo "$BIN_PATH"
    ;;
  status)
    status_runtime
    ;;
  *)
    echo "usage: $0 {start|stop|restart|build|status}" >&2
    exit 1
    ;;
esac
