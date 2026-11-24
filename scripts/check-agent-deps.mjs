import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const bin = path.join(root, "node_modules", ".bin");
const requiredBins = [
  "devcontainer",
  "bash-language-server",
  "pyright-langserver",
  "typescript-language-server",
  "vscode-json-language-server",
  "vscode-html-language-server",
  "vscode-css-language-server",
  "yaml-language-server"
];
const missing = [];
for (const name of requiredBins) {
  try { await access(path.join(bin, name)); }
  catch { missing.push(name); }
}
try {
  createRequire(import.meta.url)("node-pty");
} catch {
  missing.push("node-pty (Node module)");
}
if (missing.length) {
  console.error("Required Codespaces agent dependencies are missing:");
  for (const name of missing) console.error(` - ${name}`);
  console.error("Run npm install from the workspace root, then rerun npm run agent:check-deps.");
  process.exitCode = 1;
} else {
  console.log("All required agent dependencies are installed:");
  for (const name of requiredBins) console.log(` - ${name}`);
  console.log(" - node-pty");
}
