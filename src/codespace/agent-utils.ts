import fs from "node:fs/promises";
import { constants, lstatSync, realpathSync } from "node:fs";
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

export function isLoopbackHost(value: string): boolean {
  const host=value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if(host==="localhost"||host==="::1")return true;
  const octets=host.split(".");
  return octets.length===4 && octets.every(part=>/^\d{1,3}$/.test(part)&&Number(part)>=0&&Number(part)<=255) && Number(octets[0])===127;
}

export function assertProtocolBufferCapacity(currentBytes: number, incomingBytes: number, maxBytes: number): void {
  if(!Number.isSafeInteger(currentBytes)||!Number.isSafeInteger(incomingBytes)||currentBytes<0||incomingBytes<0||currentBytes+incomingBytes>maxBytes)throw new Error("Protocol receive buffer limit exceeded.");
}

export function assertProtocolQueueCapacity(queuedBytes: number, messageBytes: number, maxBytes: number, queuedMessages = 0, maxMessages = 4096): void {
  if (!Number.isSafeInteger(messageBytes) || messageBytes < 0) throw new Error("Invalid protocol message size.");
  const charge = Math.max(messageBytes, 256);
  if (!Number.isSafeInteger(queuedBytes) || !Number.isSafeInteger(queuedMessages) || queuedBytes < 0 || queuedMessages < 0 || queuedMessages + 1 > maxMessages || queuedBytes + charge > maxBytes) throw new Error("Protocol queued-message limit exceeded.");
}

export function createChildProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.CODESPACE_AGENT_TOKEN;
  return env;
}

export async function readFileBufferBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Target must be a regular file.");
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
