import { realpathSync, statSync } from "node:fs";
import path from "node:path";

function inside(candidate, base) {
  return candidate === base || candidate.startsWith(base + path.sep);
}

function trustedDirectory(directory, ownerUid) {
  let current = path.resolve(directory);
  while (true) {
    let stat;
    try { stat = statSync(current); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export function filterInstallerPath(searchPath, targetRoot, homeDirectory, temporaryDirectory, trustedOwnerUid = 0) {
  const excluded = [targetRoot, homeDirectory, temporaryDirectory].map(value => {
    try { return realpathSync(path.resolve(value)); } catch { return path.resolve(value); }
  });
  const safe = [];
  for (const entry of String(searchPath ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      const directory = realpathSync(path.resolve(entry));
      if (excluded.some(base => inside(directory, base))) continue;
      if (!trustedDirectory(directory, trustedOwnerUid)) continue;
      if (!safe.includes(directory)) safe.push(directory);
    } catch {}
  }
  return safe.join(path.delimiter);
}

const sensitiveEnvName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|COOKIE|AUTH|CREDENTIAL|CERT|PRIVATE|SESSION|ASKPASS|ACCESS|AGENT|SOCKET)/i;
const cloudCredentialEnvName = /^(?:AWS_|AZURE_|ARM_|GOOGLE_|GCLOUD_|CLOUDSDK_|GCP_|VAULT_|TF_VAR_|KUBECONFIG$|DOCKER_CONFIG$)/i;
const executionEnvName = /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|GIT_.*|DOCKER_HOST|DOCKER_CONTEXT|CONTAINER_HOST|COREPACK_.*|NPM_CONFIG_.*|npm_config_.*)$/i;

export function createInstallerEnv(source, targetRoot, homeDirectory, temporaryDirectory) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (sensitiveEnvName.test(name) || cloudCredentialEnvName.test(name) || executionEnvName.test(name)) delete env[name];
  }
  env.PATH = filterInstallerPath(source.PATH, targetRoot, homeDirectory, temporaryDirectory);
  return env;
}
