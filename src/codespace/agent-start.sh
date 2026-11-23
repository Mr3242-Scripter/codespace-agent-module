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
if command -v tsx >/dev/null 2>&1; then
  exec tsx "$ROOT/agent-entry.ts"
fi
if [[ -x "$ROOT/../../node_modules/.bin/tsx" ]]; then
  exec "$ROOT/../../node_modules/.bin/tsx" "$ROOT/agent-entry.ts"
fi

echo "tsx is required. Install it in the workspace (npm install --save-dev tsx) or add it to PATH." >&2
exit 127
