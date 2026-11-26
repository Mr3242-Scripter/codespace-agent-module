# GitHub Codespaces Agent Module

A portable, security-hardened **Codespaces-side runtime** for connecting a GitHub Codespace to a separately hosted MCP server/relay.

The reusable module lives in `src/codespace/`. It includes the agent runtime, process supervisor, lifecycle scripts, installer, dependency checks, documentation, and regression tests. It is designed to be copied into another repository and installed without replacing unrelated project files or settings.

> **Scope:** This repository contains the Codespace-side agent module. It does not contain the MCP host/relay server, its HTTP routes, authentication service, job queue, or MCP tool registration. Those components must be deployed and secured separately.

## Features

- Authenticated Codespace agent with reconnect and supervised restart behavior.
- Workspace filesystem, terminal, process, Git, VS Code, Dev Container, port, archive, transfer, diagnostics, and language-server operations.
- Mandatory pseudo-terminal support through `node-pty`; there is no pipe-based terminal fallback for terminal sessions.
- Bounded file, archive, transfer, terminal, LSP, DAP, and relay operations.
- Git transport restrictions, input validation, hook suppression, and scoped GitHub credentials.
- Portable installer that merges dependencies, namespaced npm scripts, Dev Container features, and supported lifecycle hooks.
- Dependency validation, TypeScript checks, and regression tests that run before service-managed agent startup.

## Repository layout

| Path | Purpose |
|---|---|
| `src/codespace/` | Complete portable module source and installer |
| `src/codespace/agent.ts` | Main Codespace agent and workspace operations |
| `src/codespace/advanced.ts` | Advanced operations, diagnostics, transfers, LSP/DAP, and watchers |
| `src/codespace/agent-entry.ts` | Runtime entry point |
| `src/codespace/supervisor.ts` | Restart supervisor |
| `src/codespace/agent-service.sh` | Background service lifecycle manager |
| `src/codespace/agent-start.sh` | Foreground launcher |
| `src/codespace/install.mjs` | Portable installer |
| `src/codespace/module.json` | Module manifest, dependencies, required tools, and payload |
| `.devcontainer/devcontainer.json` | This repository's Codespaces container configuration |
| `.github/workflows/ci.yml` | CI typecheck, regression tests, and dependency audit |
| `.github/dependabot.yml` | Weekly npm and GitHub Actions dependency updates |

## Use the custom Codespaces container in this repository

This repository includes a Dev Container configuration based on the Microsoft Node.js 22 Bookworm image, with GitHub CLI and Docker-in-Docker features and agent lifecycle hooks.

To make Codespaces build and use the configured container:

1. Open this repository in GitHub Codespaces.
2. Open the VS Code Command Palette.
3. Run **Codespaces: Rebuild Container** (or **Dev Containers: Rebuild Container**, depending on the client).
4. Choose **Full Rebuild** when prompted. A full rebuild recreates the container instead of reusing the existing container image/cache.
5. Wait for container creation and the `postCreateCommand` checks to finish. The setup installs Python pip, runs `npm ci`, and executes `npm run check:agent`.
6. Verify the environment with:

   ```bash
   npm run check:agent
   npm run agent:status
   ```

After the full rebuild, Codespaces uses the Dev Container configuration committed in this repository. The agent lifecycle hooks attempt to start the agent after container start and attachment; the agent will remain stopped until its required relay environment variables are configured.

## Install the module into another repository

### Requirements

- GitHub Codespaces or a compatible Linux Dev Container.
- Node.js 22 or newer and npm.
- Python 3 and pip.
- Git, Docker CLI, GitHub CLI (`gh`), and VS Code CLI (`code`).
- A separately deployed MCP host/relay that implements the agent protocol.

The installer adds the module's required npm packages and merges the GitHub CLI and Docker-in-Docker Dev Container features. The dependency check verifies the required executables and packages; a missing requirement causes verification and agent startup to fail.

### 1. Copy the complete module directory

From the target project's root, clone this repository to a temporary location and copy the **entire** `src/codespace` directory into the target project:

```bash
git clone https://github.com/Mr3242-Scripter/codespace-agent-module.git /tmp/codespace-agent-module
mkdir -p tools
cp -R /tmp/codespace-agent-module/src/codespace tools/codespace-agent-module
```

Do not copy only selected runtime files. The installer needs the manifest, utilities, tests, and documentation included in the module directory.

### 2. Run the installer

From the target project's root:

```bash
node tools/codespace-agent-module/install.mjs --target .
```

The installer:

- Copies the runtime into `.codespace-agent/`.
- Adds missing required packages to `devDependencies`.
- Adds namespaced `codespace-agent:*` npm scripts without replacing unrelated scripts.
- Merges the required Dev Container features and supported string-form lifecycle hooks.
- Preserves unrelated project files and settings.
- Refuses to overwrite conflicting runtime files or conflicting namespaced scripts.
- Installs dependencies and runs `npm run codespace-agent:check`.

For a dry installation that copies and configures the module but skips dependency installation and checks:

```bash
node tools/codespace-agent-module/install.mjs --target . --no-install
```

If the target Dev Container configuration contains JSONC comments, invalid strict JSON, or array/object lifecycle commands, the installer leaves the original configuration unchanged and writes `.devcontainer/codespace-agent.fragment.json`. Review and merge that fragment manually; do not replace the existing configuration.

### 3. Rebuild the target container

If installation changed Dev Container features or lifecycle hooks, rebuild the target repository's container:

1. Open the target repository in Codespaces.
2. Run **Codespaces: Rebuild Container** from the Command Palette.
3. Select **Full Rebuild**.
4. Wait for the container setup and post-create checks to complete.

A full rebuild is important when the Dev Container feature set changes. Reopening the existing container alone does not install newly added container features.

### 4. Configure the relay connection

Set the following environment variables in the Codespace. Store the token as a GitHub Codespaces secret; do not commit it to the repository, put it in a checked-in `.env` file, or paste it into logs.

| Variable | Description |
|---|---|
| `CODESPACE_AGENT_URL` | Base HTTPS URL of the separately deployed MCP host/relay |
| `CODESPACE_AGENT_TOKEN` | Agent authentication token; minimum 32 characters |
| `CODESPACE_NAME` | Exact Codespace name (GitHub normally provides this automatically) |
| `CODESPACE_WORKSPACE` | Optional workspace root; defaults to the process working directory |

Use HTTPS for the relay URL. Plain HTTP is accepted only for local development endpoints (`localhost`, `127.0.0.1`, or `::1`).

The host/relay must independently authenticate the agent, implement the expected relay endpoints and job protocol, and register the corresponding MCP tools. Installing this module does not create that host integration.

### 5. Verify and operate the module

Run these commands from the target project root:

```bash
npm run codespace-agent:check
npm run codespace-agent:start
npm run codespace-agent:status
npm run codespace-agent:logs
npm run codespace-agent:stop
```

The check runs the dependency checker, TypeScript compilation, and module regression tests. The service-managed start runs the full check before launching the agent.

## Development in this repository

Install the locked development dependencies and run the full agent verification suite:

```bash
npm ci
npm run check:agent
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run agent:start` | Start the repository's agent service |
| `npm run agent:status` | Show service status |
| `npm run agent:stop` | Stop the service |
| `npm run agent:check-deps` | Check required dependencies and executables |
| `npm run typecheck` | Run TypeScript compilation checks |
| `npm run test:agent` | Run agent regression tests |
| `npm run check:agent` | Run dependency check, typecheck, and regression tests |

The repository's Dev Container `postCreateCommand` installs `python3-pip`, runs `npm ci`, and runs the full verification suite. `postStartCommand` and `postAttachCommand` invoke the service manager. Every service-managed start checks dependencies, types, and regression tests before starting the agent.

Agent logs default to `~/.codespace-agent.log`.

## Required runtime components

| Component | Purpose |
|---|---|
| `node-pty` | Required PTY implementation for terminal sessions |
| `@devcontainers/cli` | Dev Container inspection and management |
| `typescript`, `tsx`, `@types/node` | TypeScript compilation and runtime |
| `typescript-language-server` | TypeScript and JavaScript language support |
| `vscode-langservers-extracted` | JSON, HTML, and CSS language servers |
| `bash-language-server` | Bash language support |
| `pyright` | Python language support |
| `yaml-language-server` | YAML language support |
| Python 3 and pip | Python runtime and package tooling |
| Git, Docker CLI, `gh`, `code` | Required system tools |

Language-server commands use stdio transport:

| Language / format | Command |
|---|---|
| TypeScript / JavaScript | `typescript-language-server --stdio` |
| JSON | `vscode-json-language-server --stdio` |
| HTML | `vscode-html-language-server --stdio` |
| CSS | `vscode-css-language-server --stdio` |
| Bash | `bash-language-server start` |
| Python | `pyright-langserver --stdio` |
| YAML | `yaml-language-server --stdio` |

These are language-server processes, not VS Code extensions. Installing them makes the servers available to the agent; it does not automatically install editor UI extensions.

## Security model and limitations

The module includes defensive controls such as bounded protocol queues and file operations, archive snapshot validation, symlink and hard-link protections, upload-session checks, restricted Git operations, credential/environment sanitization for child processes, and regression tests for security-sensitive behavior.

Important limitations:

- **This agent is not an OS security sandbox.** Terminal, process, Dev Container, and debug-adapter commands run with the Codespace user's permissions. A connected MCP client can request powerful operations. Connect only trusted clients and use least-privilege credentials.
- The separate MCP host/relay is outside this repository and must receive its own security review. Its authentication, authorization, job validation, replay handling, and HTTP routes are not covered by this module's checks.
- Filesystem path validation cannot provide a complete `openat2`-style race-free guarantee if an untrusted process concurrently replaces parent directories. Avoid sharing the workspace with untrusted concurrent writers.
- Security checks and dependency audits reduce risk but cannot prove that software is vulnerability-free.

## CI and dependency updates

GitHub Actions runs on pushes to `main`, pull requests targeting `main`, and manual dispatch. It installs locked dependencies, runs TypeScript checks and regression tests, and runs `npm audit --audit-level=low`.

Dependabot checks npm and GitHub Actions dependencies weekly. Pull requests are limited to 10 npm updates and 5 GitHub Actions updates at a time.

## Troubleshooting

**The agent does not start**

- Run `npm run codespace-agent:check` (or `npm run check:agent` in this repository).
- Confirm Node.js 22+, all required npm packages, and all required system executables are installed.
- Confirm `CODESPACE_AGENT_URL`, `CODESPACE_AGENT_TOKEN`, and `CODESPACE_NAME` are present in the Codespace environment.
- Confirm the token is at least 32 characters and the relay URL uses HTTPS.
- Inspect the log with `npm run codespace-agent:logs` (or `tail -n 100 ~/.codespace-agent.log` in this repository).

**A Dev Container feature is missing after installation**

- Confirm the installer completed successfully and inspect `.devcontainer/devcontainer.json`.
- If a merge fragment was generated, manually merge `.devcontainer/codespace-agent.fragment.json`.
- Run **Codespaces: Rebuild Container → Full Rebuild**.

**The installer reports a conflict**

The installer intentionally refuses to overwrite a different existing runtime file or an existing npm script with the same namespaced key. Back up and reconcile the conflicting file or script, then rerun the installer.

## Publishing and licensing

This project is distributed as a source module in `src/codespace/`; it is not currently published as an npm package or a prebuilt container image.

This repository is licensed under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the software, subject to the license conditions and warranty disclaimer.

## Additional documentation

- [Portable module installation guide](src/codespace/INSTALL.md)
- [AI-agent installation instructions](src/codespace/AGENT_INSTRUCTIONS.md)
- [Module-specific README](src/codespace/README.md)
