import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoSymlinkComponents, assertProtocolBufferCapacity, assertProtocolQueueCapacity, assertUploadCapacity, createChildProcessEnv, readFileBounded, inspectArchiveListing, isExpired, isLoopbackHost, linkFileNoReplace, matchesFilenamePattern, pruneEndedSessions, requirePublicPortConfirmation, requireTrackedSession, validateRelayUrl, writeFilesAtomically } from "./agent-utils.js";

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


test("relay URLs require HTTPS except for loopback development", () => {
  assert.doesNotThrow(() => validateRelayUrl("https://relay.example.test"));
  assert.doesNotThrow(() => validateRelayUrl("http://localhost:3000"));
  assert.doesNotThrow(() => validateRelayUrl("http://127.0.0.1:3000"));
  assert.throws(() => validateRelayUrl("http://relay.example.test"), /must use HTTPS/i);
  assert.throws(() => validateRelayUrl("https://user:pass@relay.example.test"), /embedded credentials/i);
  assert.throws(() => validateRelayUrl("not a URL"), /valid HTTPS URL/i);
});

test("workspace path validation rejects symlinks, including links that stay inside the workspace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-path-"));
  try {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link, "dir");
    assert.doesNotThrow(() => assertNoSymlinkComponents(dir, path.join(dir, "real", "file.txt")));
    assert.throws(() => assertNoSymlinkComponents(dir, path.join(link, "file.txt")), /symbolic links/i);
    assert.throws(() => assertNoSymlinkComponents(dir, path.join(dir, "..", "outside")), /escapes/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("archive validation enforces entry types, paths, file sizes, and aggregate expansion", () => {
  const valid = "-rw-r--r-- node/node 5 2026-11-25 01:38 file.txt\ndrwxr-xr-xr-x node/node 0 2026-11-25 01:38 folder/";
  assert.deepEqual(inspectArchiveListing(valid), { entries: 2, uncompressedBytes: 5 });
  assert.throws(() => inspectArchiveListing("lrwxrwxrwx node/node 0 2026-11-25 01:38 link -> /tmp"), /links and special/i);
  assert.throws(() => inspectArchiveListing("-rw-r--r-- node/node 5 2026-11-25 01:38 ../escape"), /absolute or traversal/i);
  assert.throws(() => inspectArchiveListing("-rw-r--r-- node/node 11 2026-11-25 01:38 big.bin", 10, 10, 100), /per-file limit/i);
  assert.throws(() => inspectArchiveListing(valid, 10, 10, 4), /total uncompressed-size limit/i);
});

test("upload reservations enforce per-file, session-count, and aggregate caps", () => {
  const sessions = new Map<string, { expectedSize: number }>();
  assert.doesNotThrow(() => assertUploadCapacity(sessions, 256, 2, 300, 512));
  sessions.set("one", { expectedSize: 300 });
  assert.doesNotThrow(() => assertUploadCapacity(sessions, 200, 2, 300, 512));
  assert.throws(() => assertUploadCapacity(sessions, 256, 2, 300, 512), /aggregate active upload/i);
  assert.throws(() => assertUploadCapacity(sessions, 301, 2, 300, 512), /expectedSize/i);
  sessions.set("two", { expectedSize: 1 });
  assert.throws(() => assertUploadCapacity(sessions, 1, 2, 300, 512), /session limit/i);
});


test("process signalling can resolve only a live PID owned by a tracked agent session", () => {
  const owned = { child: { pid: 4242 }, ended: false };
  const sessions = new Map([["owned", owned]]);
  assert.equal(requireTrackedSession(sessions, 4242), owned);
  assert.throws(() => requireTrackedSession(sessions, 4343), /tracked by this agent/i);
});


test("protocol receive buffers and queued messages enforce byte budgets", () => {
  assert.doesNotThrow(() => assertProtocolBufferCapacity(10, 5, 15));
  assert.throws(() => assertProtocolBufferCapacity(10, 6, 15), /buffer limit/i);
  assert.doesNotThrow(() => assertProtocolQueueCapacity(0, 5, 256));
  assert.throws(() => assertProtocolQueueCapacity(8000, 500, 8192), /queued-message limit/i);
  assert.throws(() => assertProtocolQueueCapacity(0, 0, 8192, 4096, 4096), /queued-message limit/i);
  assert.doesNotThrow(() => assertProtocolQueueCapacity(0, 0, 8192, 4095, 4096));
});

test("port-check host policy accepts only localhost and valid loopback addresses", () => {
  for (const host of ["localhost", "127.0.0.1", "127.22.1.9", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["example.com", "192.168.1.1", "10.0.0.1", "127.999.0.1", "0.0.0.0", "::"]) assert.equal(isLoopbackHost(host), false, host);
});

test("resumable upload commit helper never replaces an existing destination", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-no-replace-"));
  try {
    const temp = path.join(dir, "upload.tmp"), target = path.join(dir, "target.txt");
    await fs.writeFile(temp, "new"); await fs.writeFile(target, "original");
    await assert.rejects(linkFileNoReplace(temp, target), { code: "EEXIST" });
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await fs.readFile(temp, "utf8"), "new");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test("public forwarded-port exposure requires explicit confirmation", () => {
  assert.doesNotThrow(() => requirePublicPortConfirmation("private", false));
  assert.doesNotThrow(() => requirePublicPortConfirmation("org", false));
  assert.doesNotThrow(() => requirePublicPortConfirmation("public", true));
  assert.throws(() => requirePublicPortConfirmation("public", false), /confirm=true/i);
});


test("child process environments never inherit the agent authentication token", () => {
  const source = { PATH: "/usr/bin", CODESPACE_AGENT_TOKEN: "synthetic-secret", OTHER_TOKEN: "keep-me" };
  const child = createChildProcessEnv(source);
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.OTHER_TOKEN, "keep-me");
  assert.equal(child.CODESPACE_AGENT_TOKEN, undefined);
  assert.equal(source.CODESPACE_AGENT_TOKEN, "synthetic-secret");
});

test("bounded file reads preserve small files and reject oversized files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-bounded-read-"));
  try {
    const small = path.join(dir, "small.txt"), large = path.join(dir, "large.txt");
    await fs.writeFile(small, "hello");
    await fs.writeFile(large, "0123456789");
    assert.equal(await readFileBounded(small, 5), "hello");
    await assert.rejects(readFileBounded(large, 5), /read limit.*chunked/i);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
