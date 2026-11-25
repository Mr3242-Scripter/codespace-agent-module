import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInstallerEnv } from "./install-utils.mjs";

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
    const devcontainer = JSON.parse(await fs.readFile(path.join(target, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.match(devcontainer.postCreateCommand, /env -i HOME=/);
    assert.match(devcontainer.postCreateCommand, /npm install --userconfig=\/dev\/null && .*npm run codespace-agent:check --userconfig=\/dev\/null/);
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

test("installer environment rejects user-writable PATH entries and strips inherited credentials", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-installer-env-"));
  const target = path.join(parent, "target");
  const userBin = path.join(parent, "user-bin");
  try {
    await fs.mkdir(target);
    await fs.mkdir(userBin);
    const workspaceAlias = path.join(parent, "workspace-alias");
    await fs.symlink(target, workspaceAlias, "dir");
    const source = {
      PATH: [workspaceAlias, userBin, "/usr/local/share/npm-global/bin", "/usr/local/bin", "/usr/bin", os.homedir(), os.tmpdir()].join(path.delimiter),
      CODESPACE_AGENT_TOKEN: "agent-secret", GITHUB_TOKEN: "github-secret", GITHUB_CODESPACE_TOKEN: "codespace-secret",
      GH_TOKEN: "gh-secret", NODE_AUTH_TOKEN: "npm-secret", NPM_TOKEN: "npm-secret-2",
      GIT_ASKPASS: "/tmp/fake-askpass", AWS_SECRET_ACCESS_KEY: "aws-secret", AZURE_CLIENT_SECRET: "azure-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json", NODE_OPTIONS: "--no-warnings", NODE_PATH: "/tmp/node-modules",
      GIT_CONFIG_COUNT: "1", GIT_SSH_COMMAND: "fake-ssh", DOCKER_HOST: "tcp://127.0.0.1:2375",
      PYTHONPATH: "/tmp/python", GPG_AGENT_INFO: "/tmp/gpg-agent", CDPATH: "/tmp", IFS: ":", GLOBIGNORE: "*", ZDOTDIR: "/tmp/zsh", 'BASH_FUNC_evil%%': "() { echo inherited; }", SAFE_VALUE: "preserved"
    };
    const env = createInstallerEnv(source, target, os.homedir(), os.tmpdir());
    const entries = env.PATH.split(path.delimiter);
    assert.ok(entries.includes(await fs.realpath("/usr/bin")));
    assert.ok(!entries.includes(userBin));
    assert.ok(!entries.includes(workspaceAlias));
    assert.ok(!entries.includes("/usr/local/share/npm-global/bin"));
    assert.ok(!entries.includes(os.homedir()));
    assert.ok(!entries.includes(os.tmpdir()));
    for (const name of ["CODESPACE_AGENT_TOKEN", "GITHUB_TOKEN", "GITHUB_CODESPACE_TOKEN", "GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN", "GIT_ASKPASS", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "NODE_PATH", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "DOCKER_HOST", "PYTHONPATH", "GPG_AGENT_INFO", "CDPATH", "IFS", "GLOBIGNORE", "ZDOTDIR", "BASH_FUNC_evil%%"]) {
      assert.equal(env[name], undefined, name + " must be removed");
    }
    assert.equal(env.SAFE_VALUE, "preserved");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
