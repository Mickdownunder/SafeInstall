import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { loadPackageJson, parseDeclaredPackageManager } from "./project-state";
import { findNearestUpward, relativeProjectKey } from "./project-discovery";
import { loadNpmProjectInstallTargets } from "./project-installs/npm";
import { loadPnpmProjectInstallTargets } from "./project-installs/pnpm";
import type { ProjectInstallTargetsResult } from "./project-installs/types";
import type { PackageManagerName } from "./types";

export type { ProjectInstallTargetsResult } from "./project-installs/types";
export { loadNpmProjectInstallTargets, loadPnpmProjectInstallTargets };

export function directLockfileKeys(targets: ProjectInstallTargetsResult): Set<string> {
  return new Set(
    targets.targets.flatMap((target) => target.lockfileKey === undefined ? [] : [target.lockfileKey])
  );
}

type LockfileManager = Extract<PackageManagerName, "npm" | "pnpm">;

export interface ProjectInstallScopePaths {
  root: string;
  lockfilePath: string;
  packageDirs: string[];
  manifestPaths: string[];
  /** Files whose contents can change pnpm workspace/importer resolution. */
  workspaceMetadataPaths: string[];
}

export interface LoadedProjectInstallScope extends ProjectInstallScopePaths {
  importers: Array<{
    packageDir: string;
    manifestPath: string;
    targets: ProjectInstallTargetsResult;
  }>;
  targets: ProjectInstallTargetsResult;
}

function objectKeys(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Project install blocked: lockfile ${field} must be an object.`);
  }
  return Object.keys(value);
}

/**
 * Enumerate every importer represented by one exact lockfile. The returned
 * paths are lexical descendants of the lockfile root and are therefore safe
 * to bind before their manifests are read for policy evaluation.
 */
export async function discoverProjectInstallScope(
  lockfilePath: string,
  manager: LockfileManager,
  additionalPackageDir?: string
): Promise<ProjectInstallScopePaths> {
  const resolvedLockfilePath = path.resolve(lockfilePath);
  const root = path.dirname(resolvedLockfilePath);
  const raw = await readFile(resolvedLockfilePath, "utf8");
  const document = (manager === "npm" ? JSON.parse(raw) : parseYaml(raw)) as {
    packages?: unknown;
    importers?: unknown;
  };
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Project install blocked: lockfile root must be an object.");
  }

  const importerMap = manager === "npm" ? document.packages : document.importers;
  const importerKeys = (manager === "npm"
    ? objectKeys(importerMap, "packages").filter(
        (key) => !key.split("/").includes("node_modules")
      )
    : objectKeys(importerMap, "importers")
  ).sort((left, right) => left.localeCompare(right));

  // Legacy lockfile formats have one implicit root importer. Modern formats
  // enumerate importers explicitly; a pnpm workspace need not have a root
  // package.json, so do not invent a root importer when the map is present.
  const packageDirs = new Set<string>(importerMap === undefined ? [root] : []);
  if (additionalPackageDir) {
    packageDirs.add(path.resolve(additionalPackageDir));
  }

  for (const importerKey of importerKeys) {
    const packageDir = path.resolve(root, importerKey || ".");
    const relative = path.relative(root, packageDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Project install blocked: a lockfile importer escapes the project root.");
    }

    const projectKey = relativeProjectKey(root, packageDir);
    const canonicalKey = manager === "npm" && projectKey === "." ? "" : projectKey;
    if (importerKey !== canonicalKey) {
      throw new Error(
        `Project install blocked: lockfile importer ${JSON.stringify(importerKey)} is not canonical.`
      );
    }
    packageDirs.add(packageDir);
  }

  const orderedPackageDirs = [...packageDirs];
  for (const packageDir of orderedPackageDirs) {
    const relative = path.relative(root, packageDir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Project install blocked: a package directory escapes the lockfile root.");
    }
  }

  return {
    root,
    lockfilePath: resolvedLockfilePath,
    packageDirs: orderedPackageDirs,
    manifestPaths: orderedPackageDirs.map((packageDir) => path.join(packageDir, "package.json")),
    workspaceMetadataPaths: manager === "pnpm" ? [path.join(root, "pnpm-workspace.yaml")] : []
  };
}

/** Load direct targets for every importer in a previously discovered scope. */
export async function loadProjectInstallScope(
  scope: ProjectInstallScopePaths,
  manager: LockfileManager
): Promise<LoadedProjectInstallScope> {
  const importers: LoadedProjectInstallScope["importers"] = [];

  for (const [index, packageDir] of scope.packageDirs.entries()) {
    const manifestPath = scope.manifestPaths[index];
    if (!manifestPath) {
      throw new Error("Project install blocked: importer manifest enumeration is inconsistent.");
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      manifest = undefined;
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      importers.push({
        packageDir,
        manifestPath,
        targets: {
          targets: [],
          issues: [`Project install blocked: ${manifestPath} is not a readable JSON object.`],
          lockfilePath: scope.lockfilePath
        }
      });
      continue;
    }

    const loaded = await loadProjectInstallTargetsForManager(packageDir, packageDir, manager);
    if (!loaded?.lockfilePath || path.resolve(loaded.lockfilePath) !== scope.lockfilePath) {
      importers.push({
        packageDir,
        manifestPath,
        targets: {
          targets: [],
          issues: ["Project install blocked: inconsistent workspace lockfile scope."],
          lockfilePath: scope.lockfilePath
        }
      });
      continue;
    }
    importers.push({ packageDir, manifestPath, targets: loaded });
  }

  return {
    ...scope,
    importers,
    targets: {
      targets: importers.flatMap((importer) => importer.targets.targets),
      issues: importers.flatMap((importer) => importer.targets.issues),
      lockfilePath: scope.lockfilePath
    }
  };
}

export async function loadProjectInstallTargetsForManager(
  effectiveCwd: string,
  packageDir: string | undefined,
  manager: PackageManagerName
): Promise<ProjectInstallTargetsResult | undefined> {
  const packageJson = packageDir ? await loadPackageJson(packageDir) : await loadPackageJson(effectiveCwd);
  const declaredManager = parseDeclaredPackageManager(packageJson?.packageManager);

  if (declaredManager && declaredManager !== manager) {
    return {
      targets: [],
      issues: [
        `Project install blocked: package.json declares ${declaredManager} as packageManager, but this command uses ${manager}.`
      ]
    };
  }

  if (manager === "pnpm") {
    return loadPnpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  if (manager === "npm") {
    return loadNpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  return undefined;
}

export async function inferProjectInstallTargetsForCheck(
  effectiveCwd: string,
  packageDir: string | undefined
): Promise<ProjectInstallTargetsResult | undefined> {
  const packageJson = packageDir ? await loadPackageJson(packageDir) : await loadPackageJson(effectiveCwd);
  const packageManager = parseDeclaredPackageManager(packageJson?.packageManager);
  const pnpmLockPath = await findNearestUpward(effectiveCwd, "pnpm-lock.yaml");
  const npmLockPath =
    (await findNearestUpward(effectiveCwd, "package-lock.json")) ??
    (await findNearestUpward(effectiveCwd, "npm-shrinkwrap.json"));
  const hasPnpmLock = Boolean(pnpmLockPath);
  const hasNpmLock = Boolean(npmLockPath);

  if (packageManager === "pnpm") {
    return loadPnpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  if (packageManager === "npm") {
    return loadNpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  if (hasPnpmLock && hasNpmLock) {
    return {
      targets: [],
      issues: [
        "Check blocked: both pnpm-lock.yaml and an npm lockfile exist. Set packageManager in package.json or remove the stale lockfile."
      ]
    };
  }

  if (hasPnpmLock) {
    return loadPnpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  if (hasNpmLock) {
    return loadNpmProjectInstallTargets(effectiveCwd, packageDir);
  }

  return undefined;
}
