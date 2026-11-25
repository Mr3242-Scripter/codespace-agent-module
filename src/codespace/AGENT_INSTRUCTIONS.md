# Portable Codespaces Agent Module — AI Installation Instructions

Install the complete Codespaces-side runtime from this directory into the target repository. Do not copy only selected source files.

## Install

From the target repository root, run:

```bash
node /path/to/module/install.mjs --target .
```

The installer:
- Copies the complete runtime, supervisor, shell lifecycle scripts, dependency checker, tests, and isolated TypeScript configuration into `.codespace-agent/`.
- Merges the module's required npm packages into the target package's `devDependencies` without replacing unrelated dependencies.
- Adds namespaced `codespace-agent:*` npm scripts without overwriting existing scripts.
- Merges GitHub CLI and Docker-in-Docker Dev Container features and supported string-form lifecycle hooks.
- Preserves unrelated files and settings. It refuses conflicting destination files rather than silently overwriting them.
- Installs the required npm dependencies and runs the module checks.

If the Dev Container configuration contains JSONC comments, cannot be safely parsed, or uses array/object lifecycle commands, the installer leaves it untouched and writes a merge fragment. Apply that fragment manually; do not replace the user's configuration.

## Required runtime configuration

Set these environment variables securely in the Codespace:
- `CODESPACE_AGENT_URL`
- `CODESPACE_AGENT_TOKEN` (at least 32 characters)
- `CODESPACE_NAME`

Do not put tokens in source control, generated documentation, or logs.

## Required tools

Node.js 22+, npm, Python 3 and pip, Git, Docker CLI, GitHub CLI, VS Code CLI, and every npm package declared in `module.json` are mandatory. `node-pty` is mandatory; there is no pipe-based terminal fallback.

## Verification

```bash
npm run codespace-agent:check
npm run codespace-agent:status
```

Host-side MCP server/relay registration is intentionally outside this bundle. This is the Codespace-side runtime only.
