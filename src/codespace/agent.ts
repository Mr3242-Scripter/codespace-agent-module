import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { executeAdvanced } from "./advanced.js";

const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);
// PTY support is required: fail startup rather than silently disabling terminal resizing.
const ptyModule = localRequire("node-pty");
const baseUrl = (process.env.CODESPACE_AGENT_URL ?? "").replace(/\/+$/, "");
const token = process.env.CODESPACE_AGENT_TOKEN ?? "";
const codespace = process.env.CODESPACE_NAME ?? "";
const root = path.resolve(process.env.CODESPACE_WORKSPACE ?? process.cwd());
const rootReal = realpathSync(root);
type Session = { child: any; output: string; ended: boolean; exitCode: number | null; command: string; createdAt: string; pty: boolean };
const sessions = new Map<string, Session>();
function startSession(command: string, cwd = root, usePty = false) {
  if (sessions.size >= 50) throw new Error("Terminal/process session limit reached (50).");
  const safeCwd = resolvePath(cwd);
  const id = randomUUID();
  const session: Session = { child: null, output: "", ended: false, exitCode: null, command, createdAt: new Date().toISOString(), pty: Boolean(usePty && ptyModule) };
  const append = (chunk: string | Buffer) => { session.output = (session.output + chunk.toString()).slice(-100_000); };
  if (session.pty) {
    session.child = ptyModule.spawn("bash", ["-lc", command], {
      name: "xterm-256color", cols: 120, rows: 30, cwd: safeCwd, env: process.env
    });
    session.child.onData(append);
    session.child.onExit((event: { exitCode: number }) => { session.ended = true; session.exitCode = event.exitCode; });
  } else {
    session.child = spawn("bash", ["-lc", command], { cwd: safeCwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    session.child.stdout.on("data", append);
    session.child.stderr.on("data", append);
    session.child.on("close", (code: number | null) => { session.ended = true; session.exitCode = code; });
  }
  sessions.set(id, session);
  return { sessionId: id, pid: session.child.pid ?? null, pty: session.pty };
}
function signalSession(session: Session, signal: NodeJS.Signals): boolean {
  const pid = Number(session.child.pid);
  if (Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(-pid, signal); return true; }
    catch (error: any) { if (error?.code !== "ESRCH" && error?.code !== "EINVAL" && error?.code !== "EPERM") throw error; }
  }
  try { return Boolean(session.child.kill(signal)); } catch { return false; }
}
function readSession(id: string, clear = false) {
  const session = sessions.get(id);
  if (!session) throw new Error("Unknown or expired process session.");
  const result = { output: session.output, running: !session.ended, exitCode: session.exitCode, pid: session.child.pid ?? null };
  if (clear) session.output = "";
  return result;
}

function resolvePath(input = "."): string {
  const resolved = path.resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Path escapes the workspace root.");
  let probe = resolved;
  while (true) {
    try {
      const actual = realpathSync(probe);
      if (actual !== rootReal && !actual.startsWith(rootReal + path.sep)) throw new Error("Symlink resolves outside the workspace root.");
      break;
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  return resolved;
}
async function run(command: string, args: string[], cwd = root, timeout = 30_000) {
  const safeCwd = resolvePath(cwd);
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: safeCwd,
    timeout: Math.min(Math.max(timeout, 1000), 120_000),
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  return { stdout, stderr };
}
async function execute(operation: string, a: Record<string, any>): Promise<unknown> {
  const advanced = await executeAdvanced(operation, a);
  if (advanced !== undefined) return advanced;
  switch (operation) {
    case "workspace.info":
      return { name: codespace, root, cwd: process.cwd(), platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, memoryBytes: os.totalmem(), node: process.version };
    case "fs.list": {
      const dir = resolvePath(a.path ?? ".");
      return Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async d => {
        const full = path.join(dir, d.name); const stat = await fs.stat(full);
        return { name: d.name, path: path.relative(root, full), type: d.isDirectory() ? "directory" : d.isFile() ? "file" : "other", size: stat.size, modifiedAt: stat.mtime.toISOString() };
      }));
    }
    case "fs.read": return fs.readFile(resolvePath(a.path), "utf8");
    case "fs.stat": {
      const target = resolvePath(a.path);
      const stat = await fs.stat(target);
      return { path: path.relative(root, target), type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, mode: stat.mode, permissions: (stat.mode & 0o777).toString(8), createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString(), accessedAt: stat.atime.toISOString(), isSymbolicLink: (await fs.lstat(target)).isSymbolicLink() };
    }
    case "fs.find": {
      const matches: string[] = [], max = Math.min(Math.max(a.maxResults ?? 100, 1), 500);
      const pattern = String(a.pattern).toLowerCase();
      async function walk(dir: string): Promise<void> {
        if (matches.length >= max) return;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if ([".git", "node_modules", ".venv"].includes(entry.name)) continue;
          const full = resolvePath(path.relative(root, path.join(dir, entry.name)));
          if (entry.name.toLowerCase().includes(pattern)) matches.push(path.relative(root, full));
          if (entry.isDirectory()) await walk(full);
          if (matches.length >= max) break;
        }
      }
      await walk(resolvePath(a.path ?? ".")); return matches;
    }
    case "fs.chmod": {
      const mode = Number(a.mode);
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("mode must be a valid permission integer (0-511).");
      await fs.chmod(resolvePath(a.path), mode); return { changed: true, mode: mode.toString(8) };
    }
    case "fs.write": {
      const file = resolvePath(a.path);
      if (a.createParents) await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(a.content), "utf8"); return { written: true, path: file };
    }
    case "fs.mkdir": await fs.mkdir(resolvePath(a.path), { recursive: true }); return { created: true };
    case "fs.copy": {
      const from = resolvePath(a.from), to = resolvePath(a.to);
      if (!a.overwrite) { try { await fs.access(to); throw new Error("Destination already exists."); } catch (e: any) { if (e?.code !== "ENOENT") throw e; } }
      await fs.cp(from, to, { recursive: Boolean(a.recursive), force: Boolean(a.overwrite), errorOnExist: !a.overwrite, dereference: false });
      return { copied: true };
    }
    case "fs.delete": {
      const target = resolvePath(a.path);
      if (target === root) throw new Error("Refusing to delete workspace root.");
      await fs.rm(target, { recursive: Boolean(a.recursive), force: false }); return { deleted: true };
    }
    case "fs.move": {
      const from = resolvePath(a.from), to = resolvePath(a.to);
      if (!a.overwrite) { try { await fs.access(to); throw new Error("Destination already exists."); } catch (e: any) { if (e?.code !== "ENOENT") throw e; } }
      await fs.rename(from, to); return { moved: true };
    }
    case "fs.search": {
      const matches: string[] = [], max = Math.min(Math.max(a.maxResults ?? 100, 1), 500);
      const needle = String(a.query).toLowerCase();
      async function walk(dir: string): Promise<void> {
        if (matches.length >= max) return;
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if ([".git", "node_modules", ".venv"].includes(entry.name)) continue;
          const full = resolvePath(path.relative(root, path.join(dir, entry.name)));
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            try { if ((await fs.readFile(full, "utf8")).toLowerCase().includes(needle)) matches.push(path.relative(root, full)); } catch {}
          }
          if (matches.length >= max) break;
        }
      }
      await walk(resolvePath(a.path ?? ".")); return matches;
    }
    case "terminal.exec": return run("bash", ["-lc", String(a.command)], a.cwd ? resolvePath(a.cwd) : root, a.timeoutMs);
    case "terminal.start": return startSession(String(a.command), a.cwd ? resolvePath(a.cwd) : root, true);
    case "terminal.input": {
      const session = sessions.get(String(a.sessionId));
      if (!session || session.ended) throw new Error("Terminal session is not running.");
      if (session.pty) session.child.write(String(a.input)); else session.child.stdin.write(String(a.input)); return { sent: true, pty: session.pty };
    }
    case "terminal.read": return readSession(String(a.sessionId), Boolean(a.clear));
    case "terminal.close": {
      const session = sessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown terminal session.");
      const alreadyEnded = session.ended;
      if (!alreadyEnded) {
        signalSession(session, "SIGTERM");
        const gracefulDeadline = Date.now() + 1500;
        while (!session.ended && Date.now() < gracefulDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (!session.ended) {
          signalSession(session, "SIGKILL");
          const forceDeadline = Date.now() + 1000;
          while (!session.ended && Date.now() < forceDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      return { closed: session.ended, alreadyEnded, exitCode: session.exitCode };
    }
    case "terminal.list":
      return [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, command: session.command, pid: session.child.pid ?? null, running: !session.ended, exitCode: session.exitCode, createdAt: session.createdAt }));
    case "terminal.signal": {
      const session = sessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown terminal session.");
      const signal = String(a.signal ?? "SIGTERM");
      if (!["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGUSR1", "SIGUSR2"].includes(signal)) throw new Error("Unsupported terminal signal.");
      if (session.ended) return { signalled: false, alreadyEnded: true };
      return { signalled: signalSession(session, signal as NodeJS.Signals), signal };
    }
    case "terminal.resize": {
      const session = sessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown terminal session.");
      if (!session.pty || typeof session.child.resize !== "function") return { resized: false, available: false, reason: "This session was started without a pseudo-terminal. Install node-pty in the agent workspace and restart the agent to enable terminal resizing." };
      const cols = Number(a.cols), rows = Number(a.rows);
      if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal size must be 20-500 columns and 5-200 rows.");
      session.child.resize(cols, rows);
      return { resized: true, cols, rows };
    }
    case "process.list": return run("ps", ["-eo", "pid,ppid,stat,etime,args"]);
    case "process.start": return startSession(String(a.command), a.cwd ? resolvePath(a.cwd) : root);
    case "process.inspect": return run("ps", ["-p", String(a.pid), "-o", "pid,ppid,stat,etime,args"]);
    case "process.logs": return readSession(String(a.sessionId), Boolean(a.clear));
    case "process.kill": {
      const pid = Number(a.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Refusing to signal a protected or invalid PID.");
      process.kill(pid, "SIGTERM"); return { signalled: true, pid, signal: "SIGTERM" };
    }
    case "process.signal": {
      const pid = Number(a.pid), signal = String(a.signal ?? "SIGTERM");
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Refusing to signal a protected or invalid PID.");
      if (!["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGUSR1", "SIGUSR2"].includes(signal)) throw new Error("Unsupported process signal.");
      process.kill(pid, signal as NodeJS.Signals);
      return { signalled: true, pid, signal };
    }
    case "git.status": return run("git", ["status", "--short", "--branch"], a.cwd ? resolvePath(a.cwd) : root);
    case "git.diff": return run("git", ["diff", ...(a.staged ? ["--cached"] : [])], a.cwd ? resolvePath(a.cwd) : root);
    case "git.log": return run("git", ["log", "--oneline", "-n", String(a.limit ?? 20)], a.cwd ? resolvePath(a.cwd) : root);
    case "git.branch": return run("git", ["branch", "--show-current"], a.cwd ? resolvePath(a.cwd) : root);
    case "git.checkout": return run("git", ["checkout", ...(a.create ? ["-b"] : []), String(a.branch)], a.cwd ? resolvePath(a.cwd) : root);
    case "git.pull": return run("git", ["pull", a.remote ?? "origin", ...(a.branch ? [a.branch] : [])], a.cwd ? resolvePath(a.cwd) : root, 120_000);
    case "git.push": return run("git", ["push", a.remote ?? "origin", ...(a.branch ? [a.branch] : [])], a.cwd ? resolvePath(a.cwd) : root, 120_000);
    case "git.commit": {
      const cwd = a.cwd ? resolvePath(a.cwd) : root;
      if (a.all) await run("git", ["add", "-A"], cwd);
      return run("git", ["commit", "-m", String(a.message)], cwd, 120_000);
    }
    case "git.fetch": return run("git", ["fetch", a.remote ?? "origin"], a.cwd ? resolvePath(a.cwd) : root, 120_000);
    case "git.add": {
      const cwd = a.cwd ? resolvePath(a.cwd) : root;
      const paths = (a.paths ?? ["."]).map((p: string) => path.relative(cwd, resolvePath(p)));
      return run("git", ["add", "--", ...paths], cwd, 120_000);
    }
    case "git.reset": {
      const cwd = a.cwd ? resolvePath(a.cwd) : root;
      const mode = a.mode ?? "mixed";
      if (mode === "hard" && a.confirm !== true) throw new Error("Hard reset requires confirm=true.");
      return run("git", ["reset", `--${mode}`, ...(a.ref ? [String(a.ref)] : [])], cwd, 120_000);
    }
    case "git.stash": {
      const cwd = a.cwd ? resolvePath(a.cwd) : root;
      const action = a.action ?? "list";
      const args = action === "push" ? ["stash", "push", ...(a.message ? ["-m", String(a.message)] : [])]
        : action === "pop" ? ["stash", "pop"]
        : action === "drop" ? ["stash", "drop", ...(a.stashRef ? [String(a.stashRef)] : [])]
        : ["stash", "list"];
      if (action === "drop" && a.confirm !== true) throw new Error("Dropping a stash requires confirm=true.");
      return run("git", args, cwd, 120_000);
    }
    case "git.show": return run("git", ["show", "--stat", "--oneline", String(a.ref ?? "HEAD")], a.cwd ? resolvePath(a.cwd) : root);
    case "git.remote": return run("git", ["remote", "-v"], a.cwd ? resolvePath(a.cwd) : root);
    case "git.tag": {
      const cwd = a.cwd ? resolvePath(a.cwd) : root;
      if (a.action === "create") return run("git", ["tag", ...(a.message ? ["-a", String(a.name), "-m", String(a.message)] : [String(a.name)]), ...(a.ref ? [String(a.ref)] : [])], cwd);
      if (a.action === "delete") {
        if (a.confirm !== true) throw new Error("Deleting a tag requires confirm=true.");
        return run("git", ["tag", "-d", String(a.name)], cwd);
      }
      return run("git", ["tag", "--list"], cwd);
    }
    case "debug.start": {
      const command = Array.isArray(a.command) ? a.command.map(String) : [];
      if (!command.length || command.length > 64 || command.some(part => part.length > 4096)) throw new Error("Debug adapter command must be a non-empty argv array.");
      const child = spawn(command[0], command.slice(1), { cwd: a.cwd ? resolvePath(a.cwd) : root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      const id = randomUUID();
      const session: DebugSession = { child, buffer: Buffer.alloc(0), messages: [], stderr: "", ended: false, exitCode: null };
      child.stdout.on("data", (chunk: Buffer) => { try { session.buffer = Buffer.concat([session.buffer, chunk]); parseDebugMessages(session); } catch (error) { session.stderr = (session.stderr + (error instanceof Error ? error.message : String(error))).slice(-50_000); child.kill("SIGTERM"); } });
      child.stderr.on("data", (chunk: Buffer) => { session.stderr = (session.stderr + chunk.toString("utf8")).slice(-50_000); });
      child.on("close", (code: number | null) => { session.ended = true; session.exitCode = code; });
      child.on("error", (error: Error) => { session.stderr = (session.stderr + error.message).slice(-50_000); session.ended = true; });
      debugSessions.set(id, session);
      return { sessionId: id, pid: child.pid ?? null, protocol: "Debug Adapter Protocol" };
    }
    case "debug.send": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session || session.ended) throw new Error("Debug adapter session is not running.");
      const message = a.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("message must be a DAP JSON object.");
      const body = Buffer.from(JSON.stringify(message), "utf8");
      if (body.length > 8 * 1024 * 1024) throw new Error("DAP message exceeds 8 MiB.");
      session.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
      return { sent: true, bytes: body.length };
    }
    case "debug.read": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown debug adapter session.");
      const limit = Math.min(Math.max(Number(a.maxMessages ?? 100), 1), 500);
      return { messages: session.messages.splice(0, limit), stderr: session.stderr, running: !session.ended, exitCode: session.exitCode };
    }
    case "debug.close": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown debug adapter session.");
      if (!session.ended) session.child.kill("SIGTERM");
      return { closed: true, alreadyEnded: session.ended };
    }
    case "environment.info": {
      const names = Object.keys(process.env).filter(k => /TOKEN|SECRET|PASSWORD|KEY|COOKIE|AUTH/i.test(k));
      return { codespace, workspace: root, platform: os.platform(), arch: os.arch(), node: process.version, envVariableNames: Object.keys(process.env), redactedSecretVariableNames: names };
    }
    case "environment.tools": {
      const checks = await Promise.all(["node", "npm", "pnpm", "yarn", "git", "python3", "pip3", "docker", "gh", "code", "devcontainer"].map(async name => {
        try { const r = await execFileAsync(name, ["--version"], { cwd: root, timeout: 5000, maxBuffer: 8192 }); return { name, available: true, version: (r.stdout || r.stderr).trim().split("\n")[0] }; }
        catch { return { name, available: false }; }
      }));
      return checks;
    }
    case "vscode.extensions.list": {
      try {
        const result = await run("code", ["--list-extensions", "--show-versions"]);
        return { ...result, source: "code-cli" };
      } catch (error: any) {
        const candidates = [
          process.env.CODESPACE_VSCODE_FOLDER ? path.join(process.env.CODESPACE_VSCODE_FOLDER, "extensions") : "",
          path.join(os.homedir(), ".vscode-remote", "extensions"),
          path.join(os.homedir(), ".vscode-server", "extensions"),
          "/home/codespace/.vscode-remote/extensions"
        ].filter(Boolean);
        const extensions: Array<{ id: string; version: string; path: string }> = [];
        for (const directory of [...new Set(candidates)]) {
          let entries: string[];
          try { entries = await fs.readdir(directory); } catch { continue; }
          for (const entry of entries) {
            const manifest = path.join(directory, entry, "package.json");
            try {
              const pkg = JSON.parse(await fs.readFile(manifest, "utf8"));
              if (typeof pkg.publisher === "string" && typeof pkg.name === "string") {
                extensions.push({ id: `${pkg.publisher}.${pkg.name}`, version: String(pkg.version ?? "unknown"), path: path.join(directory, entry) });
              }
            } catch {}
          }
        }
        if (extensions.length) return { source: "extension-directory-fallback", extensions };
        throw new Error(`Could not list VS Code extensions with the CLI or inspect known extension directories: ${error?.message ?? String(error)}`);
      }
    }
    case "vscode.extensions.install": {
      const id = String(a.extensionId ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id)) throw new Error("A valid publisher.extension identifier is required.");
      return run("code", ["--install-extension", id, ...(a.force ? ["--force"] : [])], root, 120_000);
    }
    case "vscode.extensions.uninstall": {
      const id = String(a.extensionId ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(id)) throw new Error("A valid publisher.extension identifier is required.");
      if (a.confirm !== true) throw new Error("Uninstalling an extension requires confirm=true.");
      return run("code", ["--uninstall-extension", id], root, 120_000);
    }
    case "devcontainer.inspect": {
      const candidates = [".devcontainer/devcontainer.json", ".devcontainer.json"];
      for (const relative of candidates) {
        const file = resolvePath(relative);
        try { return { path: relative, content: await fs.readFile(file, "utf8") }; }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      }
      return { found: false, candidates };
    }
    case "devcontainer.read_configuration":
    case "devcontainer.validate": {
      const candidates = [a.config ? String(a.config) : ".devcontainer/devcontainer.json", ".devcontainer.json"];
      let selected: string | null = null, raw = "";
      for (const candidate of candidates) {
        try { selected = candidate; raw = await fs.readFile(resolvePath(candidate), "utf8"); break; }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      }
      if (!selected) return { valid: false, found: false, candidates, reason: "No devcontainer configuration file was found." };
      try {
        const config = JSON.parse(raw);
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Configuration root must be a JSON object.");
        const issues: string[] = [];
        if (!config.image && !config.build && !config.dockerFile && !config.dockerfile) issues.push("Specify image, build, or dockerFile.");
        if (config.postStartCommand !== undefined && typeof config.postStartCommand !== "string" && typeof config.postStartCommand !== "object") issues.push("postStartCommand must be a string, array, or object.");
        return { valid: issues.length === 0, found: true, path: selected, config, issues, validation: "static-json", note: "Docker-based schema/build validation requires the Codespaces host; this checks JSON structure and common required fields." };
      } catch (error: any) {
        return { valid: false, found: true, path: selected, error: error.message, validation: "json-parse" };
      }
    }
    case "devcontainer.build":
      if (a.confirm !== true) throw new Error("Building a Dev Container requires confirm=true.");
      return { available: false, requiresHostControlPlane: true, message: "A local image build cannot run inside the Codespace agent because the host Docker daemon is not mounted. Use devcontainer.up to request a Codespaces rebuild through GitHub CLI." };
    case "devcontainer.up": {
      if (a.confirm !== true) throw new Error("Rebuilding a Codespace requires confirm=true.");
      try {
        const args = ["codespace", "rebuild", "--codespace", codespace, ...(a.removeExistingContainer ? ["--full"] : [])];
        const result = await run("gh", args, root, 120_000);
        return { requested: true, operation: "codespace-rebuild", ...result, note: "The Codespace may disconnect while GitHub rebuilds its container. The agent should reconnect through the configured postStartCommand." };
      } catch (error: any) {
        return { requested: false, available: false, reason: error?.message ?? String(error), fallback: "Run 'Codespaces: Rebuild Container' from the GitHub Codespaces Command Palette." };
      }
    }
    case "devcontainer.exec": {
      const command = Array.isArray(a.command) ? a.command.map(String) : [];
      if (!command.length || command.length > 64 || command.some(part => part.length > 4096)) throw new Error("command must be a non-empty argv array (maximum 64 entries).");
      return run(command[0], command.slice(1), root, 120_000);
    }
    case "workspace.disk_usage": {
      const filesystem = await run("df", ["-h", root], root);
      const workspace = await run("du", ["-sh", "--exclude=node_modules", "--exclude=.git", root], root, 120_000);
      return { filesystem, workspace };
    }
    case "ports.inspect":
    case "ports.list": {
      if (operation === "ports.list") {
        try {
          const forwarded = await run("gh", ["codespace", "ports", "--codespace", codespace, "--json", "sourcePort,visibility,browseUrl,label"], root, 15000);
          return { source: "gh-codespace-ports", forwardedPorts: JSON.parse(forwarded.stdout || "[]") };
        } catch {}
      }
      const listeners: Array<{ protocol: string; addressHex: string; port: number; state: string }> = [];
      for (const [file, protocol] of [["/proc/net/tcp", "tcp"], ["/proc/net/tcp6", "tcp6"]] as const) {
        try {
          const lines = (await fs.readFile(file, "utf8")).trim().split(/\\r?\\n/).slice(1);
          for (const line of lines) {
            const fields = line.trim().split(/\\s+/);
            if (fields.length < 4 || fields[3] !== "0A") continue;
            const [addressHex, portHex] = fields[1].split(":");
            const port = Number.parseInt(portHex, 16);
            if (a.port !== undefined && port !== Number(a.port)) continue;
            listeners.push({ protocol, addressHex, port, state: "LISTEN" });
          }
        } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      }
      if (listeners.length || await fs.access("/proc/net/tcp").then(()=>true).catch(()=>false)) {
        return { source: "/proc/net/tcp", listeners, count: listeners.length, forwardedPortsAvailable: false, note: "Local listening sockets are shown. Install/authenticate GitHub CLI to retrieve forwarded-port metadata with gh codespace ports." };
      }
      const args = ["-ltn"];
      if (a.port !== undefined) args.push("sport", "=", `:${Number(a.port)}`);
      const ss = await run("ss", args).catch(async () => run("netstat", ["-lnt"]));
      return { ...ss, source: "ss/netstat-fallback" };
    }
    case "ports.update": {
      const port = Number(a.port);
      const visibility = String(a.visibility);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535.");
      if (!["private", "org", "public"].includes(visibility)) throw new Error("visibility must be private, org, or public.");
      try {
        const result = await run("gh", ["codespace", "ports", "visibility", `${port}:${visibility}`, "--codespace", codespace], root, 30000);
        return { updated: true, available: true, codespace, port, visibility, ...result };
      } catch (error: any) {
        return { updated: false, available: false, codespace, port, visibility, reason: error?.code === "ENOENT" ? "GitHub CLI (gh) is not installed in this Codespace." : error?.message ?? String(error), installHint: "Install the GitHub CLI or add the official github-cli Dev Container feature, then restart the agent." };
      }
    }
    case "ports.check": {
      const port = Number(a.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535.");
      const host = String(a.host ?? "127.0.0.1");
      const timeoutMs = Math.min(Math.max(Number(a.timeoutMs ?? 2000), 250), 10000);
      return await new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        let finished = false;
        const finish = (open: boolean, error?: string) => { if (finished) return; finished = true; socket.destroy(); resolve({ host, port, open, ...(error ? { error } : {}) }); };
        socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
        socket.once("connect", () => finish(true));
        socket.once("error", error => finish(false, error.message));
      });
    }
    case "archive.create": return run("tar", ["-czf", resolvePath(a.output), "-C", path.dirname(resolvePath(a.path)), path.basename(resolvePath(a.path))]);
    case "archive.extract": {
      const archive = resolvePath(a.archive), destination = resolvePath(a.destination);
      const listing = await run("tar", ["-tvzf", archive]);
      const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
      if (entries.some(entry => /^[lh]/.test(entry) || entry.includes("../") || entry.includes("..\\\\") || entry.includes("/..") || entry.includes("\\.."))) {
        throw new Error("Archive contains a link or unsafe path.");
      }
      await fs.mkdir(destination, { recursive: true });
      return run("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", destination]);
    }
    case "transfer.read": return { contentBase64: (await fs.readFile(resolvePath(a.path))).toString("base64") };
    case "transfer.write": await fs.writeFile(resolvePath(a.path), Buffer.from(String(a.contentBase64), "base64")); return { written: true };
    default: throw new Error(`Unsupported agent operation: ${operation}`);
  }
}

type DebugSession = { child: ReturnType<typeof spawn>; buffer: Buffer; messages: unknown[]; stderr: string; ended: boolean; exitCode: number | null };
const debugSessions = new Map<string, DebugSession>();
function parseDebugMessages(session: DebugSession): void {
  while (true) {
    const boundary = session.buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = session.buffer.subarray(0, boundary).toString("ascii");
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Invalid Debug Adapter Protocol header.");
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error("Invalid Debug Adapter Protocol message length.");
    const start = boundary + 4;
    if (session.buffer.length < start + length) return;
    const body = session.buffer.subarray(start, start + length).toString("utf8");
    session.buffer = session.buffer.subarray(start + length);
    try { session.messages.push(JSON.parse(body)); }
    catch { session.messages.push({ parseError: true, body }); }
    if (session.messages.length > 500) session.messages.shift();
  }
}
async function request(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
export async function runCodespaceAgent(): Promise<void> {
  if (!baseUrl || !token || token.length < 32 || !codespace) throw new Error("Set CODESPACE_AGENT_URL, CODESPACE_AGENT_TOKEN (32+ chars), and CODESPACE_NAME.");
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.log(`Codespaces agent connected for ${codespace}; workspace ${root}`);
  let heartbeatInFlight = false;
  const sendHeartbeat = async () => {
    if (heartbeatInFlight || stopping) return;
    heartbeatInFlight = true;
    try {
      const response = await request(`${baseUrl}/codespaces/agent/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ codespace }),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Heartbeat failed: ${response.status}`);
    } catch (error) {
      if (!stopping) console.error("Codespaces agent heartbeat error:", error);
    } finally {
      heartbeatInFlight = false;
    }
  };
  await sendHeartbeat();
  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, 20_000);
  heartbeatTimer.unref?.();
  let backoff = 1000;
  try {
  while (!stopping) {
    try {
      const poll = await request(`${baseUrl}/codespaces/agent/poll?name=${encodeURIComponent(codespace)}`);
      if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`);
      backoff = 1000;
      const { job } = await poll.json() as { job: null | { id: string; operation: string; args: Record<string, any> } };
      if (!job) continue;
      let value: unknown, ok = true;
      try { value = await execute(job.operation, job.args); }
      catch (error) { ok = false; value = error instanceof Error ? error.message : String(error); }
      let delivered = false;
      for (let attempt=0; attempt<5 && !stopping; attempt++) {
        try {
          const response = await request(`${baseUrl}/codespaces/agent/result`, { method:"POST", body:JSON.stringify({id:job.id,codespace,ok,value}) });
          if (!response.ok) throw new Error(`Result delivery failed: ${response.status}`);
          const receipt = await response.json() as { accepted?: boolean };
          if (receipt.accepted !== true) throw new Error("Relay rejected or expired this job result.");
          delivered=true; break;
        } catch (error) {
          if (attempt===4) console.error("Could not deliver Codespaces job result:",error);
          else await delay(Math.min(1000*2**attempt,10000));
        }
      }
      if (!delivered && !stopping) await delay(1000);
    } catch (error) {
      if (stopping) break;
      console.error("Codespaces agent connection error:",error);
      await delay(backoff); backoff=Math.min(backoff*2,30000);
    }
  }
  } finally {
    clearInterval(heartbeatTimer);
  }
  console.log(`Codespaces agent stopped for ${codespace}`);
}
