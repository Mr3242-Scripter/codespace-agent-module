#!/usr/bin/env bash
set -euo pipefail
ACTION="${1:-status}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$ROOT/../../package.json" ]]; then
  WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
elif [[ -f "$ROOT/../package.json" ]]; then
  WORKSPACE_ROOT="$(cd "$ROOT/.." && pwd)"
else
  WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
fi
CHECK_SCRIPT="${CODESPACE_AGENT_CHECK_SCRIPT:-check:agent}"
filter_workspace_path() {
  local entry filtered="" absolute
  local -a entries=()
  IFS=: read -r -a entries <<< "${1:-}"
  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == /* ]]; then absolute="$entry"; else absolute="$WORKSPACE_ROOT/$entry"; fi
    local resolved
    resolved="$(/usr/bin/realpath -m -- "$absolute" 2>/dev/null || true)"
    [[ -n "$resolved" ]] || continue
    case "$resolved" in
      "$WORKSPACE_ROOT"|"$WORKSPACE_ROOT"/*) continue ;;
    esac
    if [[ -n "$filtered" ]]; then filtered="$filtered:$resolved"; else filtered="$resolved"; fi
  done
  printf '%s' "$filtered"
}
PATH="$(filter_workspace_path "$PATH")"
export PATH
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
sanitize_child_environment() {
  local name
  while IFS= read -r name; do
    case "$name" in
      *TOKEN*|*SECRET*|*PASSWORD*|*PASSWD*|*PASS*|*KEY*|*COOKIE*|*AUTH*|*CREDENTIAL*|*CERT*|*PRIVATE*|*SESSION*|*ASKPASS*|*ACCESS*|*AGENT*|*SOCKET*|AWS_*|AZURE_*|ARM_*|GOOGLE_*|GCLOUD_*|CLOUDSDK_*|GCP_*|VAULT_*|TF_VAR_*|KUBECONFIG|DOCKER_CONFIG|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|LD_*|DYLD_*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|GIT_*|DOCKER_HOST|DOCKER_CONTEXT|CONTAINER_HOST|COREPACK_*|NPM_CONFIG_*|npm_config_*)
        unset "$name" 2>/dev/null || true
        ;;
    esac
  done < <(compgen -e)
}

start_agent() {
  mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
  if pid="$(agent_pid)"; then log "Codespaces agent already running (PID $pid)."; return 0; fi
  rm -f "$PID_FILE"
  if [[ ! -f "$WORKSPACE_ROOT/node_modules/@types/node/index.d.ts" ]]; then
    log "Cannot start agent; required dependency @types/node is missing. Run npm ci from the workspace root."
    return 127
  fi
  local missing=()
  for required in CODESPACE_AGENT_URL CODESPACE_AGENT_TOKEN CODESPACE_NAME; do
    if [[ -z "${!required:-}" ]]; then missing+=("$required"); fi
  done
  if (("${#missing[@]}" > 0)); then log "Cannot start agent; missing environment variable(s): ${missing[*]}"; return 2; fi
  if [[ "${#CODESPACE_AGENT_TOKEN}" -lt 32 ]]; then log "Cannot start agent; CODESPACE_AGENT_TOKEN is shorter than 32 characters."; return 2; fi
  local tsx
  if [[ -x "$WORKSPACE_ROOT/node_modules/.bin/tsx" ]]; then tsx="$WORKSPACE_ROOT/node_modules/.bin/tsx"
  elif command -v tsx >/dev/null 2>&1; then tsx="$(command -v tsx)"
  else log "Cannot start agent; tsx executable was not found. Run npm ci in the workspace."; return 127; fi

  log "Running mandatory dependency, typecheck, and regression-test checks."
  if ! (sanitize_child_environment; npm run "$CHECK_SCRIPT" --prefix "$WORKSPACE_ROOT"); then
    log "Agent startup blocked because mandatory verification failed."
    return 1
  fi

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
