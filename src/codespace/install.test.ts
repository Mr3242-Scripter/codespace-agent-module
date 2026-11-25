import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), "install.mjs");

test("portable installer installs into a clean target without following links", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-installer-"));
  const target = path.join(parent, "target");
  try {
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "fixture" }));
    const result = spawnSync(process.execPath, [installer, "--target", target, "--no-install"], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.readFile(path.join(target, ".codespace-agent", "agent.ts"), "utf8").then(Boolean), true);
    const pkg = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"));
    assert.equal(typeof pkg.scripts["codespace-agent:check"], "string");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("portable installer rejects a symlinked module destination", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-installer-link-"));
  const target = path.join(parent, "target");
  const outside = path.join(parent, "outside");
  try {
    await fs.mkdir(target);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "fixture" }));
    try { await fs.symlink(outside, path.join(target, ".codespace-agent"), "dir"); }
    catch { t.skip("Symlink creation is unavailable in this environment."); return; }
    const result = spawnSync(process.execPath, [installer, "--target", target, "--no-install"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /symbolic link/i);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
