#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CODESPACE_AGENT_URL:-}" || -z "${CODESPACE_AGENT_TOKEN:-}" || -z "${CODESPACE_NAME:-}" ]]; then
  echo "Set CODESPACE_AGENT_URL, CODESPACE_AGENT_TOKEN, and CODESPACE_NAME." >&2
  exit 2
fi

if [[ "${#CODESPACE_AGENT_TOKEN}" -lt 32 ]]; then
  echo "CODESPACE_AGENT_TOKEN must contain at least 32 characters." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$ROOT/../../package.json" ]]; then
  WORKSPACE_ROOT="$(cd "$ROOT/../.." && pwd)"
elif [[ -f "$ROOT/../package.json" ]]; then
  WORKSPACE_ROOT="$(cd "$ROOT/.." && pwd)"
else
  WORKSPACE_ROOT="$(pwd)"
fi
CHECK_SCRIPT="${CODESPACE_AGENT_CHECK_SCRIPT:-check:agent}"
filter_workspace_path() {
  local entry filtered="" absolute resolved
  local -a entries=()
  IFS=: read -r -a entries <<< "${1:-}"
  for entry in "${entries[@]}"; do
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == /* ]]; then absolute="$entry"; else absolute="$WORKSPACE_ROOT/$entry"; fi
    resolved="$(/usr/bin/realpath -m -- "$absolute" 2>/dev/null || true)"
    [[ -n "$resolved" ]] || continue
    case "$resolved" in "$WORKSPACE_ROOT"|"$WORKSPACE_ROOT"/*) continue ;; esac
    if [[ -n "$filtered" ]]; then filtered="$filtered:$resolved"; else filtered="$resolved"; fi
  done
  printf '%s' "$filtered"
}
PATH="$(filter_workspace_path "$PATH")"
export PATH
sanitize_child_environment() {
  local name function_name
  while IFS= read -r name; do
    case "$name" in
      *TOKEN*|*SECRET*|*PASSWORD*|*PASSWD*|*PASS*|*KEY*|*COOKIE*|*AUTH*|*CREDENTIAL*|*CERT*|*PRIVATE*|*SESSION*|*ASKPASS*|*ACCESS*|*AGENT*|*SOCKET*|AWS_*|AZURE_*|ARM_*|GOOGLE_*|GCLOUD_*|CLOUDSDK_*|GCP_*|VAULT_*|TF_VAR_*|KUBECONFIG|DOCKER_CONFIG|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|BASH_FUNC_*|CDPATH|IFS|GLOBIGNORE|ZDOTDIR|LD_*|DYLD_*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|GIT_*|DOCKER_HOST|DOCKER_CONTEXT|CONTAINER_HOST|COREPACK_*|NPM_CONFIG_*|npm_config_*)
        unset "$name" 2>/dev/null || true
        ;;
    esac
  done < <(compgen -e)
  while IFS= read -r function_name; do
    export -fn "$function_name" 2>/dev/null || true
  done < <(compgen -A function)
}

if ! (sanitize_child_environment; npm run "$CHECK_SCRIPT" --prefix "$WORKSPACE_ROOT"); then
  echo "Agent startup blocked because mandatory verification failed." >&2
  exit 1
fi
if [[ -x "$WORKSPACE_ROOT/node_modules/.bin/tsx" ]]; then
  exec "$WORKSPACE_ROOT/node_modules/.bin/tsx" "$ROOT/agent-entry.ts"
fi
echo "tsx is required. Install the mandatory Codespaces agent dependencies first." >&2
exit 127
