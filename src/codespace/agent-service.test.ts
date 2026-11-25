import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceScript = fileURLToPath(new URL("./agent-service.sh", import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codespace-agent-service-"));
  const script = join(root, "src/codespace/agent-service.sh");
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(join(root, "src/codespace"), { recursive: true });
  mkdirSync(join(root, "node_modules/@types/node"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, "node_modules/@types/node/index.d.ts"), "export {};");
  writeFileSync(script, readFileSync(sourceScript));
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env bash\nexit \"\${FAKE_NPM_EXIT:-0}\"\n", { mode: 0o755 });
  writeFileSync(join(bin, "tsx"), "#!/usr/bin/env bash\nprintf 'launched' > \"$LAUNCH_MARKER\"\nexec -a \"$1\" bash -c \"sleep 30\"\n", { mode: 0o755 });
  return {
    root, script, bin, home,
    cleanup: () => {
      const pidPath = join(home, ".codespace-agent.pid");
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isInteger(pid) && pid > 1) spawnSync("kill", ["-TERM", String(pid)]);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function runService(fixture: ReturnType<typeof createFixture>, action: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [fixture.script, action], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: fixture.bin + ":" + process.env.PATH,
      CODESPACE_AGENT_URL: "https://agent.invalid",
      CODESPACE_AGENT_TOKEN: "a".repeat(48),
      CODESPACE_NAME: "test-codespace",
      LAUNCH_MARKER: join(fixture.root, "launched"),
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
