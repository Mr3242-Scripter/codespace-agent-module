# GitHub Codespaces MCP module

This directory contains the isolated Codespaces integration module. It currently registers **151 MCP tools**: 52 direct GitHub REST tools, 1 relay-status tool, and 98 Codespace-agent tools.

## Coverage

### GitHub Codespaces REST API

The module exposes the documented Codespaces endpoint families for:

- Authenticated-user Codespaces: list (including repository ID filtering), create, get, update, delete, start, stop, and restart.
- Repository Codespaces: list and create.
- Pull-request Codespaces: create from a pull request.
- Repository setup: list devcontainer configurations, fetch default creation attributes, check devcontainer permission acceptance.
- Machine types: list repository machine types and machine types for an existing Codespace.
- Export and publish: start an export, inspect export status, and publish an unpublished Codespace.
- Forwarded ports: list ports and update port visibility.
- Organization administration: list organization Codespaces, configure access policy, add/remove selected users, list a member's Codespaces, and stop/delete a member's Codespace.
- User, repository, and organization Codespaces secrets: list metadata, retrieve public keys, create/update encrypted secrets, delete secrets, and manage selected repository access where supported.
- `codespace_api_request`: restricted fallback for documented Codespaces REST paths not represented by a dedicated tool. Mutations require `confirm: true`.

Secret write APIs accept GitHub-encrypted values only (`encryptedValue` and `keyId`). GitHub does not return secret plaintext.

### Codespace agent

The agent provides:

- Workspace/runtime information, disk usage, installed-tool version checks, health monitoring, system diagnostics, and resource monitoring.
- Workspace task discovery and confirmed execution of package scripts, test, and build tasks.
- File and directory change watchers with bounded event queues.
- Filesystem list, read, stat, filename search, content search, write, mkdir, chmod, copy, move, and delete.
- One-shot shell commands and persistent terminal sessions, including session listing, input, resize, and signal controls. PTY mode uses optional `node-pty`; without it, sessions fall back to pipe-based I/O and resizing is unavailable.
- Process list, start, inspect, logs, terminate, and allowlisted signal delivery.
- Git status, diff, log, branch, checkout, fetch, add, pull, commit, push, reset, stash, show, remotes, tags, worktrees, and submodules.
- VS Code extension listing, installation, and removal through the Codespace `code` CLI; read/write `.vscode` settings, tasks, launch, and extension recommendation files.
- Generic Language Server Protocol (LSP) JSON-RPC sessions for launching a language server, sending messages, reading notifications/responses, and closing the process.
- Dev Container configuration inspection and validation, build, startup/rebuild, and command execution through the Dev Container CLI.
- Debug Adapter Protocol (DAP) adapter sessions: launch an adapter process, send framed DAP JSON messages, read adapter responses/events, and close the session.
- Local TCP/UDP listening-port inspection, optional per-port filtering, TCP reachability checks, and GitHub forwarded-port visibility controls.
- Tar archive creation/extraction, bounded batch sync, and chunked upload/download (256 KiB chunks; uploads up to 1 GiB per session). Upload sessions live in the agent process and are not restored after an agent restart.

DAP transport is a protocol bridge to a separately installed debug adapter; it does not emulate the VS Code debugger UI or implement VS Code's complete remote-development client.

### Relay and agent status

- The `codespace_agent_status` tool reports whether a named agent has polled recently and how many jobs are queued.
- Relay jobs are associated with the exact Codespace name; a result from a different Codespace cannot resolve the pending request.
- The relay tracks the last poll time and exposes authenticated agent status.
- The agent uses bounded exponential reconnect delays and retries transient result-delivery failures.
- Per-Codespace agent tokens are supported through `agentTokens`; the shared `agentToken` remains as a compatibility fallback.

The default `CodespaceRelay` queue is in-memory and is not shared between Render instances. `RedisCodespaceRelay` adds an Upstash-compatible Redis REST backend for shared queues, pending-job metadata, results, and agent heartbeats. Configure Redis durability/availability and use the same Redis endpoint, token, and prefix on every Render instance. Queued jobs survive individual host-process restarts while their Redis keys remain alive, but an MCP call whose host connection crashes is not automatically resumed for its original caller. An agent that exits after claiming a job may leave that job unavailable until its request expires.

## Files

- `api.ts` — GitHub Codespaces REST API client.
- `tools.ts` — MCP tool schemas and registrations.
- `relay.ts` — authenticated in-memory relay, relay interface, status, and per-Codespace token support.
- `redis-relay.ts` — shared Redis REST relay for durable, multi-instance job routing.
- `setup.ts` — one-call Express/MCP host integration helper that selects in-memory or Redis relay.
- `agent.ts` — Codespace-side workspace, terminal, process, DAP, Dev Container, and port agent.
- `advanced.ts` — bounded file editing/sync, diagnostics, resource monitoring, VS Code workspace configuration, and container log helpers.
- `supervisor.ts` — optional restart-on-exit process supervisor for Codespace lifecycle hooks.
- `agent-entry.ts` — supervised Codespace agent entry point.
- `agent-start.sh` — foreground launcher for manual use.
- `agent-service.sh` — background start/stop/restart/status manager with PID and log files.
- `devcontainer-lifecycle.example.json` — `postStartCommand` example.
- `index.ts` — module exports.
- `tsconfig.json` and `check.sh` — isolated module type-check and relay-test runner.

## Host integration still required

The module is intentionally isolated in this directory. The existing MCP host must import it, create one relay, register its tools, and mount the agent routes. **The host entry point has not been modified**, so these tools are not active in the deployed Render service yet.

Example host wiring:

```ts
import { configureCodespacesIntegration } from "./codespace/index.js";

const codespaceRelay = configureCodespacesIntegration(server, app, {
  githubToken: process.env.GITHUB_TOKEN!,
  agentToken: process.env.CODESPACE_AGENT_TOKEN!,
  agentTokens: JSON.parse(process.env.CODESPACE_AGENT_TOKENS_JSON ?? "{}"),
  // Optional Upstash Redis REST credentials for shared durable relay state.
  ...(process.env.CODESPACE_REDIS_REST_URL && process.env.CODESPACE_REDIS_REST_TOKEN ? {
    redis: { url: process.env.CODESPACE_REDIS_REST_URL, token: process.env.CODESPACE_REDIS_REST_TOKEN }
  } : {})
});
```

This example is documentation only. It does not modify the host application.

## Agent setup

Run the agent in each Codespace with Node.js and the repository's `tsx` dependency. Set:

- `CODESPACE_AGENT_URL` — base URL of the deployed MCP server.
- `CODESPACE_AGENT_TOKEN` — random secret of at least 32 characters. Use the fallback token, or the unique token assigned to this Codespace in Render's `CODESPACE_AGENT_TOKENS_JSON` map.
- `CODESPACE_NAME` — exact Codespace name from GitHub.
- `CODESPACE_WORKSPACE` — workspace directory (defaults to the current directory).

Launch from the repository root:

```bash
bash src/codespace/agent-service.sh start
```

The service manager starts the supervisor in the background, avoids duplicate starts, records its PID, and writes logs to `~/.codespace-agent.log`. Use `bash src/codespace/agent-service.sh stop|restart|status` to manage it. To automate startup and shutdown, merge `devcontainer-lifecycle.example.json` into your existing `.devcontainer/devcontainer.json`. The agent supervisor handles termination signals when the Codespace stops. The existing repository devcontainer configuration is intentionally untouched.

## Security and operational notes

- Use a dedicated GitHub token with only the Codespaces permissions needed.
- Keep agent tokens private and out of source control and logs. Prefer unique per-Codespace tokens over the shared fallback.
- Filesystem APIs constrain paths to the configured workspace root, but shell, process, Dev Container, and debug-adapter commands execute with the Codespace user's permissions and are not a security sandbox. Only connect trusted MCP clients.
- Destructive operations require explicit confirmation fields. Public port exposure also requires explicit confirmation.
- Organization administration and secret-management calls require the corresponding GitHub permissions and are subject to organization policy and GitHub plan availability.
- PTY resizing requires `node-pty` to be installed in the agent environment. VS Code and Dev Container operations require their respective CLIs.
- GitHub's Codespaces API controls forwarded-port visibility, while creation of an actual client-side port-forwarding tunnel is managed by the Codespaces client; the in-Codespace agent cannot create that client-side tunnel.
- The advanced operations are implemented inside this directory and are reached through the existing agent dispatcher. Batch sync is limited to 1 MiB per request to stay within the relay's default HTTP body limit; use chunked transfer for larger files. Directory manifests skip common generated/dependency folders. Watchers use the Node filesystem watcher and may be non-recursive or unsupported recursively on some runtimes. VS Code configuration writes are limited to JSON files under `.vscode/`. Docker/Dev Container log access requires Docker CLI permissions.

Redis-backed relay requires a compatible Redis REST endpoint (for example Upstash) and the same credentials on every host instance. The setup helper does not provision Redis resources. LSP sessions provide raw protocol transport; they do not implement editor UI features, semantic-token rendering, or automatic diagnostics.

Run `bash src/codespace/check.sh` from any directory to type-check this module and execute the focused relay tests. The check has not yet been run in this environment, and end-to-end integration against a live Codespace/Redis service remains unverified.

## Scope

This module covers the documented GitHub Codespaces REST endpoint families and the agent operations listed above. It cannot expose undocumented GitHub internals, bypass token permissions, or provide feature-for-feature parity with the VS Code remote client. Actual availability depends on the Codespace environment, installed CLIs, token permissions, and organization policy.
