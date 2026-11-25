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
    const devcontainer = JSON.parse(await fs.readFile(path.join(target, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.match(devcontainer.postCreateCommand, /unset CODESPACE_AGENT_TOKEN GITHUB_TOKEN GITHUB_CODESPACE_TOKEN GH_TOKEN/);
    assert.match(devcontainer.postCreateCommand, /npm install && npm run codespace-agent:check/);
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

test("portable installer strips credentials and workspace npm shims before package scripts", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codespace-installer-env-"));
  const target = path.join(parent, "target");
  const bin = path.join(parent, "bin");
  const workspaceBin = path.join(target, "node_modules", ".bin");
  try {
    await fs.mkdir(workspaceBin, { recursive: true });
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(target, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(path.join(workspaceBin, "npm"), "#!/usr/bin/env bash\necho hijacked > \"$NPM_HIJACK_MARKER\"\nexit 99\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, "npm"), [
      "#!/usr/bin/env bash",
      "for name in CODESPACE_AGENT_TOKEN GITHUB_TOKEN GITHUB_CODESPACE_TOKEN GH_TOKEN NODE_AUTH_TOKEN NPM_TOKEN GIT_ASKPASS; do",
      "  if [[ -n \"${!name:-}\" ]]; then printf '%s=present\\n' \"$name\" >> \"$INSTALLER_ENV_CAPTURE\"; else printf '%s=missing\\n' \"$name\" >> \"$INSTALLER_ENV_CAPTURE\"; fi",
      "done",
      "printf '%s\\n' '--- invocation ---' >> \"$INSTALLER_ENV_CAPTURE\"",
      "exit 0"
    ].join("\n"), { mode: 0o755 });

    const result = spawnSync(process.execPath, [installer, "--target", target], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [workspaceBin, bin, process.env.PATH].join(path.delimiter),
        CODESPACE_AGENT_TOKEN: "agent-secret",
        GITHUB_TOKEN: "github-secret",
        GITHUB_CODESPACE_TOKEN: "codespace-secret",
        GH_TOKEN: "gh-secret",
        NODE_AUTH_TOKEN: "npm-secret",
        NPM_TOKEN: "npm-secret-2",
        GIT_ASKPASS: "/tmp/fake-askpass",
        INSTALLER_ENV_CAPTURE: path.join(parent, "installer-env.txt"),
        NPM_HIJACK_MARKER: path.join(parent, "npm-hijacked")
      }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.access(path.join(parent, "npm-hijacked")).then(() => true).catch(() => false), false);
    const capture = await fs.readFile(path.join(parent, "installer-env.txt"), "utf8");
    assert.equal(capture.split("--- invocation ---").length - 1, 2, "installer should invoke npm install and verification");
    assert.doesNotMatch(capture, /=(?:present)/, "npm install and verification must not inherit credentials or askpass access");
    assert.match(capture, /CODESPACE_AGENT_TOKEN=missing/);
    assert.match(capture, /GITHUB_TOKEN=missing/);
    assert.match(capture, /NODE_AUTH_TOKEN=missing/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
