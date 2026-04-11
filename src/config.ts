import { readFile } from "node:fs/promises";
import path from "node:path";

import { findNearestUpward } from "./project-discovery";
import type { PackageManagerName, SafeInstallConfig } from "./types";

export const CONFIG_FILE_NAME = "safeinstall.config.json";
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

const KNOWN_CONFIG_KEYS = new Set<keyof SafeInstallConfig>([
  "minimumReleaseAgeHours",
  "registryUrl",
  "allowedScripts",
  "allowedSources",
  "allowedPackages",
  "ciMode",
  "packageManagerDefaults",
  "typoSquat",
  "provenance"
]);

const KNOWN_TYPO_SQUAT_KEYS = new Set<keyof SafeInstallConfig["typoSquat"]>([
  "mode",
  "minNameLength",
  "ignore"
]);

const KNOWN_PROVENANCE_KEYS = new Set<keyof SafeInstallConfig["provenance"]>([
  "mode",
  "requireFor",
  "trustedPublishers",
  "offlineBehavior"
]);

const TYPO_SQUAT_MODES = new Set(["off", "warn", "block"]);
const PROVENANCE_MODES = new Set(["off", "warn", "require"]);
const OFFLINE_BEHAVIORS = new Set(["fail-closed", "allow-cached"]);

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

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

  if (parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
    console.error(
      `Warning: registryUrl ${input} uses plaintext HTTP; package metadata is not protected against tampering in transit.`
    );
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
    },
    typoSquat: {
      mode: "off",
      minNameLength: 4,
      ignore: []
    },
    provenance: {
      mode: "off",
      requireFor: [],
      trustedPublishers: {},
      offlineBehavior: "fail-closed"
    }
  };
}

function validateTypoSquat(
  input: Partial<SafeInstallConfig["typoSquat"]> | undefined
): SafeInstallConfig["typoSquat"] {
  const defaults = createDefaultConfig().typoSquat;
  if (!input) {
    return defaults;
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !KNOWN_TYPO_SQUAT_KEYS.has(key as keyof SafeInstallConfig["typoSquat"])
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Config error: unknown key(s) in typoSquat: ${unknownKeys.map((key) => `"${key}"`).join(", ")}.`
    );
  }

  const mode = input.mode ?? defaults.mode;
  if (!TYPO_SQUAT_MODES.has(mode)) {
    throw new Error(`Config error: typoSquat.mode must be one of "off", "warn", "block".`);
  }

  const minNameLength = input.minNameLength ?? defaults.minNameLength;
  if (!Number.isInteger(minNameLength) || minNameLength < 1) {
    throw new Error("Config error: typoSquat.minNameLength must be a positive integer.");
  }

  const ignore = input.ignore ?? defaults.ignore;
  if (!Array.isArray(ignore) || ignore.some((entry) => typeof entry !== "string")) {
    throw new Error("Config error: typoSquat.ignore must be an array of strings.");
  }

  return {
    mode,
    minNameLength,
    ignore: ignore.map((entry) => entry.toLowerCase())
  };
}

function validateProvenance(
  input: Partial<SafeInstallConfig["provenance"]> | undefined
): SafeInstallConfig["provenance"] {
  const defaults = createDefaultConfig().provenance;
  if (!input) {
    return defaults;
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !KNOWN_PROVENANCE_KEYS.has(key as keyof SafeInstallConfig["provenance"])
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Config error: unknown key(s) in provenance: ${unknownKeys.map((key) => `"${key}"`).join(", ")}.`
    );
  }

  const mode = input.mode ?? defaults.mode;
  if (!PROVENANCE_MODES.has(mode)) {
    throw new Error(`Config error: provenance.mode must be one of "off", "warn", "require".`);
  }

  const requireFor = input.requireFor ?? defaults.requireFor;
  if (!Array.isArray(requireFor) || requireFor.some((entry) => typeof entry !== "string")) {
    throw new Error("Config error: provenance.requireFor must be an array of strings.");
  }

  const trustedPublishers = input.trustedPublishers ?? defaults.trustedPublishers;
  if (
    typeof trustedPublishers !== "object" ||
    trustedPublishers === null ||
    Array.isArray(trustedPublishers)
  ) {
    throw new Error(
      "Config error: provenance.trustedPublishers must be an object mapping package patterns to repository patterns."
    );
  }
  for (const [key, value] of Object.entries(trustedPublishers)) {
    if (typeof key !== "string" || typeof value !== "string") {
      throw new Error(
        `Config error: provenance.trustedPublishers entries must map string to string (got ${key}: ${typeof value}).`
      );
    }
  }

  const offlineBehavior = input.offlineBehavior ?? defaults.offlineBehavior;
  if (!OFFLINE_BEHAVIORS.has(offlineBehavior)) {
    throw new Error(
      `Config error: provenance.offlineBehavior must be "fail-closed" or "allow-cached".`
    );
  }

  return {
    mode,
    requireFor: [...requireFor],
    trustedPublishers: { ...trustedPublishers },
    offlineBehavior
  };
}

function isPackageManagerName(value: string): value is PackageManagerName {
  return value === "npm" || value === "pnpm" || value === "bun";
}

function mergeConfig(input: Partial<SafeInstallConfig>): SafeInstallConfig {
  const unknownKeys = Object.keys(input).filter(
    (key) => !KNOWN_CONFIG_KEYS.has(key as keyof SafeInstallConfig)
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Config error: unknown key(s) ${unknownKeys.map((key) => `"${key}"`).join(", ")}. ` +
        "Check for typos against the documented schema."
    );
  }

  const defaultConfig = createDefaultConfig();
  const merged: SafeInstallConfig = {
    ...defaultConfig,
    ...input,
    allowedScripts: {
      ...defaultConfig.allowedScripts,
      ...(input.allowedScripts ?? {})
    },
    allowedPackages: (input.allowedPackages ?? defaultConfig.allowedPackages).map((name) =>
      name.toLowerCase()
    ),
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
    },
    typoSquat: validateTypoSquat(input.typoSquat),
    provenance: validateProvenance(input.provenance)
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
