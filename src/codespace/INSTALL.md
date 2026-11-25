# Install the portable Codespaces agent

1. Copy this entire `src/codespace` module directory into the target repository (for example, as `tools/codespace-agent-module/`).
2. From the target project's root, run `node tools/codespace-agent-module/install.mjs --target .`.
3. Set `CODESPACE_AGENT_URL`, `CODESPACE_AGENT_TOKEN`, and `CODESPACE_NAME` as secure Codespace environment variables.
4. Run `npm run codespace-agent:check`.
5. Rebuild/reopen the Dev Container if the installer changed its features or lifecycle hooks.

The installer places the runtime in `.codespace-agent/`, preserves unrelated package scripts and dependencies, and refuses to overwrite conflicting runtime files. It automatically merges Dev Container lifecycle hooks when they use string form and merges the required features. If the existing configuration uses JSONC comments, invalid JSON, or array/object lifecycle commands, it leaves the configuration unchanged and writes `.devcontainer/codespace-agent.fragment.json` for manual merging.

This package contains the Codespace-side runtime only. It does not contain or install the separate MCP host/relay integration.
