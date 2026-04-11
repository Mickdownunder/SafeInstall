import { loadPackageJson, parseDeclaredPackageManager } from "./project-state";
import { findNearestUpward } from "./project-discovery";
import { loadNpmProjectInstallTargets } from "./project-installs/npm";
import { loadPnpmProjectInstallTargets } from "./project-installs/pnpm";
import type { ProjectInstallTargetsResult } from "./project-installs/types";
import type { PackageManagerName } from "./types";

export type { ProjectInstallTargetsResult } from "./project-installs/types";
export { loadNpmProjectInstallTargets, loadPnpmProjectInstallTargets };

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
