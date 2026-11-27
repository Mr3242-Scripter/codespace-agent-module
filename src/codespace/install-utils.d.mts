export function filterInstallerPath(
  searchPath: string | undefined,
  targetRoot: string,
  homeDirectory: string,
  temporaryDirectory: string,
  trustedOwnerUid?: number
): string;

export function createInstallerEnv(
  source: NodeJS.ProcessEnv,
  targetRoot: string,
  homeDirectory: string,
  temporaryDirectory: string
): NodeJS.ProcessEnv & { PATH: string };
