# codespace-agent-playground

Private workspace repository for testing the MCP Codespaces agent.

## Required agent environment

The custom Dev Container installs Python's pip, installs exact Node.js dependency versions from `package-lock.json`, and runs mandatory verification during creation:

```bash
sudo apt-get update
sudo apt-get install -y python3-pip
npm ci
npm run check:agent
```

Container creation and every new agent startup fail if a required executable or module is missing, TypeScript compilation fails, or an agent regression test fails. The agent service adds `node_modules/.bin` to `PATH`, so the agent can launch local tools directly.

Run the complete verification suite manually:

```bash
npm run check:agent
```

This runs the dependency check, TypeScript compilation, and agent regression tests.

## Required runtime components

- **node-pty** — mandatory pseudo-terminal implementation. The agent fails at startup if it cannot load this module. Terminal sessions use PTYs, enabling terminal resizing.
- **@devcontainers/cli** — provides the `devcontainer` command used to inspect, validate, build, start, and execute Dev Containers.
- **TypeScript** — `typescript` and `typescript-language-server`.
- **JSON, HTML, and CSS** — language servers from `vscode-langservers-extracted`.
- **Bash** — `bash-language-server`.
- **Python** — `pyright`; Python's `pip3` is installed in the Dev Container.
- **YAML** — `yaml-language-server`.

The installed language-server commands are available on the agent's `PATH`:

| Language / format | Command |
|---|---|
| TypeScript / JavaScript | `typescript-language-server --stdio` |
| JSON | `vscode-json-language-server --stdio` |
| HTML | `vscode-html-language-server --stdio` |
| CSS | `vscode-css-language-server --stdio` |
| Bash | `bash-language-server start` |
| Python | `pyright-langserver --stdio` |
| YAML | `yaml-language-server --stdio` |

The MCP LSP operation must launch the appropriate command for the file type and use stdio transport. These are language-server processes, not VS Code extensions; installing the servers makes them available to the agent but does not automatically add editor UI features.

## Agent lifecycle

The Dev Container hooks:
- `postCreateCommand`: install pip, install locked npm dependencies with `npm ci`, and run all mandatory checks.
- `postStartCommand`: start the agent after each container start.
- `postAttachCommand`: ensure the agent is running after attachment.

Every new agent start runs `npm run check:agent` before launching. Startup is blocked if any required dependency, typecheck, or regression test fails.

Manual controls:

```bash
npm run agent:start
npm run agent:status
npm run agent:stop
npm run agent:check-deps
npm run typecheck
npm run test:agent
npm run check:agent
```

Agent logs are written to `~/.codespace-agent.log`.

## Portable Codespaces agent module

The complete Codespace-side runtime is packaged in `src/codespace/`. To reuse it in another repository, copy that directory and run:

```bash
node path/to/codespace-module/install.mjs --target .
```

The installer adds the mandatory dependencies and namespaced scripts, merges Dev Container lifecycle hooks and required features, installs dependencies, and runs the module checks. See `src/codespace/INSTALL.md` and `src/codespace/AGENT_INSTRUCTIONS.md`. The bundle is the Codespace-side runtime only; the separate MCP host/relay integration is not included.
