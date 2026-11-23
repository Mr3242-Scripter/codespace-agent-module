#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${CODESPACE_AGENT_PID_FILE:-$HOME/.codespace-agent.pid}"
LOG_FILE="${CODESPACE_AGENT_LOG_FILE:-$HOME/.codespace-agent.log}"

agent_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -F "$ROOT/agent-entry.ts" >/dev/null || return 1
  printf '%s' "$pid"
}

start_agent() {
  if agent_pid >/dev/null; then
    echo "Codespaces agent already running (PID $(agent_pid))."
    return 0
  fi
  rm -f "$PID_FILE"
  for required in CODESPACE_AGENT_URL CODESPACE_AGENT_TOKEN CODESPACE_NAME; do
    if [[ -z "${!required:-}" ]]; then
      echo "Missing required environment variable: $required" >&2
      return 2
    fi
  done
  if [[ "${#CODESPACE_AGENT_TOKEN}" -lt 32 ]]; then
    echo "CODESPACE_AGENT_TOKEN must contain at least 32 characters." >&2
    return 2
  fi
  local tsx
  if command -v tsx >/dev/null 2>&1; then
    tsx="$(command -v tsx)"
  elif [[ -x "$ROOT/../../node_modules/.bin/tsx" ]]; then
    tsx="$ROOT/../../node_modules/.bin/tsx"
  else
    echo "tsx is required. Install it in the workspace (npm install --save-dev tsx)." >&2
    return 127
  fi
  nohup "$tsx" "$ROOT/agent-entry.ts" >>"$LOG_FILE" 2>&1 </dev/null &
  echo "$!" >"$PID_FILE"
  sleep 1
  if agent_pid >/dev/null; then
    echo "Codespaces agent started (PID $(agent_pid)); log: $LOG_FILE"
  else
    rm -f "$PID_FILE"
    echo "Codespaces agent failed to start. Inspect $LOG_FILE." >&2
    return 1
  fi
}

stop_agent() {
  local pid
  if ! pid="$(agent_pid)"; then
    rm -f "$PID_FILE"
    echo "Codespaces agent is not running."
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "Codespaces agent stopped."
      return 0
    fi
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Codespaces agent stopped after forced termination."
}

case "$ACTION" in
  start) start_agent ;;
  stop) stop_agent ;;
  restart) stop_agent; start_agent ;;
  status)
    if pid="$(agent_pid)"; then echo "Codespaces agent running (PID $pid)."; else rm -f "$PID_FILE"; echo "Codespaces agent stopped."; fi
    ;;
  *) echo "Usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
