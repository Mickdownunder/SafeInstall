import { readFile } from "node:fs/promises";
import path from "node:path";

import npa from "npm-package-arg";

import type { PackageManagerName, ProjectDependencyState, SourceType } from "./types";

interface PackageJsonShape {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function parseDeclaredPackageManager(packageManager?: string): PackageManagerName | undefined {
  if (packageManager?.startsWith("pnpm@")) {
    return "pnpm";
  }

  if (packageManager?.startsWith("npm@")) {
    return "npm";
  }

  if (packageManager?.startsWith("bun@")) {
    return "bun";
  }

  return undefined;
}

export function classifyDeclaredSource(spec: string): SourceType {
  if (
    spec.startsWith("github:") ||
    spec.startsWith("git+ssh://") ||
    spec.startsWith("git+https://") ||
    spec.startsWith("git@")
  ) {
    return "git";
  }

  try {
    const result = npa(spec);

    switch (result.type) {
      case "git":
        return "git";
      case "remote":
        return result.fetchSpec?.endsWith(".tgz") || result.fetchSpec?.endsWith(".tar.gz") ? "tarball" : "url";
      case "file":
        return "file";
      case "directory":
        return "directory";
      case "tag":
      case "range":
      case "version":
      case "alias":
        return "registry";
      default:
        return "unknown";
    }
  } catch {
    if (spec.startsWith("workspace:")) {
      return "workspace";
    }

    return "unknown";
  }
}

export async function loadPackageJson(cwd: string): Promise<PackageJsonShape | undefined> {
  const packageJsonPath = path.join(cwd, "package.json");

  try {
    const raw = await readFile(packageJsonPath, "utf8");
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

export async function loadProjectDependencyState(
  cwd: string,
  packageName: string
): Promise<ProjectDependencyState | undefined> {
  const packageJson = await loadPackageJson(cwd);
  const declaredSpec =
    packageJson?.dependencies?.[packageName] ??
    packageJson?.devDependencies?.[packageName] ??
    packageJson?.optionalDependencies?.[packageName];

  let installedVersion: string | undefined;

  try {
    const installedPackagePath = path.join(cwd, "node_modules", packageName, "package.json");
    const installedRaw = await readFile(installedPackagePath, "utf8");
    const installedPackage = JSON.parse(installedRaw) as { version?: string };
    installedVersion = installedPackage.version;
  } catch {
    installedVersion = undefined;
  }

  if (!declaredSpec && !installedVersion) {
    return undefined;
  }

  return {
    declaredSpec,
    declaredSourceType: declaredSpec ? classifyDeclaredSource(declaredSpec) : undefined,
    installedVersion
  };
}

export async function loadManifestDependencies(cwd: string): Promise<Record<string, string>> {
  const packageJson = await loadPackageJson(cwd);

  return {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.optionalDependencies ?? {})
  };
}
