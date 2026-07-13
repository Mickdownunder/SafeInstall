import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { classifyDeclaredSource, loadManifestDependencies } from "../project-state";
import { fileExists, relativeProjectKey } from "../project-discovery";
import type { ProjectInstallTargetsResult } from "./types";
import {
  classifyResolvedSource,
  createNonRegistryRequestedPackage,
  createRegistryRequestedPackage,
  extractSemverPrefix
} from "./shared";

interface PnpmLockfile {
  importers?: Record<string, PnpmImporter>;
  specifiers?: Record<string, string>;
  dependencies?: Record<string, string | PnpmImporterDependency>;
  devDependencies?: Record<string, string | PnpmImporterDependency>;
  optionalDependencies?: Record<string, string | PnpmImporterDependency>;
  packages?: Record<string, PnpmPackageEntry>;
}

interface PnpmImporter {
  dependencies?: Record<string, string | PnpmImporterDependency> | undefined;
  devDependencies?: Record<string, string | PnpmImporterDependency> | undefined;
  optionalDependencies?: Record<string, string | PnpmImporterDependency> | undefined;
}

interface PnpmImporterDependency {
  specifier?: string | undefined;
  version?: string | undefined;
}

interface PnpmPackageEntry {
  version?: string;
  resolution?: {
    integrity?: string;
    tarball?: string;
  };
}

function readDirectManifestDependencies(
  manifestDependencies: Record<string, string>
): Array<[string, string]> {
  return Object.entries(manifestDependencies).sort(([left], [right]) => left.localeCompare(right));
}

function normalizeImporterDependency(
  entry: string | PnpmImporterDependency | undefined
): { specifier?: string | undefined; version?: string | undefined } {
  if (!entry) {
    return {};
  }

  if (typeof entry === "string") {
    return { version: entry };
  }

  return {
    specifier: entry.specifier,
    version: entry.version
  };
}

function getImporter(lockfile: PnpmLockfile, importerKey: string): PnpmImporter | undefined {
  if (lockfile.importers?.[importerKey]) {
    return lockfile.importers[importerKey];
  }

  if (importerKey === "." && (
    lockfile.dependencies ||
    lockfile.devDependencies ||
    lockfile.optionalDependencies ||
    lockfile.specifiers
  )) {
    const applySpecifiers = (
      entries: Record<string, string | PnpmImporterDependency> | undefined
    ): Record<string, PnpmImporterDependency> | undefined => {
      if (!entries) {
        return undefined;
      }

      return Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => {
          if (typeof entry === "string") {
            return [name, { specifier: lockfile.specifiers?.[name], version: entry }];
          }

          return [name, { specifier: entry.specifier ?? lockfile.specifiers?.[name], version: entry.version }];
        })
      );
    };

    return {
      dependencies: applySpecifiers(lockfile.dependencies),
      devDependencies: applySpecifiers(lockfile.devDependencies),
      optionalDependencies: applySpecifiers(lockfile.optionalDependencies)
    };
  }

  return undefined;
}

function findPackageEntry(
  packages: Record<string, PnpmPackageEntry> | undefined,
  name: string,
  versionRef: string
): PnpmPackageEntry | undefined {
  if (!packages) {
    return undefined;
  }

  const exactKey = `${name}@${versionRef}`;
  if (packages[exactKey]) {
    return packages[exactKey];
  }

  const legacyKey = `/${name}/${versionRef}`;
  if (packages[legacyKey]) {
    return packages[legacyKey];
  }

  const matchingKey = Object.keys(packages).find((entryKey) => entryKey === exactKey || entryKey.startsWith(`${exactKey}(`));
  if (matchingKey) {
    return packages[matchingKey];
  }

  const legacyMatchingKey = Object.keys(packages).find((entryKey) => entryKey === legacyKey || entryKey.startsWith(`${legacyKey}_`));
  return legacyMatchingKey ? packages[legacyMatchingKey] : undefined;
}

export async function loadPnpmProjectInstallTargets(
  effectiveCwd: string,
  packageDir?: string
): Promise<ProjectInstallTargetsResult> {
  const lockfilePath = await (async () => {
    let currentDir = path.resolve(effectiveCwd);
    while (true) {
      const candidate = path.join(currentDir, "pnpm-lock.yaml");
      if (await fileExists(candidate)) {
        return candidate;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        return undefined;
      }

      currentDir = parentDir;
    }
  })();

  if (!lockfilePath) {
    return {
      targets: [],
      issues: ["Project install blocked: pnpm-lock.yaml is required for safeinstall pnpm install."]
    };
  }

  const rootDir = path.dirname(lockfilePath);
  const targetPackageDir = packageDir ?? rootDir;
  const importerKey = relativeProjectKey(rootDir, targetPackageDir);
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
  const lockfile = parseYaml(rawLockfile) as PnpmLockfile;
  const importer = getImporter(lockfile, importerKey);

  if (!importer) {
    return {
      targets: [],
      issues: [
        `Project install blocked: ${targetPackageDir} does not map to a pnpm importer in ${path.basename(lockfilePath)}.`
      ],
      lockfilePath
    };
  }

  const importerDependencies = {
    ...(importer.dependencies ?? {}),
    ...(importer.devDependencies ?? {}),
    ...(importer.optionalDependencies ?? {})
  };

  const issues: string[] = [];
  const targets: ProjectInstallTargetsResult["targets"] = [];

  for (const [name, manifestSpec] of directDependencies) {
    const importerDependency = normalizeImporterDependency(importerDependencies[name]);
    if (!importerDependency.version) {
      issues.push(`Project install blocked: ${name} is declared in package.json but missing from pnpm-lock.yaml.`);
      continue;
    }

    if (importerDependency.specifier && importerDependency.specifier !== manifestSpec) {
      issues.push(
        `Project install blocked: ${name} has specifier ${JSON.stringify(manifestSpec)} in package.json but ${JSON.stringify(importerDependency.specifier)} in pnpm-lock.yaml.`
      );
      continue;
    }

    const packageEntry = findPackageEntry(lockfile.packages, name, importerDependency.version);
    const declaredSourceType = classifyDeclaredSource(manifestSpec);

    if (importerDependency.version.startsWith("link:")) {
      targets.push({
        manifestSpec,
        requested: createNonRegistryRequestedPackage(
          name,
          manifestSpec,
          declaredSourceType === "directory" ? "directory" : "workspace",
          importerDependency.version
        ),
        lockfilePath
      });
      continue;
    }

    if (importerDependency.version.startsWith("file:")) {
      targets.push({
        manifestSpec,
        requested: createNonRegistryRequestedPackage(name, manifestSpec, "file", importerDependency.version),
        lockfilePath
      });
      continue;
    }

    const packageVersion = packageEntry?.version ?? extractSemverPrefix(importerDependency.version);
    const resolvedReference = packageEntry?.resolution?.tarball ?? importerDependency.version;
    const sourceType = classifyResolvedSource(
      declaredSourceType,
      resolvedReference,
      Boolean(packageEntry?.resolution?.integrity)
    );

    targets.push({
      manifestSpec,
      requested:
        sourceType === "registry" && packageVersion
          ? createRegistryRequestedPackage(name, packageVersion)
          : createNonRegistryRequestedPackage(name, importerDependency.specifier ?? manifestSpec, sourceType, resolvedReference),
      lockfilePath
    });
  }

  return { targets, issues, lockfilePath };
}
