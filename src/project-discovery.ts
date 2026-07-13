import { access } from "node:fs/promises";
import path from "node:path";

import type { PackageManagerName } from "./types";

const CWD_FLAGS = new Set(["-C", "--dir", "--cwd", "--prefix"]);
const AMBIGUOUS_WORKSPACE_FLAGS: Record<PackageManagerName, Set<string>> = {
  npm: new Set(["-w", "--workspace", "--workspaces"]),
  pnpm: new Set(["-F", "--filter", "-r", "--recursive"]),
  bun: new Set([])
};

export interface InvocationContext {
  invokedCwd: string;
  effectiveCwd: string;
  packageDir?: string;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findNearestUpward(startDir: string, fileName: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, fileName);
    if (await fileExists(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

export async function findNearestPackageDir(startDir: string): Promise<string | undefined> {
  const packageJsonPath = await findNearestUpward(startDir, "package.json");
  return packageJsonPath ? path.dirname(packageJsonPath) : undefined;
}

function extractFlagValue(args: string[], index: number): string | undefined {
  const token = args[index];
  if (token === undefined) {
    return undefined;
  }
  if (token.includes("=")) {
    return token.slice(token.indexOf("=") + 1);
  }

  return args[index + 1];
}

export function resolveEffectiveCwd(invokedCwd: string, args: string[]): string {
  let effectiveCwd = path.resolve(invokedCwd);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }
    const flagName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    if (!CWD_FLAGS.has(flagName)) {
      continue;
    }

    const flagValue = extractFlagValue(args, index);
    if (!flagValue) {
      continue;
    }

    effectiveCwd = path.resolve(invokedCwd, flagValue);

    if (!token.includes("=")) {
      index += 1;
    }
  }

  return effectiveCwd;
}

export function hasAmbiguousWorkspaceFlags(manager: PackageManagerName, args: string[]): boolean {
  const flags = AMBIGUOUS_WORKSPACE_FLAGS[manager];

  return args.some((token) => flags.has(token.includes("=") ? token.slice(0, token.indexOf("=")) : token));
}

export async function resolveInvocationContext(
  invokedCwd: string,
  forwardedArgs: string[]
): Promise<InvocationContext> {
  const effectiveCwd = resolveEffectiveCwd(invokedCwd, forwardedArgs);
  const packageDir = await findNearestPackageDir(effectiveCwd);

  return {
    invokedCwd: path.resolve(invokedCwd),
    effectiveCwd,
    packageDir
  };
}

export function relativeProjectKey(rootDir: string, packageDir: string): string {
  const relativePath = path.relative(rootDir, packageDir);
  return relativePath === "" ? "." : relativePath.split(path.sep).join("/");
}

