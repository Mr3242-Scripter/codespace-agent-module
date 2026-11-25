import fs from "node:fs/promises";
import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function validateRelayUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("CODESPACE_AGENT_URL must be a valid HTTPS URL."); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CODESPACE_AGENT_URL must use HTTPS; plain HTTP is permitted only for localhost development.");
  }
  if (url.username || url.password) throw new Error("CODESPACE_AGENT_URL must not contain embedded credentials.");
}

export function assertNoSymlinkComponents(rootPath: string, targetPath: string): void {
  const root = realpathSync(rootPath);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path escapes the workspace root.");
  let probe = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    probe = path.join(probe, part);
    try {
      if (lstatSync(probe).isSymbolicLink()) throw new Error("Symbolic links are not permitted in workspace paths.");
    } catch (error: any) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") break;
      throw error;
    }
  }
}

export function inspectArchiveListing(listing: string, maxEntries = 10_000, maxFileBytes = 128 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024): { entries: number; uncompressedBytes: number } {
  const lines = listing.split(/\r?\n/).filter(Boolean);
  if (lines.length > maxEntries) throw new Error(`Archive exceeds the ${maxEntries.toLocaleString()}-entry extraction limit.`);
  let uncompressedBytes = 0;
  for (const line of lines) {
    const match = line.match(/^([bcdhlps-])\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!match) throw new Error("Archive listing contains an unsupported or unparseable entry.");
    const [, kind, rawSize, name] = match;
    if (kind !== "-" && kind !== "d") throw new Error("Archive links and special files are not permitted.");
    const normalized = name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(part => part === "..")) {
      throw new Error("Archive contains an absolute or traversal path.");
    }
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) throw new Error(`Archive contains a file larger than the ${Math.floor(maxFileBytes / 1024 / 1024)} MiB per-file limit.`);
    uncompressedBytes += size;
    if (uncompressedBytes > maxTotalBytes) throw new Error(`Archive exceeds the ${Math.floor(maxTotalBytes / 1024 / 1024)} MiB total uncompressed-size limit.`);
  }
  return { entries: lines.length, uncompressedBytes };
}


export function requireTrackedSession<T extends { child: { pid?: number }; ended: boolean }>(sessions: Map<string, T>, pid: number): T {
  const session = [...sessions.values()].find(item => Number(item.child.pid) === pid);
  if (!session) throw new Error("Only processes started and tracked by this agent can be signalled.");
  return session;
}

export function assertUploadCapacity<T extends { expectedSize: number }>(sessions: Map<string, T>, expectedSize: number, maxSessions: number, maxSingleBytes: number, maxAggregateBytes: number): void {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxSingleBytes) throw new Error(`expectedSize must be between 0 and ${Math.floor(maxSingleBytes / 1024 / 1024)} MiB.`);
  if (sessions.size >= maxSessions) throw new Error(`Upload session limit reached (${maxSessions} active uploads); expired sessions are cleaned automatically.`);
  const reserved = [...sessions.values()].reduce((total, session) => total + session.expectedSize, 0);
  if (reserved + expectedSize > maxAggregateBytes) throw new Error(`Aggregate active upload reservation limit reached (${Math.floor(maxAggregateBytes / 1024 / 1024)} MiB). Commit or abort another upload before starting this one.`);
}

export function parseMakeTargets(makefile: string): string[] {
  const logicalLines = makefile.replace(/\\\r?\n[ \t]*/g, " ").split(/\r?\n/);
  const targets = new Set<string>();
  for (const line of logicalLines) {
    // Recipe lines and comments are data, never evaluated.
    if (/^[ \t]/.test(line) || /^\s*#/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0 || /^[=:]/.test(line.slice(colon + 1))) continue;
    const lhs = line.slice(0, colon).trim();
    if (!lhs || lhs.startsWith(".") || /[$%]/.test(lhs)) continue;
    for (const target of lhs.split(/\s+/)) {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(target) && !target.startsWith(".")) {
        targets.add(target);
      }
    }
  }
  return [...targets].slice(0, 300);
}

export function matchesFilenamePattern(value: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedValue = value.replace(/\\/g, "/");
  const wildcardCount = normalizedPattern.match(/\*\*\/|\*\*|\*|\?/g)?.length ?? 0;
  if (wildcardCount > 8) throw new Error("Filename pattern exceeds the 8-wildcard complexity limit.");
  if (!/[?*]/.test(normalizedPattern)) {
    const needle = normalizedPattern.toLowerCase();
    return normalizedValue.toLowerCase().includes(needle);
  }
  const candidate = normalizedPattern.includes("/")
    ? normalizedValue
    : path.posix.basename(normalizedValue);
  let source = "^";
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i];
    if (char === "*" && normalizedPattern[i + 1] === "*") {
      if (normalizedPattern[i + 2] === "/") { source += "(?:.*/)?"; i += 2; }
      else { source += ".*"; i++; }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source, "i").test(candidate);
}

export function pruneEndedSessions<T extends { ended: boolean; endedAt?: number | null }>(
  sessions: Map<string, T>,
  now = Date.now(),
  retentionMs = 10 * 60_000,
  maxEntries = 100
): number {
  let removed = 0;
  const completed = [...sessions.entries()]
    .filter(([, session]) => session.ended)
    .sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
  for (const [id, session] of completed) {
    if (session.endedAt != null && now - session.endedAt >= retentionMs) {
      sessions.delete(id);
      removed++;
    }
  }
  for (const [id] of completed) {
    if (sessions.size <= maxEntries) break;
    if (sessions.delete(id)) removed++;
  }
  return removed;
}

export function isExpired(lastActivityAt: number, now = Date.now(), ttlMs = 15 * 60_000): boolean {
  return now - lastActivityAt >= ttlMs;
}

export function requirePublicPortConfirmation(visibility: string, confirmed: boolean): void {
  if(visibility==="public"&&!confirmed)throw new Error("Making a forwarded port public requires confirm=true.");
}

export function getGitHubHttpsRemoteHost(remoteUrl: string, githubServerUrl = "https://github.com"): string | null {
  try {
    const remote = new URL(remoteUrl);
    const server = new URL(githubServerUrl);
    if (remote.protocol !== "https:" || server.protocol !== "https:" ||
        remote.username || remote.password || remote.hostname !== server.hostname ||
        remote.port !== server.port || remote.search || remote.hash || remote.pathname === "/") return null;
    return remote.host;
  } catch {
    return null;
  }
}

export function validateGitTagArgument(value: unknown): string {
  const name = String(value ?? "");
  if (!name || name.length > 255 || name.startsWith("-") || /[\0\r\n]/.test(name)) throw new Error("Invalid Git tag name.");
  return name;
}

export function validateGitBranchArgument(value: unknown): string {
  const branch = String(value ?? "");
  // A leading plus is a force-push refspec modifier; a leading dash is an option.
  if (!branch || branch.length > 255 || branch.startsWith("-") || branch.startsWith("+") || /[\0\r\n:]/.test(branch)) {
    throw new Error("Invalid Git branch name.");
  }
  return branch;
}

export function gitCommitSafetyConfig(): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"];
}

export function gitRemoteSafetyConfig(githubHost: string | null = null): string[] {
  const args = [
    "-c", "protocol.ext.allow=never",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
    "-c", "core.sshCommand=/usr/bin/ssh -F /dev/null"
  ];
  if (githubHost) {
    const helper = "credential.https://" + githubHost + ".helper";
    args.push("-c", helper + "=", "-c", helper + "=!gh auth git-credential");
  }
  return args;
}

export function isLoopbackHost(value: string): boolean {
  const host=value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if(host==="localhost"||host==="::1")return true;
  const octets=host.split(".");
  return octets.length===4 && octets.every(part=>/^\d{1,3}$/.test(part)&&Number(part)>=0&&Number(part)<=255) && Number(octets[0])===127;
}

export function assertProtocolHeaderCapacity(headerBytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(headerBytes) || headerBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || headerBytes > maxBytes) {
    throw new Error("Protocol header exceeds its configured byte limit.");
  }
}

export function assertProtocolBufferCapacity(currentBytes: number, incomingBytes: number, maxBytes: number): void {
  if(!Number.isSafeInteger(currentBytes)||!Number.isSafeInteger(incomingBytes)||currentBytes<0||incomingBytes<0||currentBytes+incomingBytes>maxBytes)throw new Error("Protocol receive buffer limit exceeded.");
}

export function assertProtocolQueueCapacity(queuedBytes: number, messageBytes: number, maxBytes: number, queuedMessages = 0, maxMessages = 4096): void {
  if (!Number.isSafeInteger(messageBytes) || messageBytes < 0) throw new Error("Invalid protocol message size.");
  const charge = Math.max(messageBytes, 256);
  if (!Number.isSafeInteger(queuedBytes) || !Number.isSafeInteger(queuedMessages) || queuedBytes < 0 || queuedMessages < 0 || queuedMessages + 1 > maxMessages || queuedBytes + charge > maxBytes) throw new Error("Protocol queued-message limit exceeded.");
}

const SENSITIVE_ENV_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|COOKIE|AUTH|CREDENTIAL|CERT|PRIVATE|SESSION|ASKPASS|ACCESS|AGENT|SOCKET)/i;
const CLOUD_CREDENTIAL_ENV_NAME = /^(?:AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|CLOUDSDK_|GCP_|VAULT_|TF_VAR_|KUBECONFIG$|DOCKER_CONFIG$)/i;
const EXECUTION_ENV_NAME = /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|BASH_FUNC_.*|CDPATH|IFS|GLOBIGNORE|ZDOTDIR|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|GIT_.*|DOCKER_HOST|DOCKER_CONTEXT|CONTAINER_HOST|COREPACK_.*|NPM_CONFIG_.*|npm_config_.*)$/i;

export function createChildProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (SENSITIVE_ENV_NAME.test(name) || CLOUD_CREDENTIAL_ENV_NAME.test(name) || EXECUTION_ENV_NAME.test(name)) delete env[name];
  }
  return env;
}

function isInsidePath(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

function isTrustedDirectorySync(directory: string, trustedOwnerUid: number): boolean {
  let current = path.resolve(directory);
  while (true) {
    let stat;
    try { stat = statSync(current); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== trustedOwnerUid || (stat.mode & 0o022) !== 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function isTrustedDirectory(directory: string, trustedOwnerUid: number): Promise<boolean> {
  let current = path.resolve(directory);
  while (true) {
    let stat;
    try { stat = await fs.stat(current); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== trustedOwnerUid || (stat.mode & 0o022) !== 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export function filterTrustedExecutablePath(
  searchPath: string,
  workspaceRoot: string,
  homeDirectory = os.homedir(),
  temporaryDirectory = os.tmpdir(),
  trustedOwnerUid = 0
): string {
  const excludedRoots = [path.resolve(workspaceRoot), path.resolve(homeDirectory), path.resolve(temporaryDirectory)];
  const safe: string[] = [];
  for (const entry of searchPath.split(path.delimiter).filter(Boolean)) {
    try {
      const directory = realpathSync(path.resolve(entry));
      if (excludedRoots.some(base => isInsidePath(directory, base))) continue;
      if (!isTrustedDirectorySync(directory, trustedOwnerUid)) continue;
      if (!safe.includes(directory)) safe.push(directory);
    } catch {}
  }
  return safe.join(path.delimiter);
}

export async function resolveTrustedExecutable(command: string, searchPath: string, workspaceRoot: string, homeDirectory = os.homedir(), trustedOwnerUid = 0, temporaryDirectory = os.tmpdir()): Promise<string> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(command)) throw new Error("Trusted executable must be a simple command name.");
  const excludedRoots = [path.resolve(workspaceRoot), path.resolve(homeDirectory), path.resolve(temporaryDirectory)];
  for (const entry of searchPath.split(path.delimiter).filter(Boolean)) {
    try {
      const directory = await fs.realpath(path.resolve(entry));
      if (excludedRoots.some(base => isInsidePath(directory, base))) continue;
      if (!await isTrustedDirectory(directory, trustedOwnerUid)) continue;
      const candidate = await fs.realpath(path.join(directory, command));
      if (excludedRoots.some(base => isInsidePath(candidate, base))) continue;
      if (!await isTrustedDirectory(path.dirname(candidate), trustedOwnerUid)) continue;
      const fileStat = await fs.stat(candidate);
      if (!fileStat.isFile() || fileStat.uid !== trustedOwnerUid || (fileStat.mode & 0o022) !== 0 || (fileStat.mode & 0o111) === 0) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Trusted executable not found in root-owned system directories: " + command);
}

export function createGitHubCliEnv(source: NodeJS.ProcessEnv = process.env, workspaceRoot?: string): NodeJS.ProcessEnv {
  const env = createChildProcessEnv(source);
  if (workspaceRoot && env.PATH) env.PATH = filterTrustedExecutablePath(env.PATH, workspaceRoot);
  const credential = source.GITHUB_TOKEN || source.GITHUB_CODESPACE_TOKEN || source.GH_TOKEN;
  if (credential) env.GH_TOKEN = credential;
  return env;
}

export async function writeFileNoFollow(filePath: string, data: string | Uint8Array, mode = 0o666): Promise<void> {
  let targetMode = mode;
  try {
    const existing = await fs.lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Write target must be a regular file, not a link or special file.");
    if (existing.nlink > 1) throw new Error("Hard-linked files cannot be overwritten through the workspace agent.");
    targetMode = existing.mode & 0o777;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(filePath), `.codespace-agent-${randomUUID()}.write`);
  const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, targetMode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    try {
      const current = await fs.lstat(filePath);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error("Write target changed to a link or special file during the write.");
      if (current.nlink > 1) throw new Error("Hard-linked files cannot be overwritten through the workspace agent.");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function assertNoHardLinksInTree(targetPath: string, maxEntries = 10_000): Promise<void> {
  let visited = 0;
  async function walk(target: string): Promise<void> {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (stat.nlink > 1) throw new Error(`Hard-linked files are not permitted in workspace content operations: ${target}`);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Special filesystem entries are not permitted in workspace content operations: ${target}`);
    const directory = await fs.opendir(target);
    for await (const entry of directory) {
      if (++visited > maxEntries) throw new Error(`Filesystem content operation exceeds the ${maxEntries}-entry hard-link validation limit.`);
      await walk(path.join(target, entry.name));
    }
  }
  await walk(path.resolve(targetPath));
}

export async function readFileBufferBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Target must be a regular file.");
    if (stat.nlink > 1) throw new Error("Hard-linked files cannot be read through the workspace agent.");
    if (stat.size > maxBytes) throw new Error("File exceeds the " + Math.floor(maxBytes / 1024) + " KiB read limit; use chunked transfer.download.chunk instead.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}


export async function createBoundedFileSnapshot(sourcePath: string, maxBytes: number): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let directory: string | undefined;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Snapshot source must be a regular file.");
    if (before.nlink > 1n) throw new Error("Hard-linked files cannot be snapshotted through the workspace agent.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > BigInt(maxBytes)) {
      throw new Error(`Snapshot source exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB input limit.`);
    }
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-agent-snapshot-"));
    const snapshotPath = path.join(directory, "snapshot.bin");
    const target = await fs.open(snapshotPath, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const expectedSize = Number(before.size);
      let offset = 0;
      while (offset < expectedSize) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedSize - offset), offset);
        if (bytesRead === 0) throw new Error("Snapshot source changed or was truncated while being copied.");
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(buffer, written, bytesRead - written, offset + written);
          if (result.bytesWritten === 0) throw new Error("Could not complete the file snapshot.");
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      await target.sync();
    } finally { await target.close(); }
    const after = await source.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Snapshot source changed while it was being copied; retry with a stable file.");
    }
    const snapshotDirectory = directory;
    return {
      path: snapshotPath,
      cleanup: async () => { await fs.rm(snapshotDirectory, { recursive: true, force: true }); }
    };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally { await source.close(); }
}

export async function readFileBounded(filePath: string, maxBytes: number): Promise<string> {
  return (await readFileBufferBounded(filePath, maxBytes)).toString("utf8");
}
export async function linkFileNoReplace(tempPath: string, targetPath: string): Promise<void> {
  await fs.link(tempPath,targetPath);
  await fs.unlink(tempPath);
}

export async function writeFilesAtomically(files: Array<{ path: string; data: Buffer }>): Promise<number> {
  const seen = new Set<string>();
  const staged: Array<{ target: string; temp: string; backup: string; backupMoved: boolean; installed: boolean }> = [];
  for (const file of files) {
    const target = path.resolve(file.path);
    if (seen.has(target)) throw new Error(`Duplicate upload destination: ${target}`);
    seen.add(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Upload destination cannot be a symbolic link: ${target}`);
      if (stat.isDirectory()) throw new Error(`Upload destination is a directory: ${target}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    for (const file of files) {
      const target = path.resolve(file.path);
      const suffix = randomUUID();
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.stage`);
      const backup = path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.backup`);
      staged.push({ target, temp, backup, backupMoved: false, installed: false });
      await fs.writeFile(temp, file.data, { flag: "wx" });
    }
    for (const item of staged) {
      try {
        await fs.rename(item.target, item.backup);
        item.backupMoved = true;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.rename(item.temp, item.target);
      item.installed = true;
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of [...staged].reverse()) {
      try {
        if (item.installed) await fs.rm(item.target, { force: true, recursive: true });
        if (item.backupMoved) await fs.rename(item.backup, item.target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    for (const item of staged) await fs.rm(item.temp, { force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Atomic batch upload failed: ${detail}${rollbackErrors.length ? `; rollback issues: ${rollbackErrors.join("; ")}` : ""}`);
  }
  for (const item of staged) {
    if (item.backupMoved) await fs.rm(item.backup, { force: true }).catch(() => undefined);
    await fs.rm(item.temp, { force: true }).catch(() => undefined);
  }
  return files.length;
}
