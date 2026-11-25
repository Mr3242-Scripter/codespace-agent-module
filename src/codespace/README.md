# GitHub Codespaces agent module

This directory is the **portable Codespace-side agent runtime**. It is designed to be copied into another repository and installed with `node install.mjs --target /path/to/project`.

The installer places the runtime in `.codespace-agent/`, merges required npm dependencies and namespaced npm scripts, merges supported Dev Container lifecycle hooks/features, installs dependencies, and runs the verification suite. It refuses to overwrite conflicting runtime files or existing npm scripts.

## What is included

- `agent.ts` — authenticated Codespace agent, workspace operations, filesystem, terminal, process, Git, VS Code, Dev Container, port, and archive operations.
- `advanced.ts` — diagnostics, resource monitoring, file synchronization, transfer sessions, watchers, LSP/DAP transports, and VS Code workspace configuration.
- `agent-entry.ts` and `supervisor.ts` — supervised runtime entry point and reconnect/restart behavior.
- `agent-service.sh` and `agent-start.sh` — background lifecycle manager and foreground launcher.
- `agent-utils.ts` — shared bounded-session and safe file-write utilities.
- `check-deps.mjs` — mandatory npm package, executable, and runtime prerequisite checker.
- `*.test.ts` — regression tests copied with the module.
- `module.json` — machine-readable manifest, payload, and required dependency list.
- `install.mjs`, `INSTALL.md`, and `AGENT_INSTRUCTIONS.md` — portable installation tooling and AI-agent instructions.

## Install into another repository

Copy this entire directory into the target repository (for example, as `tools/codespace-agent-module/`) and run from the target project root:

```bash
node tools/codespace-agent-module/install.mjs --target .
```

The installer copies the runtime into `.codespace-agent/`, adds the required packages to `devDependencies`, adds `codespace-agent:*` scripts, configures Dev Container features and lifecycle hooks, runs `npm install`, and runs `npm run codespace-agent:check`.

For a dry installation test that skips npm install and checks:

```bash
node tools/codespace-agent-module/install.mjs --target /path/to/project --no-install
```

If the existing Dev Container configuration uses JSONC comments, cannot be parsed as strict JSON, or uses array/object lifecycle commands, the installer leaves it untouched and writes `.devcontainer/codespace-agent.fragment.json` for manual merging.

## Required environment

Set these values securely in the Codespace environment:

- `CODESPACE_AGENT_URL` — base URL of the separate MCP host/relay.
- `CODESPACE_AGENT_TOKEN` — agent authentication token, at least 32 characters.
- `CODESPACE_NAME` — exact GitHub Codespace name.
- `CODESPACE_WORKSPACE` — optional workspace root; defaults to the process working directory.

Never commit agent tokens or place them in source-controlled configuration.

## Mandatory dependencies

Node.js 22+, npm, and every package below are required. The installer adds missing packages and the dependency check fails if any package or executable is unavailable.

| Package | Purpose |
|---|---|
| `@devcontainers/cli` | Dev Container CLI |
| `@types/node` | Node.js TypeScript definitions |
| `bash-language-server` | Bash LSP |
| `node-pty` | Required native PTY implementation |
| `pyright` | Python language server |
| `tsx` | TypeScript runtime |
| `typescript` | TypeScript compiler |
| `typescript-language-server` | TypeScript/JavaScript LSP |
| `vscode-langservers-extracted` | JSON, HTML, and CSS language servers |
| `yaml-language-server` | YAML LSP |

Required system executables: Python 3, pip, Git, Docker CLI, GitHub CLI (`gh`), and VS Code CLI (`code`). The Dev Container features for GitHub CLI and Docker-in-Docker are merged by the installer.

**PTY is mandatory.** `node-pty` is loaded as a required module during agent startup. Terminal sessions use PTY mode and there is no pipe-based terminal fallback. Non-terminal process sessions continue to use ordinary pipes.


## Security limits

- The relay URL must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1` development endpoints.
- Archive extraction snapshots the source before validation and extracts that same snapshot, rejecting source changes, symlinks, compressed archives over 512 MiB, links, special files, absolute/traversal paths, archives over 10,000 entries, files over 128 MiB, and total uncompressed content over 512 MiB. Extraction uses a fresh staging directory and requires an empty destination.
- Resumable uploads are limited to 256 MiB per transfer and 512 MiB reserved across all active transfers (20 sessions maximum).
- Process signalling is restricted to PIDs belonging to sessions started and tracked by this agent.
- Workspace reads and content-copy/archive operations reject hard-linked files so a workspace path cannot alias an external file; direct writes use atomic replacement to avoid modifying hard-linked referents. Workspace task discovery reads the root Makefile as bounded text and parses target declarations statically; it never invokes the make executable or evaluates Makefile functions while listing tasks.
- Untrusted child processes and installer/service/foreground-launcher verification subprocesses have credential, cloud, SSH/Git, npm-config, shell-function, and code-injection environment variables stripped; the foreground launcher keeps the agent token only in the parent process for the final agent exec. Dev Container dependency installation runs with a clean environment and no user npm config. Internal system commands resolve only to executables in root-owned, non-writable system paths; fixed GitHub CLI operations receive a scoped GH_TOKEN. Git remote operations attach that token only to matching HTTPS GitHub hosts, disable Git hooks and fsmonitor, clear ambient credential and askpass helpers, pin SSH to a fixed command without user SSH config, disable interactive prompts, and reject the ext transport. Submodule updates force checkout mode and use the same restricted transport and credential policy. Branch, tag, stash, and revision inputs are validated before Git receives them; reset/show/tag revisions are resolved to object IDs, and push branch arguments cannot carry force-refspec prefixes. Checkout/worktree-add operations suppress repository hooks.
- Relay requests have a 30-second timeout; JSON relay responses are capped at 1 MiB and outbound job results at 900 KiB.
- `fs.read` and legacy `transfer.read` are limited to 512 KiB; larger files must use chunked downloads. Directory listings are limited to 1,000 entries. Filesystem search scans at most 1,000 files / 16 MiB across 5,000 entries and skips individual files larger than 1 MiB; filename globs are limited to eight wildcard tokens to bound regex work.
- LSP and DAP queues are limited to 8 MiB of accounted message storage and 4,096 messages; each queued message accounts for at least 256 bytes of overhead.
- Terminal/process commands are limited to 16 KiB; terminal input is limited to 256 KiB per message and 1 MiB of queued pipe input, with bounded drain waits.
- Workspace path validation rejects symlink components, including symlinks that resolve back inside the workspace. Directory listing and stat operations use `lstat` so symlink metadata is not followed. Path-based filesystem operations still cannot provide a complete `openat2`-style race-free guarantee if an untrusted process concurrently replaces parent directories; isolate the agent from untrusted concurrent workspace writers.
- LSP and DAP transports cap headers at 8 KiB, messages at 8 MiB, receive buffers, queued message bytes, and pending input writes; incomplete oversized headers are rejected immediately.
- Forwarded-port checks are restricted to localhost and loopback IP addresses. Changing a forwarded port to `public` requires explicit `confirm: true`.
- Resumable uploads without overwrite permission use an atomic same-filesystem no-replace link at commit time, preventing a destination created after upload start from being overwritten.
- Process listing and inspection omit raw command-line arguments to reduce accidental disclosure of credentials passed through process arguments.
- The portable installer canonicalizes PATH entries and retains only root-owned, non-group/world-writable system directories (excluding workspace, home, and temporary paths), rejects symlinked destination paths, uses exclusive payload copies and atomic configuration writes, and strips inherited credentials before npm lifecycle scripts.

## Commands

After installation:

```bash
npm run codespace-agent:check
npm run codespace-agent:start
npm run codespace-agent:status
npm run codespace-agent:logs
npm run codespace-agent:stop
```

The check validates all required dependencies, compiles the TypeScript module, and runs regression tests. Every service-managed start runs the complete check before launching the agent.

## Host integration boundary

This bundle contains only the **Codespace-side runtime**. It does not contain the separate MCP host's GitHub REST tools, relay implementation, HTTP routes, or MCP server registration. The host application must independently authenticate the agent, expose the relay endpoints, queue jobs, and register its tools.

The agent executes shell, process, Dev Container, and debug-adapter commands with the Codespace user's permissions. It is not a security sandbox. Connect only trusted MCP clients and use least-privilege credentials.
