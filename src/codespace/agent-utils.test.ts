import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isExpired, matchesFilenamePattern, pruneEndedSessions, writeFilesAtomically } from "./agent-utils.js";

test("filename matching supports glob wildcards and legacy substring searches", () => {
  assert.equal(matchesFilenamePattern("nested/report.txt", "*.txt"), true);
  assert.equal(matchesFilenamePattern("nested/report.txt", "nested/*.txt"), true);
  assert.equal(matchesFilenamePattern("nested/report.txt", "**/*.txt"), true);
  assert.equal(matchesFilenamePattern("report.txt", "**/*.txt"), true);
  assert.equal(matchesFilenamePattern("nested/report.txt", "report.tx?"), true);
  assert.equal(matchesFilenamePattern("nested/report.txt", "port"), true);
  assert.equal(matchesFilenamePattern("nested/report.txt", "*.lua"), false);
});

test("completed sessions expire and old completed entries are evicted to enforce the cap", () => {
  const sessions = new Map([
    ["old", { ended: true, endedAt: 1 }],
    ["active", { ended: false, endedAt: null }],
    ["recent", { ended: true, endedAt: 95 }]
  ]);
  assert.equal(pruneEndedSessions(sessions, 100, 10, 2), 1);
  assert.deepEqual([...sessions.keys()], ["active", "recent"]);
  sessions.set("older", { ended: true, endedAt: 20 });
  assert.equal(pruneEndedSessions(sessions, 100, 1000, 2), 1);
  assert.deepEqual([...sessions.keys()], ["active", "recent"]);
});

test("upload expiry uses last activity rather than only creation time", () => {
  assert.equal(isExpired(100, 200, 100), true);
  assert.equal(isExpired(101, 200, 100), false);
});

test("batch writes replace and create files as one staged operation", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-sync-"));
  try {
    const existing = path.join(dir, "existing.txt");
    const created = path.join(dir, "nested", "created.txt");
    await fs.writeFile(existing, "before");
    assert.equal(await writeFilesAtomically([
      { path: existing, data: Buffer.from("after") },
      { path: created, data: Buffer.from("new") }
    ]), 2);
    assert.equal(await fs.readFile(existing, "utf8"), "after");
    assert.equal(await fs.readFile(created, "utf8"), "new");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("batch upload preflight prevents partial writes when a destination is invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-sync-preflight-"));
  try {
    const existing = path.join(dir, "existing.txt");
    const directory = path.join(dir, "is-a-directory");
    await fs.writeFile(existing, "unchanged");
    await fs.mkdir(directory);
    await assert.rejects(writeFilesAtomically([
      { path: existing, data: Buffer.from("should-not-write") },
      { path: directory, data: Buffer.from("invalid") }
    ]), /destination is a directory/i);
    assert.equal(await fs.readFile(existing, "utf8"), "unchanged");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("batch upload rejects duplicate destinations before writing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-sync-duplicates-"));
  try {
    const target = path.join(dir, "same.txt");
    await assert.rejects(writeFilesAtomically([
      { path: target, data: Buffer.from("one") },
      { path: target, data: Buffer.from("two") }
    ]), /duplicate upload destination/i);
    await assert.rejects(fs.access(target));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
