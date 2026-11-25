import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./agent-service.sh", import.meta.url));
const sourceStartScript = fileURLToPath(new URL("./agent-start.sh", import.meta.url));

function createFixture() {
  const parent = mkdtempSync(join(tmpdir(), "codespace-agent-service-"));
  const root = join(parent, "workspace");
  const script = join(root, "src/codespace/agent-service.sh");
  const startScript = join(root, "src/codespace/agent-start.sh");
  const bin = join(parent, "bin");
  const home = join(parent, "home");
  const workspaceBinAlias = join(parent, "workspace-bin-alias");
  mkdirSync(join(root, "src/codespace"), { recursive: true });
  mkdirSync(join(root, "node_modules/@types/node"), { recursive: true });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  symlinkSync(join(root, "node_modules/.bin"), workspaceBinAlias, "dir");
  writeFileSync(join(root, "node_modules/@types/node/index.d.ts"), "export {};");
  writeFileSync(script, readFileSync(sourceScript));
  writeFileSync(startScript, readFileSync(sourceStartScript));
  writeFileSync(join(bin, "npm"), [
    "#!/usr/bin/env bash",
    "for name in CODESPACE_AGENT_TOKEN GITHUB_TOKEN GITHUB_CODESPACE_TOKEN GH_TOKEN NODE_AUTH_TOKEN GIT_ASKPASS AWS_SECRET_ACCESS_KEY AZURE_CLIENT_SECRET GOOGLE_APPLICATION_CREDENTIALS NODE_OPTIONS NODE_PATH GIT_CONFIG_COUNT GIT_SSH_COMMAND DOCKER_HOST PYTHONPATH GPG_AGENT_INFO CDPATH IFS GLOBIGNORE ZDOTDIR; do",
    "  if [[ \"$name\" == IFS ]]; then if printenv IFS >/dev/null 2>&1; then printf '%s=present\\n' \"$name\" >> \"$FAKE_NPM_ENV_CAPTURE\"; else printf '%s=missing\\n' \"$name\" >> \"$FAKE_NPM_ENV_CAPTURE\"; fi; elif [[ -n \"${!name:-}\" ]]; then printf '%s=present\\n' \"$name\" >> \"$FAKE_NPM_ENV_CAPTURE\"; else printf '%s=missing\\n' \"$name\" >> \"$FAKE_NPM_ENV_CAPTURE\"; fi",
    "done",
    "if declare -F evil >/dev/null 2>&1; then echo 'BASH_FUNC_evil=present' >> \"$FAKE_NPM_ENV_CAPTURE\"; else echo 'BASH_FUNC_evil=missing' >> \"$FAKE_NPM_ENV_CAPTURE\"; fi",
    "exit \"${FAKE_NPM_EXIT:-0}\"",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(root, "node_modules/.bin/npm"), "#!/usr/bin/env bash\necho hijacked > \"$NPM_HIJACK_MARKER\"\nexit 99\n", { mode: 0o755 });
  writeFileSync(join(root, "node_modules/.bin/tsx"), "#!/usr/bin/env bash\nprintf 'token=%s\\n' \"${CODESPACE_AGENT_TOKEN:+present}\" > \"$AGENT_LAUNCH_ENV_CAPTURE\"\nprintf 'launched' > \"$LAUNCH_MARKER\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tsx"), "#!/usr/bin/env bash\nprintf 'launched' > \"$LAUNCH_MARKER\"\nexec -a \"$1\" bash -c \"sleep 30\"\n", { mode: 0o755 });
  return {
    root, script, startScript, bin, home, workspaceBinAlias,
    cleanup: () => {
      const pidPath = join(home, ".codespace-agent.pid");
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isInteger(pid) && pid > 1) spawnSync("kill", ["-TERM", String(pid)]);
      }
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

function runService(fixture: ReturnType<typeof createFixture>, action: string, extraEnv: Record<string, string> = {}, scriptPath = fixture.script) {
  return spawnSync("bash", [scriptPath, action], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: fixture.workspaceBinAlias + ":" + join(fixture.root, "node_modules/.bin") + ":" + fixture.bin + ":" + process.env.PATH,
      CODESPACE_AGENT_URL: "https://agent.invalid",
      CODESPACE_AGENT_TOKEN: "a".repeat(48),
      CODESPACE_NAME: "test-codespace",
      LAUNCH_MARKER: join(fixture.root, "launched"),
      NPM_HIJACK_MARKER: join(fixture.root, "npm-hijacked"),
      FAKE_NPM_ENV_CAPTURE: join(fixture.root, "npm-env.txt"),
      AGENT_LAUNCH_ENV_CAPTURE: join(fixture.root, "agent-launch-env.txt"),
      GITHUB_TOKEN: "synthetic-github-token",
      GITHUB_CODESPACE_TOKEN: "synthetic-codespace-token",
      GH_TOKEN: "synthetic-gh-token",
      NODE_AUTH_TOKEN: "synthetic-npm-token",
      GIT_ASKPASS: "/tmp/fake-askpass",
      AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
      AZURE_CLIENT_SECRET: "synthetic-azure-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: "/tmp/node-modules",
      GIT_CONFIG_COUNT: "1",
      GIT_SSH_COMMAND: "fake-ssh",
      DOCKER_HOST: "tcp://127.0.0.1:2375",
      PYTHONPATH: "/tmp/python",
      GPG_AGENT_INFO: "/tmp/gpg-agent",
      CDPATH: "/tmp", IFS: ":", GLOBIGNORE: "*", ZDOTDIR: "/tmp/zsh",
      "BASH_FUNC_evil%%": "() { echo inherited; }",
      ...extraEnv,
    },
  });
}

test("agent startup is blocked when mandatory verification fails", () => {
  const fixture = createFixture();
  try {
    const result = runService(fixture, "start", { FAKE_NPM_EXIT: "1" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /mandatory verification failed/i);
    assert.equal(existsSync(join(fixture.root, "launched")), false, "agent entrypoint must not launch");
    const captured = readFileSync(join(fixture.root, "npm-env.txt"), "utf8").trim().split("\n");
    assert.deepEqual(captured, [
      "CODESPACE_AGENT_TOKEN=missing", "GITHUB_TOKEN=missing", "GITHUB_CODESPACE_TOKEN=missing",
      "GH_TOKEN=missing", "NODE_AUTH_TOKEN=missing", "GIT_ASKPASS=missing",
      "AWS_SECRET_ACCESS_KEY=missing", "AZURE_CLIENT_SECRET=missing", "GOOGLE_APPLICATION_CREDENTIALS=missing",
      "NODE_OPTIONS=missing", "NODE_PATH=missing", "GIT_CONFIG_COUNT=missing", "GIT_SSH_COMMAND=missing",
      "DOCKER_HOST=missing", "PYTHONPATH=missing", "GPG_AGENT_INFO=missing",
      "CDPATH=missing", "IFS=missing", "GLOBIGNORE=missing", "ZDOTDIR=missing", "BASH_FUNC_evil=missing"
    ], "verification npm process must not receive credentials or askpass access");
    assert.equal(existsSync(join(fixture.root, "npm-hijacked")), false, "workspace npm shim must not shadow system npm");
  } finally {
    fixture.cleanup();
  }
});

test("agent status removes a stale PID file without launching a process", () => {
  const fixture = createFixture();
  try {
    const pidFile = join(fixture.home, ".codespace-agent.pid");
    writeFileSync(pidFile, "99999999\n");
    const result = runService(fixture, "status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Codespaces agent stopped/);
    assert.equal(existsSync(pidFile), false, "stale PID file should be removed");
    assert.equal(existsSync(join(fixture.root, "launched")), false);
  } finally {
    fixture.cleanup();
  }
});


test("foreground agent launcher sanitizes verification but preserves its token for the agent", () => {
  const fixture = createFixture();
  try {
    const result = runService(fixture, "", {}, fixture.startScript);
    assert.equal(result.status, 0, result.stderr);
    const captured = readFileSync(join(fixture.root, "npm-env.txt"), "utf8").trim().split("\n");
    assert.ok(captured.includes("CODESPACE_AGENT_TOKEN=missing"));
    assert.ok(captured.includes("GITHUB_TOKEN=missing"));
    assert.ok(captured.includes("CDPATH=missing"));
    assert.ok(captured.includes("BASH_FUNC_evil=missing"));
    assert.equal(readFileSync(join(fixture.root, "agent-launch-env.txt"), "utf8").trim(), "token=present");
    assert.equal(existsSync(join(fixture.root, "npm-hijacked")), false);
  } finally {
    fixture.cleanup();
  }
});
