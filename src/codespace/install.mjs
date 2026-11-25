#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const targetRoot = path.resolve(valueAfter("--target", process.cwd()));
const skipInstall = args.includes("--no-install");
const manifest = JSON.parse(await readFile(path.join(moduleRoot, "module.json"), "utf8"));
const destination = path.join(targetRoot, ".codespace-agent");
const packagePath = path.join(targetRoot, "package.json");
const devcontainerPath = path.join(targetRoot, ".devcontainer", "devcontainer.json");
const fragmentPath = path.join(targetRoot, ".devcontainer", "codespace-agent.fragment.json");
const requiredScripts = {
  "codespace-agent:start": "CODESPACE_AGENT_CHECK_SCRIPT=codespace-agent:check bash .codespace-agent/agent-service.sh start",
  "codespace-agent:status": "bash .codespace-agent/agent-service.sh status",
  "codespace-agent:stop": "bash .codespace-agent/agent-service.sh stop",
  "codespace-agent:logs": "bash .codespace-agent/agent-service.sh logs",
  "codespace-agent:check-deps": "node .codespace-agent/check-deps.mjs",
  "codespace-agent:typecheck": "tsc --noEmit --project .codespace-agent/tsconfig.json",
  "codespace-agent:test": "tsx --test .codespace-agent/agent-utils.test.ts .codespace-agent/agent-service.test.ts",
  "codespace-agent:check": "npm run codespace-agent:check-deps && npm run codespace-agent:typecheck && npm run codespace-agent:test"
};
const fail = message => { console.error(message); process.exit(1); };
const exists = async file => access(file).then(() => true).catch(() => false);

if (!(await exists(packagePath))) fail(`No package.json found in target project: ${targetRoot}`);
let targetPackage;
try { targetPackage = JSON.parse(await readFile(packagePath, "utf8")); }
catch (error) { fail(`Target package.json is not valid JSON: ${error.message}`); }
if (!targetPackage || typeof targetPackage !== "object" || Array.isArray(targetPackage)) fail("Target package.json must contain an object.");
targetPackage.devDependencies ??= {};
targetPackage.scripts ??= {};
if (typeof targetPackage.devDependencies !== "object" || Array.isArray(targetPackage.devDependencies) ||
    typeof targetPackage.scripts !== "object" || Array.isArray(targetPackage.scripts)) {
  fail("Target package.json scripts and devDependencies must be objects.");
}
for (const [name, command] of Object.entries(requiredScripts)) {
  if (targetPackage.scripts[name] && targetPackage.scripts[name] !== command) {
    fail(`Refusing to overwrite existing npm script "${name}". Rename it or merge it manually, then rerun.`);
  }
  targetPackage.scripts[name] = command;
}
for (const [name, version] of Object.entries(manifest.install.requiredPackages)) {
  if (!targetPackage.dependencies?.[name] && !targetPackage.devDependencies[name]) {
    targetPackage.devDependencies[name] = version;
  }
}

const fragment = {
  features: manifest.install.devcontainerFeatures,
  postCreateCommand: "sudo apt-get update && sudo apt-get install -y python3-pip && npm install && npm run codespace-agent:check",
  postStartCommand: "npm run codespace-agent:start",
  postAttachCommand: "npm run codespace-agent:start"
};
let nextDevcontainer = null;
let needsManualDevcontainerMerge = false;
if (await exists(devcontainerPath)) {
  try {
    const config = JSON.parse(await readFile(devcontainerPath, "utf8"));
    const lifecycleKeys = ["postCreateCommand", "postStartCommand", "postAttachCommand"];
    if (lifecycleKeys.some(key => config[key] !== undefined && typeof config[key] !== "string")) {
      needsManualDevcontainerMerge = true;
    } else {
      config.features = { ...(config.features ?? {}), ...fragment.features };
      for (const key of lifecycleKeys) {
        const existing = config[key] ?? "";
        const addition = fragment[key];
        config[key] = existing.includes(addition) ? existing : (existing ? `${existing} && ${addition}` : addition);
      }
      nextDevcontainer = JSON.stringify(config, null, 2) + "\n";
    }
  } catch {
    needsManualDevcontainerMerge = true;
  }
} else {
  nextDevcontainer = JSON.stringify({
    name: "Codespaces Agent",
    image: "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
    ...fragment
  }, null, 2) + "\n";
}
const fragmentText = JSON.stringify(fragment, null, 2) + "\n";
if (needsManualDevcontainerMerge && await exists(fragmentPath)) {
  const previous = await readFile(fragmentPath, "utf8");
  if (previous !== fragmentText) fail(`Refusing to overwrite an existing Dev Container merge fragment: ${fragmentPath}`);
}

const pendingCopies = [];
for (const relative of manifest.payload) {
  const source = path.join(moduleRoot, relative);
  const target = path.join(destination, relative);
  if (await exists(target)) {
    const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
    if (!sourceBytes.equals(targetBytes)) {
      fail(`Refusing to overwrite a different existing module file: ${target}. Back it up or reconcile it manually, then rerun.`);
    }
  } else pendingCopies.push({ source, target });
}

await mkdir(destination, { recursive: true });
for (const item of pendingCopies) {
  await mkdir(path.dirname(item.target), { recursive: true });
  await copyFile(item.source, item.target);
}
await writeFile(packagePath, JSON.stringify(targetPackage, null, 2) + "\n");
if (nextDevcontainer !== null) {
  await mkdir(path.dirname(devcontainerPath), { recursive: true });
  await writeFile(devcontainerPath, nextDevcontainer);
} else if (needsManualDevcontainerMerge) {
  await mkdir(path.dirname(fragmentPath), { recursive: true });
  await writeFile(fragmentPath, fragmentText);
  console.warn(`Dev Container config uses JSONC or unsupported lifecycle command shapes. Original config was preserved; merge ${fragmentPath} manually.`);
}

if (!skipInstall) {
  console.log("Installing the required Codespaces agent npm dependencies...");
  const result = spawnSync("npm", ["install"], { cwd: targetRoot, stdio: "inherit" });
  if (result.error) fail(`Could not run npm install: ${result.error.message}`);
  if (result.status !== 0) fail(`npm install failed with exit code ${result.status ?? "unknown"}.`);
  console.log("Running the complete Codespaces agent verification suite...");
  const check = spawnSync("npm", ["run", "codespace-agent:check"], { cwd: targetRoot, stdio: "inherit" });
  if (check.error) fail(`Could not run verification: ${check.error.message}`);
  if (check.status !== 0) fail(`Codespaces agent verification failed with exit code ${check.status ?? "unknown"}.`);
}

console.log(`Installed ${manifest.name} into ${destination}`);
console.log("The MCP host/relay integration is separate and is not included in this Codespace-side module.");
if (skipInstall) console.log("Dependencies were not installed because --no-install was supplied.");
