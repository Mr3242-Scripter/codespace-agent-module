# codespace-agent-playground

Private workspace repository for testing the MCP Codespaces agent.

## Required agent environment

The custom Dev Container installs the agent runtime dependencies during creation:

```bash
npm install
npm run agent:check-deps
```

The dependency check is mandatory: container creation fails if any required executable or module is missing. The agent service adds `node_modules/.bin` to `PATH`, so the agent can launch the local tools directly.

Required runtime components:

- **node-pty** — mandatory pseudo-terminal implementation. The agent fails at startup if it cannot load this module. Terminal sessions use PTYs, enabling terminal resizing.
- **@devcontainers/cli** — provides the `devcontainer` command used to inspect, validate, build, start, and execute Dev Containers.
- **TypeScript** — `typescript` and `typescript-language-server`.
- **JSON, HTML, and CSS** — language servers from `vscode-langservers-extracted`.
- **Bash** — `bash-language-server`.
- **Python** — `pyright`.
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

The existing Dev Container hooks start the agent when the container starts and when VS Code attaches:

- `postCreateCommand`: install and verify all required dependencies.
- `postStartCommand`: start the agent after each container start.
- `postAttachCommand`: ensure the agent is running after attachment.

Manual controls:

```bash
npm run agent:start
npm run agent:status
npm run agent:stop
```

Agent logs are written to `~/.codespace-agent.log`.
