import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync(process.execPath, ["src/codespace/check-deps.mjs"], {
  cwd: process.cwd(),
  stdio: "inherit"
});
if (result.error) {
  console.error("Could not run the mandatory Codespaces agent dependency check:", result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
