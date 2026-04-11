import { readFile } from "node:fs/promises";
import path from "node:path";

import { classifyDeclaredSource, loadManifestDependencies } from "../project-state";
import { fileExists, relativeProjectKey } from "../project-discovery";
import type { ProjectInstallTargetsResult } from "./types";
import {
  classifyResolvedSource,
  createNonRegistryRequestedPackage,
  createRegistryRequestedPackage
} from "./shared";

interface NpmLockfile {
  packages?: Record<string, NpmPackageEntry>;
  dependencies?: Record<string, NpmLegacyDependencyEntry>;
}

interface NpmPackageEntry {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
}

interface NpmLegacyDependencyEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
}

function readDirectManifestDependencies(
  manifestDependencies: Record<string, string>
): Array<[string, string]> {
  return Object.entries(manifestDependencies).sort(([left], [right]) => left.localeCompare(right));
}

async function resolveNpmLockfilePath(effectiveCwd: string): Promise<string | undefined> {
  let currentDir = path.resolve(effectiveCwd);

  while (true) {
    const packageLockPath = path.join(currentDir, "package-lock.json");
    if (await fileExists(packageLockPath)) {
      return packageLockPath;
    }

    const shrinkwrapPath = path.join(currentDir, "npm-shrinkwrap.json");
    if (await fileExists(shrinkwrapPath)) {
      return shrinkwrapPath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

export async function loadNpmProjectInstallTargets(
  effectiveCwd: string,
  packageDir?: string
): Promise<ProjectInstallTargetsResult> {
  const lockfilePath = await resolveNpmLockfilePath(effectiveCwd);
  if (!lockfilePath) {
    return {
      targets: [],
      issues: ["Project install blocked: package-lock.json or npm-shrinkwrap.json is required for safeinstall npm install."]
    };
  }

  const rootDir = path.dirname(lockfilePath);
  const targetPackageDir = packageDir ?? rootDir;
  const packageEntryKey = relativeProjectKey(rootDir, targetPackageDir) === "." ? "" : relativeProjectKey(rootDir, targetPackageDir);
  const manifestDependencies = await loadManifestDependencies(targetPackageDir);
  const directDependencies = readDirectManifestDependencies(manifestDependencies);

  if (directDependencies.length === 0) {
    return {
      targets: [],
      issues: [],
      lockfilePath
    };
  }

  const rawLockfile = await readFile(lockfilePath, "utf8");
  const lockfile = JSON.parse(rawLockfile) as NpmLockfile;
  const packageEntry = lockfile.packages?.[packageEntryKey];

  if (!packageEntry) {
    return {
      targets: [],
      issues: [
        `Project install blocked: ${targetPackageDir} does not map to a package entry in ${path.basename(lockfilePath)}.`
      ],
      lockfilePath
    };
  }

  const issues: string[] = [];
  const targets: ProjectInstallTargetsResult["targets"] = [];

  for (const [name, manifestSpec] of directDependencies) {
    const lockedSpec =
      packageEntry.dependencies?.[name] ??
      packageEntry.devDependencies?.[name] ??
      packageEntry.optionalDependencies?.[name];

    if (lockedSpec && lockedSpec !== manifestSpec) {
      issues.push(
        `Project install blocked: ${name} has specifier ${JSON.stringify(manifestSpec)} in package.json but ${JSON.stringify(lockedSpec)} in ${path.basename(lockfilePath)}.`
      );
      continue;
    }

    const resolvedPackageEntry =
      lockfile.packages?.[`node_modules/${name}`] ??
      lockfile.packages?.[`${packageEntryKey ? `${packageEntryKey}/` : ""}node_modules/${name}`] ??
      lockfile.dependencies?.[name];

    if (!resolvedPackageEntry) {
      issues.push(`Project install blocked: ${name} is declared in package.json but missing from ${path.basename(lockfilePath)}.`);
      continue;
    }

    const declaredSourceType = classifyDeclaredSource(manifestSpec);
    const sourceType = classifyResolvedSource(
      declaredSourceType,
      resolvedPackageEntry.resolved,
      Boolean(resolvedPackageEntry.integrity)
    );

    targets.push({
      manifestSpec,
      requested:
        sourceType === "registry" && resolvedPackageEntry.version
          ? createRegistryRequestedPackage(name, resolvedPackageEntry.version)
          : createNonRegistryRequestedPackage(
              name,
              manifestSpec,
              sourceType,
              resolvedPackageEntry.resolved ?? manifestSpec
            ),
      lockfilePath
    });
  }

  return { targets, issues, lockfilePath };
}
