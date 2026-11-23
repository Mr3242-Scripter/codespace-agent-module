import { runCodespaceAgent } from "./agent.js";

/**
 * Optional process supervisor for lifecycle hooks. The agent already reconnects
 * on transient network errors; this wrapper restarts it if the agent process
 * exits unexpectedly or throws during startup.
 */
export async function runCodespaceAgentSupervisor(options: { minDelayMs?: number; maxDelayMs?: number } = {}): Promise<void> {
  const minDelay = Math.max(250, Math.min(options.minDelayMs ?? 1000, 30000));
  const maxDelay = Math.max(minDelay, Math.min(options.maxDelayMs ?? 30000, 300000));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let delay = minDelay;
  while (!stopping) {
    try {
      await runCodespaceAgent();
      if (stopping) break;
      console.warn("Codespaces agent exited unexpectedly; restarting under supervisor.");
    } catch (error) {
      if (stopping) break;
      console.error("Codespaces agent failed; supervisor will restart it:", error);
    }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxDelay);
  }
}
