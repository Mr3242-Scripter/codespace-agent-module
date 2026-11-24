#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:-status}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
export PATH="$WORKSPACE_ROOT/node_modules/.bin:$PATH"
PID_FILE="${CODESPACE_AGENT_PID_FILE:-$HOME/.codespace-agent.pid}"
LOG_FILE="${CODESPACE_AGENT_LOG_FILE:-$HOME/.codespace-agent.log}"
log() { local message="$*"; printf '[%s] %s\n' "$(date -Is)" "$message" | tee -a "$LOG_FILE" >&2; }
agent_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid command_line
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$command_line" == *"agent-entry.ts"* ]] || return 1
  printf '%s' "$pid"
}
start_agent() {
  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  if pid="$(agent_pid)"; then log "Codespaces agent already running (PID $pid)."; return 0; fi
  rm -f "$PID_FILE"
  local missing=()
  for required in CODESPACE_AGENT_URL CODESPACE_AGENT_TOKEN CODESPACE_NAME; do
    if [[ -z "${!required:-}" ]]; then missing+=("$required"); fi
  done
  if (("${#missing[@]}" > 0)); then log "Cannot start agent; missing environment variable(s): ${missing[*]}"; return 2; fi
  if [[ "${#CODESPACE_AGENT_TOKEN}" -lt 32 ]]; then log "Cannot start agent; CODESPACE_AGENT_TOKEN is shorter than 32 characters."; return 2; fi
  local tsx
  if command -v tsx >/dev/null 2>&1; then tsx="$(command -v tsx)"
  elif [[ -x "$ROOT/../../node_modules/.bin/tsx" ]]; then tsx="$ROOT/../../node_modules/.bin/tsx"
  else log "Cannot start agent; tsx executable was not found. Run npm install in the workspace."; return 127; fi
  log "Starting Codespaces agent for ${CODESPACE_NAME}."
  nohup "$tsx" "$ROOT/agent-entry.ts" >>"$LOG_FILE" 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  for _ in {1..6}; do
    if agent_pid >/dev/null; then log "Codespaces agent process started (PID $pid)."; return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then log "Agent process is alive but its command line could not be verified; keeping PID file for diagnosis."; return 0; fi
  rm -f "$PID_FILE"
  log "Codespaces agent exited during startup. Recent log output:"
  tail -n 40 "$LOG_FILE" >&2 || true
  return 1
}
stop_agent() {
  local pid
  if ! pid="$(agent_pid)"; then rm -f "$PID_FILE"; log "Codespaces agent is not running."; return 0; fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then rm -f "$PID_FILE"; log "Codespaces agent stopped."; return 0; fi
    sleep 0.5
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  log "Codespaces agent stopped after forced termination."
}
case "$ACTION" in
  start) start_agent ;;
  stop) stop_agent ;;
  restart) stop_agent; start_agent ;;
  status)
    if pid="$(agent_pid)"; then printf 'Codespaces agent running (PID %s).\n' "$pid"
    else rm -f "$PID_FILE"; printf 'Codespaces agent stopped. Log: %s\n' "$LOG_FILE"; fi ;;
  logs) if [[ -f "$LOG_FILE" ]]; then tail -n "${2:-80}" "$LOG_FILE"; else echo "No agent log exists yet: $LOG_FILE"; fi ;;
  *) echo "Usage: $0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
