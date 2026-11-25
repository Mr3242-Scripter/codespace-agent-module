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
import { assertNoSymlinkComponents, assertProtocolBufferCapacity, assertProtocolQueueCapacity, createBoundedFileSnapshot, createChildProcessEnv, createGitHubCliEnv, filterTrustedExecutablePath, readFileBounded, readFileBufferBounded, inspectArchiveListing, isLoopbackHost, matchesFilenamePattern, pruneEndedSessions, requirePublicPortConfirmation, requireTrackedSession, resolveTrustedExecutable, validateRelayUrl } from "./agent-utils.js";

const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);
// PTY support is mandatory. Fail immediately if the native module is missing or cannot load.
const ptyModule = localRequire("node-pty");
const baseUrl = (process.env.CODESPACE_AGENT_URL ?? "").replace(/\/+$/, "");
const token = process.env.CODESPACE_AGENT_TOKEN ?? "";
delete process.env.CODESPACE_AGENT_TOKEN;
const childEnv = createChildProcessEnv();
const codespace = process.env.CODESPACE_NAME ?? "";
const root = realpathSync(path.resolve(process.env.CODESPACE_WORKSPACE ?? process.cwd()));
const systemEnv = { ...childEnv, PATH: filterTrustedExecutablePath(process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", root) };
type Session = { child: any; output: string; ended: boolean; endedAt: number | null; exitCode: number | null; command: string; createdAt: string; pty: boolean };
const sessions = new Map<string, Session>();
function startSession(command: string, cwd = root, usePty = false) {
  pruneEndedSessions(sessions, Date.now(), 10 * 60_000, 100);
  if ([...sessions.values()].filter(session => !session.ended).length >= 50) throw new Error("Terminal/process session limit reached (50 active sessions).");
  const safeCwd = resolvePath(cwd);
  const id = randomUUID();
  const session: Session = { child: null, output: "", ended: false, endedAt: null, exitCode: null, command, createdAt: new Date().toISOString(), pty: Boolean(usePty) };
  const append = (chunk: string | Buffer) => { session.output = (session.output + chunk.toString()).slice(-100_000); };
  if (session.pty) {
    session.child = ptyModule.spawn(process.platform === "win32" ? "bash" : "/bin/bash", ["-lc", command], {
      name: "xterm-256color", cols: 120, rows: 30, cwd: safeCwd, env: childEnv
    });
    session.child.onData(append);
    session.child.onExit((event: { exitCode: number }) => { session.ended = true; session.endedAt = Date.now(); session.exitCode = event.exitCode; });
  } else {
    session.child = spawn(process.platform === "win32" ? "bash" : "/bin/bash", ["-lc", command], { cwd: safeCwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    session.child.stdout.on("data", append);
    session.child.stderr.on("data", append);
    session.child.on("close", (code: number | null) => { session.ended = true; session.endedAt = Date.now(); session.exitCode = code; });
  }
  sessions.set(id, session);
  pruneEndedSessions(sessions, Date.now(), 10 * 60_000, 100);
  return { sessionId: id, pid: session.child.pid ?? null, pty: session.pty };
}
function signalChildTree(child: any, signal: NodeJS.Signals): boolean {
  const pid = Number(child?.pid);
  if (process.platform !== "win32" && Number.isSafeInteger(pid) && pid > 1) {
    try { process.kill(-pid, signal); return true; }
    catch (error: any) { if (error?.code !== "ESRCH" && error?.code !== "EINVAL" && error?.code !== "EPERM") throw error; }
  }
  try { return Boolean(child?.kill(signal)); } catch { return false; }
}
function signalSession(session: Session, signal: NodeJS.Signals): boolean {
  return signalChildTree(session.child, signal);
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
  assertNoSymlinkComponents(root, resolved);
  return resolved;
}
async function resolveExecutable(command: string): Promise<string> {
  if (command.includes(path.sep)) return command;
  return resolveTrustedExecutable(command, systemEnv.PATH ?? "", root);
}
async function run(command: string, args: string[], cwd = root, timeout = 30_000, env: NodeJS.ProcessEnv = systemEnv) {
  const safeCwd = resolvePath(cwd);
  const executable = await resolveExecutable(command);
  const timeoutMs = Math.min(Math.max(timeout, 1000), 120_000);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: safeCwd, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true
    });
    let stdout = "", stderr = "", totalBytes = 0, timedOut = false, overflow = false, settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const signalTree = (signal: NodeJS.Signals) => {
      const pid = Number(child.pid);
      if (process.platform !== "win32" && Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(-pid, signal); return; }
        catch (error: any) { if (error?.code !== "ESRCH" && error?.code !== "EINVAL" && error?.code !== "EPERM") throw error; }
      }
      try { child.kill(signal); } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      forceTimer = setTimeout(() => signalTree("SIGKILL"), 1000);
    }, timeoutMs);
    const finish = (error?: Error, value?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error); else resolve(value ?? { stdout, stderr });
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      totalBytes += chunk.length;
      if (target === "stdout") stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024);
      else stderr = (stderr + chunk.toString()).slice(-2 * 1024 * 1024);
      if (totalBytes > 2 * 1024 * 1024 && !overflow) {
        overflow = true;
        signalTree("SIGTERM");
        forceTimer = setTimeout(() => signalTree("SIGKILL"), 1000);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error: Error) => finish(error));
    child.once("close", (code: number | null) => {
      if (timedOut) return finish(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
      if (overflow) return finish(new Error(`Command output exceeded the 2 MiB limit: ${command} ${args.join(" ")}`));
      if (code !== 0) {
        const error: any = new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr || `exit code ${code}`}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        return finish(error);
      }
      finish(undefined, { stdout, stderr });
    });
  });
}
async function execute(operation: string, a: Record<string, any>): Promise<unknown> {
  const advanced = await executeAdvanced(operation, a);
  if (advanced !== undefined) return advanced;
  switch (operation) {
    case "workspace.info":
      return { name: codespace, root, cwd: process.cwd(), platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, memoryBytes: os.totalmem(), node: process.version };
    case "fs.list": {
      const dir = resolvePath(a.path ?? ".");
      const entries: import("node:fs").Dirent[] = [];
      const directory = await fs.opendir(dir);
      for await (const entry of directory) {
        if (entries.length >= 1000) throw new Error("Directory listing exceeds the 1000-entry limit.");
        entries.push(entry);
      }
      return Promise.all(entries.map(async d => {
        const full = path.join(dir, d.name); const stat = await fs.lstat(full);
        return { name: d.name, path: path.relative(root, full), type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, modifiedAt: stat.mtime.toISOString() };
      }));
    }
    case "fs.read": return readFileBounded(resolvePath(a.path), 512 * 1024);
    case "fs.stat": {
      const target = resolvePath(a.path);
      const stat = await fs.lstat(target);
      return { path: path.relative(root, target), type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", size: stat.size, mode: stat.mode, permissions: (stat.mode & 0o777).toString(8), createdAt: stat.birthtime.toISOString(), modifiedAt: stat.mtime.toISOString(), accessedAt: stat.atime.toISOString(), isSymbolicLink: stat.isSymbolicLink() };
    }
    case "fs.find": {
      const matches: string[] = [];
      const requestedMax = Number(a.maxResults ?? 100);
      const max = Number.isFinite(requestedMax) ? Math.min(Math.max(Math.trunc(requestedMax), 1), 500) : 100;
      const pattern = String(a.pattern);
      if (!pattern || pattern.length > 4096) throw new Error("Filename pattern must contain 1-4096 characters.");
      const searchRoot = resolvePath(a.path ?? ".");
      let visitedEntries = 0;
      async function walk(dir: string): Promise<void> {
        if (matches.length >= max) return;
        const directory = await fs.opendir(dir);
        for await (const entry of directory) {
          if (++visitedEntries > 5000) throw new Error("Filesystem find exceeds the 5000-entry traversal limit; narrow the search path.");
          if ([".git", "node_modules", ".venv"].includes(entry.name)) continue;
          const full = resolvePath(path.relative(root, path.join(dir, entry.name)));
          if (matchesFilenamePattern(path.relative(searchRoot, full), pattern)) matches.push(path.relative(root, full));
          if (entry.isDirectory()) await walk(full);
          if (matches.length >= max) break;
        }
      }
      await walk(searchRoot); return matches;
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
      const matches: string[] = [];
      const requestedMax = Number(a.maxResults ?? 100);
      const max = Number.isFinite(requestedMax) ? Math.min(Math.max(Math.trunc(requestedMax), 1), 500) : 100;
      const needle = String(a.query).toLowerCase();
      if (!needle || needle.length > 4096) throw new Error("Search query must contain 1-4096 characters.");
      let scannedFiles = 0, scannedBytes = 0, visitedEntries = 0;
      async function walk(dir: string): Promise<void> {
        if (matches.length >= max) return;
        const directory = await fs.opendir(dir);
        for await (const entry of directory) {
          if (++visitedEntries > 5000) throw new Error("Filesystem search exceeds the 5000-entry traversal limit; narrow the search path.");
          if ([".git", "node_modules", ".venv"].includes(entry.name)) continue;
          const full = resolvePath(path.relative(root, path.join(dir, entry.name)));
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            if (++scannedFiles > 1000) throw new Error("Filesystem search exceeds the 1000-file scan limit; narrow the search path.");
            const stat = await fs.stat(full);
            if (stat.size > 1024 * 1024) continue;
            scannedBytes += stat.size;
            if (scannedBytes > 16 * 1024 * 1024) throw new Error("Filesystem search exceeds the 16 MiB aggregate read limit; narrow the search path.");
            try { if ((await readFileBounded(full, 1024 * 1024)).toLowerCase().includes(needle)) matches.push(path.relative(root, full)); } catch (error) { if (!(error instanceof Error && /read limit/.test(error.message))) throw error; }
          }
          if (matches.length >= max) break;
        }
      }
      await walk(resolvePath(a.path ?? ".")); return matches;
    }
    case "terminal.exec": return run("bash", ["-lc", String(a.command)], a.cwd ? resolvePath(a.cwd) : root, a.timeoutMs, childEnv);
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
      if (!session.pty || typeof session.child.resize !== "function") return { resized: false, available: false, reason: "This is a non-terminal process session; resizing is available only for terminal sessions started with a pseudo-terminal." };
      const cols = Number(a.cols), rows = Number(a.rows);
      if (!Number.isInteger(cols) || cols < 20 || cols > 500 || !Number.isInteger(rows) || rows < 5 || rows > 200) throw new Error("Terminal size must be 20-500 columns and 5-200 rows.");
      session.child.resize(cols, rows);
      return { resized: true, cols, rows };
    }
    case "process.list": return run("ps", ["-eo", "pid,ppid,stat,etime,comm"]);
    case "process.start": return startSession(String(a.command), a.cwd ? resolvePath(a.cwd) : root);
    case "process.inspect": {
      const pid = Number(a.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A valid process PID is required.");
      return run("ps", ["-p", String(pid), "-o", "pid,ppid,stat,etime,comm"]);
    }
    case "process.logs": return readSession(String(a.sessionId), Boolean(a.clear));
    case "process.kill": {
      const pid = Number(a.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Refusing to signal a protected or invalid PID.");
      const session = requireTrackedSession(sessions, pid);
      if (session.ended) return { signalled: false, alreadyEnded: true, pid };
      signalSession(session, "SIGTERM");
      return { signalled: true, pid, signal: "SIGTERM" };
    }
    case "process.signal": {
      const pid = Number(a.pid), signal = String(a.signal ?? "SIGTERM");
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Refusing to signal a protected or invalid PID.");
      if (!["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "SIGUSR1", "SIGUSR2"].includes(signal)) throw new Error("Unsupported process signal.");
      const session = requireTrackedSession(sessions, pid);
      if (session.ended) return { signalled: false, alreadyEnded: true, pid };
      signalSession(session, signal as NodeJS.Signals);
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
      const paths = (a.paths ?? ["."]).map((p: string) => {
        const absolute = path.resolve(cwd, p);
        const safe = resolvePath(path.relative(root, absolute));
        return path.relative(cwd, safe) || ".";
      });
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
      if ((action === "drop" || action === "pop") && a.confirm !== true) throw new Error(`Git stash ${action} requires confirm=true.`);
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
      pruneEndedSessions(debugSessions, Date.now(), 10 * 60_000, 50);
      if ([...debugSessions.values()].filter(session => !session.ended).length >= 20) throw new Error("Debug-adapter session limit reached (20 active sessions).");
      const command = Array.isArray(a.command) ? a.command.map(String) : [];
      if (!command.length || command.length > 64 || command.some(part => part.length > 4096)) throw new Error("Debug adapter command must be a non-empty argv array.");
      const child = spawn(command[0], command.slice(1), { cwd: a.cwd ? resolvePath(a.cwd) : root, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      const id = randomUUID();
      const session: DebugSession = { child, buffer: Buffer.alloc(0), messages: [], queuedBytes:0, stderr: "", ended: false, endedAt: null, exitCode: null };
      child.stdout.on("data", (chunk: Buffer) => { try { assertProtocolBufferCapacity(session.buffer.length,chunk.length,MAX_DEBUG_BUFFER_BYTES);session.buffer = Buffer.concat([session.buffer, chunk]); parseDebugMessages(session); } catch (error) { session.stderr = (session.stderr + (error instanceof Error ? error.message : String(error))).slice(-50_000);
        child.stdout.pause();session.buffer=Buffer.alloc(0);session.messages=[];session.queuedBytes=0;
        signalChildTree(child, "SIGTERM");
        const forceTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)signalChildTree(child,"SIGKILL");},1000);forceTimer.unref(); } });
      child.stderr.on("data", (chunk: Buffer) => { session.stderr = (session.stderr + chunk.toString("utf8")).slice(-50_000); });
      child.on("close", (code: number | null) => { session.ended = true; session.endedAt = Date.now(); session.exitCode = code; });
      child.on("error", (error: Error) => { session.stderr = (session.stderr + error.message).slice(-50_000); session.ended = true; session.endedAt = Date.now(); });
      debugSessions.set(id, session);
      pruneEndedSessions(debugSessions, Date.now(), 10 * 60_000, 50);
      return { sessionId: id, pid: child.pid ?? null, protocol: "Debug Adapter Protocol" };
    }
    case "debug.send": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session || session.ended) throw new Error("Debug adapter session is not running.");
      const message = a.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("message must be a DAP JSON object.");
      const body = Buffer.from(JSON.stringify(message), "utf8");
      if (body.length > 8 * 1024 * 1024) throw new Error("DAP message exceeds 8 MiB.");
      const frame=Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
      const writable=session.child.stdin;
      if(writable.writableLength+frame.length>MAX_DEBUG_QUEUE_BYTES)throw new Error("Debug-adapter input backpressure limit exceeded.");
      if(!writable.write(frame))await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error("Debug-adapter input drain timed out."));},10000);const cleanup=()=>{clearTimeout(timer);writable.off("drain",onDrain);writable.off("error",onError);writable.off("close",onClose);};const onDrain=()=>{cleanup();resolve();};const onError=(error:Error)=>{cleanup();reject(error);};const onClose=()=>{cleanup();reject(new Error("Debug-adapter input closed before draining."));};writable.once("drain",onDrain);writable.once("error",onError);writable.once("close",onClose);});
      return { sent: true, bytes: body.length };
    }
    case "debug.read": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown debug adapter session.");
      const limit = Math.min(Math.max(Number(a.maxMessages ?? 100), 1), 500);
      const messages=session.messages.splice(0,limit);
      session.queuedBytes-=messages.reduce((total,item)=>total+item.bytes,0);
      return { messages: messages.map(item=>{try{return JSON.parse(item.body);}catch{return {parseError:true,body:item.body};}}), stderr: session.stderr, running: !session.ended, exitCode: session.exitCode };
    }
    case "debug.close": {
      const session = debugSessions.get(String(a.sessionId));
      if (!session) throw new Error("Unknown debug adapter session.");
      if (!session.ended) signalChildTree(session.child, "SIGTERM");
      return { closed: true, alreadyEnded: session.ended };
    }
    case "environment.info": {
      const names = Object.keys(process.env).filter(k => /TOKEN|SECRET|PASSWORD|KEY|COOKIE|AUTH/i.test(k));
      return { codespace, workspace: root, platform: os.platform(), arch: os.arch(), node: process.version, envVariableNames: Object.keys(process.env), redactedSecretVariableNames: names };
    }
    case "environment.tools": {
      const checks = await Promise.all(["node", "npm", "pnpm", "yarn", "git", "python3", "pip3", "docker", "gh", "code", "devcontainer"].map(async name => {
        try { const executable = await resolveExecutable(name); const r = await execFileAsync(executable, ["--version"], { cwd: root, timeout: 5000, maxBuffer: 8192, env: systemEnv }); return { name, available: true, version: (r.stdout || r.stderr).trim().split("\n")[0] }; }
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
              const pkg = JSON.parse(await readFileBounded(manifest, 1024 * 1024));
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
        try { return { path: relative, text: await readFileBounded(file, 512 * 1024) }; }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      }
      return { found: false, candidates };
    }
    case "devcontainer.read_configuration":
    case "devcontainer.validate": {
      const candidates = [a.config ? String(a.config) : ".devcontainer/devcontainer.json", ".devcontainer.json"];
      let selected: string | null = null, raw = "";
      for (const candidate of candidates) {
        try { selected = candidate; raw = await readFileBounded(resolvePath(candidate), 512 * 1024); break; }
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
        const result = await run("gh", args, root, 120_000, createGitHubCliEnv(process.env, root));
        return { requested: true, operation: "codespace-rebuild", ...result, note: "The Codespace may disconnect while GitHub rebuilds its container. The agent should reconnect through the configured postStartCommand." };
      } catch (error: any) {
        return { requested: false, available: false, reason: error?.message ?? String(error), fallback: "Run 'Codespaces: Rebuild Container' from the GitHub Codespaces Command Palette." };
      }
    }
    case "devcontainer.exec": {
      const command = Array.isArray(a.command) ? a.command.map(String) : [];
      if (!command.length || command.length > 64 || command.some(part => part.length > 4096)) throw new Error("command must be a non-empty argv array (maximum 64 entries).");
      return run(command[0], command.slice(1), root, 120_000, childEnv);
    }
    case "workspace.disk_usage": {
      const filesystem = await run("df", ["-h", root], root);
      const workspace = await run("du", ["-sh", "--exclude=node_modules", "--exclude=.git", root], root, 120_000);
      return { filesystem, workspace };
    }
    case "ports.inspect":
    case "ports.list": {
      let forwardedPortsError: string | undefined;
      if (operation === "ports.list") {
        try {
          const forwarded = await run("gh", ["codespace", "ports", "--codespace", codespace, "--json", "sourcePort,visibility,browseUrl,label"], root, 15000, createGitHubCliEnv(process.env, root));
          return { source: "gh-codespace-ports", forwardedPorts: JSON.parse(forwarded.stdout || "[]") };
        } catch (error: any) {
          forwardedPortsError = error?.message ?? String(error);
        }
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
        return {
          source: "/proc/net/tcp", listeners, count: listeners.length, forwardedPortsAvailable: false,
          ...(forwardedPortsError ? { forwardedPortsError } : {}),
          note: forwardedPortsError
            ? (/executable not found on path:\\s*gh|spawn gh ENOENT|gh: command not found/i.test(forwardedPortsError)
              ? "Local listeners are shown; GitHub CLI (gh) is not installed in the Codespace."
              : /401|403|authentication|permission/i.test(forwardedPortsError)
                ? "Local listeners are shown; GitHub CLI authentication or Codespaces permissions prevented forwarded-port metadata access."
                : "Local listeners are shown; GitHub forwarded-port metadata could not be retrieved. See forwardedPortsError for the actual failure.")
            : "Local listening sockets are shown. GitHub forwarded-port metadata is unavailable from this agent."
        };
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
      requirePublicPortConfirmation(visibility,a.confirm===true);
      try {
        const result = await run("gh", ["codespace", "ports", "visibility", `${port}:${visibility}`, "--codespace", codespace], root, 30000, createGitHubCliEnv(process.env, root));
        return { updated: true, available: true, codespace, port, visibility, ...result };
      } catch (error: any) {
        const detail = error?.message ?? String(error);
        const missingCli = error?.code === "ENOENT" || /executable not found on path:\\s*gh|spawn gh ENOENT|gh: command not found/i.test(detail);
        return {
          updated: false, available: false, codespace, port, visibility,
          reason: missingCli ? "GitHub CLI (gh) is not installed in this Codespace." : detail,
          ...(missingCli ? { installHint: "Install the GitHub CLI or add the official github-cli Dev Container feature, then restart the agent." } : {}),
          ...( /404|not found/i.test(detail) ? { hint: "Check that the Codespace and forwarded port exist and that the authenticated GitHub account can access them." } : {})
        };
      }
    }
    case "ports.check": {
      const port = Number(a.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535.");
      const host = String(a.host ?? "127.0.0.1").trim().replace(/^\[|\]$/g, "");
      if (!isLoopbackHost(host)) throw new Error("Port checks are restricted to localhost and loopback IP addresses.");
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
      if (destination === root) throw new Error("Archive extraction cannot target the workspace root.");

      // Validate and extract the same private snapshot to prevent list/extract TOCTOU.
      const snapshot = await createBoundedFileSnapshot(archive, 512 * 1024 * 1024);
      try {
        const listing = await run("tar", ["-tvzf", snapshot.path]);
        const limits = inspectArchiveListing(listing.stdout);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        let destinationExists = false;
        try {
          const stat = await fs.lstat(destination);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Extraction destination must be a real directory, not a link or file.");
          if ((await fs.readdir(destination)).length) throw new Error("Extraction destination must be empty to prevent overwriting existing files.");
          destinationExists = true;
        } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        const staging = path.join(path.dirname(destination), `.codespace-extract-${randomUUID()}`);
        await fs.mkdir(staging, { recursive: false });
        try {
          await run("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", snapshot.path, "-C", staging]);
          if (destinationExists) await fs.rmdir(destination);
          await fs.rename(staging, destination);
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return { extracted: true, entries: limits.entries, uncompressedBytes: limits.uncompressedBytes, destination: path.relative(root, destination) };
      } finally { await snapshot.cleanup(); }
    }
    case "transfer.read": return { contentBase64: (await readFileBufferBounded(resolvePath(a.path), 512 * 1024)).toString("base64") };
    case "transfer.write": await fs.writeFile(resolvePath(a.path), Buffer.from(String(a.contentBase64), "base64")); return { written: true };
    default: throw new Error(`Unsupported agent operation: ${operation}`);
  }
}

type DebugSession = { child: ReturnType<typeof spawn>; buffer: Buffer; messages: Array<{body:string;bytes:number}>; queuedBytes:number; stderr: string; ended: boolean; endedAt: number | null; exitCode: number | null };
const debugSessions = new Map<string, DebugSession>();
const MAX_DEBUG_MESSAGE_BYTES=8*1024*1024;
const MAX_DEBUG_HEADER_BYTES=8192;
const MAX_DEBUG_BUFFER_BYTES=MAX_DEBUG_MESSAGE_BYTES+MAX_DEBUG_HEADER_BYTES;
const MAX_DEBUG_QUEUE_BYTES=8*1024*1024;
function parseDebugMessages(session: DebugSession): void {
  while (true) {
    const boundary = session.buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = session.buffer.subarray(0, boundary).toString("ascii");
    const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
    if (boundary > MAX_DEBUG_HEADER_BYTES) throw new Error("DAP header exceeds 8 KiB.");
    if (!match) throw new Error("Invalid Debug Adapter Protocol header.");
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DEBUG_MESSAGE_BYTES) throw new Error("Invalid Debug Adapter Protocol message length.");
    const start = boundary + 4;
    if (session.buffer.length < start + length) return;
    assertProtocolQueueCapacity(session.queuedBytes,length,MAX_DEBUG_QUEUE_BYTES,session.messages.length,4096);
    const body = session.buffer.subarray(start, start + length).toString("utf8");
    const charge=Math.max(length,256);
    session.buffer = session.buffer.subarray(start + length);
    session.messages.push({body,bytes:charge});session.queuedBytes+=charge;
  }
}
const MAX_RELAY_RESPONSE_BYTES = 1024 * 1024;
async function readJsonLimited(response: Response): Promise<any> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RELAY_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Relay response exceeds the 1 MiB limit.");
  }
  if (!response.body) throw new Error("Relay response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RELAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Relay response exceeds the 1 MiB limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
  return JSON.parse(body);
}
async function request(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
export async function runCodespaceAgent(): Promise<void> {
  if (!baseUrl || !token || token.length < 32 || !codespace) throw new Error("Set CODESPACE_AGENT_URL, CODESPACE_AGENT_TOKEN (32+ chars), and CODESPACE_NAME.");
  validateRelayUrl(baseUrl);
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
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Heartbeat failed: ${response.status}`);
      }
      await response.body?.cancel().catch(() => undefined);
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
      const poll = await request(`${baseUrl}/codespaces/agent/poll?name=${encodeURIComponent(codespace)}`, { signal: AbortSignal.timeout(30_000) });
      if (!poll.ok) {
        await poll.body?.cancel().catch(() => undefined);
        throw new Error(`Poll failed: ${poll.status}`);
      }
      backoff = 1000;
      const { job } = await readJsonLimited(poll) as { job: null | { id: string; operation: string; args: Record<string, any> } };
      if (!job) {
        await delay(250);
        continue;
      }
      let value: unknown, ok = true;
      try { value = await execute(job.operation, job.args); }
      catch (error) { ok = false; value = error instanceof Error ? error.message : String(error); }
      let resultBody = JSON.stringify({ id: job.id, codespace, ok, value });
      if (Buffer.byteLength(resultBody, "utf8") > 900 * 1024) {
        ok = false; value = "Job result exceeded the 900 KiB response limit. Use chunked transfer.download.chunk for large files.";
        resultBody = JSON.stringify({ id: job.id, codespace, ok, value });
      }
      let delivered = false;
      for (let attempt=0; attempt<5 && !stopping; attempt++) {
        try {
          const response = await request(`${baseUrl}/codespaces/agent/result`, { method:"POST", body:resultBody });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Result delivery failed: ${response.status}`);
          }
          const receipt = await readJsonLimited(response) as { accepted?: boolean };
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
