import { readFile } from "node:fs/promises";
import path from "node:path";

import { findNearestUpward } from "./project-discovery";
import type { PackageManagerName, SafeInstallConfig } from "./types";

export const CONFIG_FILE_NAME = "safeinstall.config.json";
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

function normalizeRegistryUrl(input: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error("Config error: registryUrl must be a valid http or https URL.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Config error: registryUrl must use http or https.");
  }

  const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, "");
  parsedUrl.pathname = normalizedPathname === "" ? "/" : normalizedPathname;
  return parsedUrl.toString().replace(/\/$/, "");
}

export function createDefaultConfig(): SafeInstallConfig {
  return {
    minimumReleaseAgeHours: 72,
    registryUrl: DEFAULT_REGISTRY_URL,
    allowedScripts: {},
    allowedSources: ["registry", "workspace", "file", "directory"],
    allowedPackages: [],
    ciMode: process.env.CI === "true",
    packageManagerDefaults: {
      npm: { ignoreScripts: true },
      pnpm: { ignoreScripts: true },
      bun: { ignoreScripts: true }
    }
  };
}

function isPackageManagerName(value: string): value is PackageManagerName {
  return value === "npm" || value === "pnpm" || value === "bun";
}

function mergeConfig(input: Partial<SafeInstallConfig>): SafeInstallConfig {
  const defaultConfig = createDefaultConfig();
  const merged: SafeInstallConfig = {
    ...defaultConfig,
    ...input,
    allowedScripts: {
      ...defaultConfig.allowedScripts,
      ...(input.allowedScripts ?? {})
    },
    packageManagerDefaults: {
      npm: {
        ...defaultConfig.packageManagerDefaults.npm,
        ...(input.packageManagerDefaults?.npm ?? {})
      },
      pnpm: {
        ...defaultConfig.packageManagerDefaults.pnpm,
        ...(input.packageManagerDefaults?.pnpm ?? {})
      },
      bun: {
        ...defaultConfig.packageManagerDefaults.bun,
        ...(input.packageManagerDefaults?.bun ?? {})
      }
    }
  };

  if (!Number.isFinite(merged.minimumReleaseAgeHours) || merged.minimumReleaseAgeHours < 0) {
    throw new Error("Config error: minimumReleaseAgeHours must be a non-negative number.");
  }

  merged.registryUrl = normalizeRegistryUrl(merged.registryUrl);

  for (const source of merged.allowedSources) {
    if (
      source !== "registry" &&
      source !== "git" &&
      source !== "tarball" &&
      source !== "url" &&
      source !== "file" &&
      source !== "directory" &&
      source !== "workspace" &&
      source !== "unknown"
    ) {
      throw new Error(`Config error: unsupported source type "${source}".`);
    }
  }

  for (const [packageName, scripts] of Object.entries(merged.allowedScripts)) {
    if (!Array.isArray(scripts)) {
      throw new Error(`Config error: allowedScripts.${packageName} must be an array.`);
    }

    for (const script of scripts) {
      if (script !== "preinstall" && script !== "install" && script !== "postinstall") {
        throw new Error(`Config error: allowedScripts.${packageName} contains unsupported script "${script}".`);
      }
    }
  }

  for (const [manager, defaults] of Object.entries(merged.packageManagerDefaults)) {
    if (!isPackageManagerName(manager)) {
      throw new Error(`Config error: unsupported package manager "${manager}".`);
    }

    if (typeof defaults.ignoreScripts !== "boolean") {
      throw new Error(`Config error: packageManagerDefaults.${manager}.ignoreScripts must be a boolean.`);
    }
  }

  return merged;
}

async function findConfigFile(startDir: string): Promise<string | undefined> {
  return findNearestUpward(path.resolve(startDir), CONFIG_FILE_NAME);
}

export function getConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE_NAME);
}

export function serializeConfig(config: SafeInstallConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function loadConfig(startDir: string): Promise<{ config: SafeInstallConfig; path?: string }> {
  const configPath = await findConfigFile(startDir);
  if (!configPath) {
    return { config: createDefaultConfig() };
  }

  const rawText = await readFile(configPath, "utf8");
  const parsed = JSON.parse(rawText) as Partial<SafeInstallConfig>;
  return {
    config: mergeConfig(parsed),
    path: configPath
  };
}
