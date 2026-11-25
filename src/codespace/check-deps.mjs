import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.env.CODESPACE_AGENT_WORKSPACE ?? process.cwd());
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const requiredPackages = [
  "@devcontainers/cli",
  "@types/node",
  "bash-language-server",
  "node-pty",
  "pyright",
  "tsx",
  "typescript",
  "typescript-language-server",
  "vscode-langservers-extracted",
  "yaml-language-server"
];
const requiredBins = [
  "devcontainer",
  "bash-language-server",
  "pyright-langserver",
  "typescript-language-server",
  "vscode-json-language-server",
  "vscode-html-language-server",
  "vscode-css-language-server",
  "yaml-language-server",
  "python3",
  "pip3",
  "git",
  "docker",
  "gh",
  "code"
];
const declared = { ...packageJson.dependencies, ...packageJson.devDependencies };
const missing = [];
for (const name of requiredPackages) {
  if (!declared[name]) missing.push(`package.json dependency: ${name}`);
  try { await access(path.join(root, "node_modules", ...name.split("/"), "package.json")); }
  catch { missing.push(`installed npm package: ${name}`); }
}
for (const name of requiredBins) {
  try { await access(path.join(root, "node_modules", ".bin", name), 1); }
  catch {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bash", ["-lc", `command -v "${name}"`], { encoding: "utf8" });
    if (result.status !== 0) missing.push(`required executable: ${name}`);
  }
}
try { require("node-pty"); }
catch { missing.push("node-pty native runtime module"); }
try { await access(path.join(root, "node_modules", "@types", "node", "index.d.ts")); }
catch { missing.push("@types/node TypeScript definitions"); }
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) missing.push(`Node.js 22+ (found ${process.version})`);

if (missing.length) {
  console.error("Codespaces agent requirements are not satisfied:");
  for (const item of [...new Set(missing)]) console.error(` - ${item}`);
  console.error("Install dependencies and required Dev Container tools, then rerun the Codespaces agent check.");
  process.exitCode = 1;
} else {
  console.log("All required Codespaces agent npm packages, executables, and runtime prerequisites are available.");
}
