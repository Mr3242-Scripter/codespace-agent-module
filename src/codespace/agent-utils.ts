import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
