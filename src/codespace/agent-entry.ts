import { runCodespaceAgentSupervisor } from "./supervisor.js";

runCodespaceAgentSupervisor().catch(error => {
  console.error("Codespaces agent supervisor terminated:", error);
  process.exitCode = 1;
});
