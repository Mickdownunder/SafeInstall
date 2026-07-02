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
  "packageManagerDefaults",
  "typoSquat",
  "provenance",
  "transitive",
  "continuity"
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

const KNOWN_TRANSITIVE_KEYS = new Set<keyof SafeInstallConfig["transitive"]>(["mode", "checks"]);

const KNOWN_CONTINUITY_KEYS = new Set<keyof SafeInstallConfig["continuity"]>(["mode", "baselineSize"]);

const TYPO_SQUAT_MODES = new Set(["off", "warn", "block"]);
const PROVENANCE_MODES = new Set(["off", "warn", "require"]);
const OFFLINE_BEHAVIORS = new Set(["fail-closed", "allow-cached"]);
const TRANSITIVE_MODES = new Set(["off", "warn", "block"]);
const TRANSITIVE_CHECKS = new Set(["install-script", "untrusted-source"]);
const CONTINUITY_MODES = new Set(["off", "warn", "block"]);

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
    },
    transitive: {
      mode: "off",
      checks: ["install-script", "untrusted-source"]
    },
    continuity: {
      mode: "off",
      baselineSize: 5
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

function validateTransitive(
  input: Partial<SafeInstallConfig["transitive"]> | undefined
): SafeInstallConfig["transitive"] {
  const defaults = createDefaultConfig().transitive;
  if (!input) {
    return defaults;
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !KNOWN_TRANSITIVE_KEYS.has(key as keyof SafeInstallConfig["transitive"])
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Config error: unknown key(s) in transitive: ${unknownKeys.map((key) => `"${key}"`).join(", ")}.`
    );
  }

  const mode = input.mode ?? defaults.mode;
  if (!TRANSITIVE_MODES.has(mode)) {
    throw new Error(`Config error: transitive.mode must be one of "off", "warn", "block".`);
  }

  const checks = input.checks ?? defaults.checks;
  if (!Array.isArray(checks)) {
    throw new Error("Config error: transitive.checks must be an array.");
  }
  for (const check of checks) {
    if (!TRANSITIVE_CHECKS.has(check)) {
      throw new Error(
        `Config error: transitive.checks contains unsupported check "${check}". Supported: "install-script", "untrusted-source".`
      );
    }
  }

  return {
    mode,
    checks: [...checks]
  };
}

function validateContinuity(
  input: Partial<SafeInstallConfig["continuity"]> | undefined
): SafeInstallConfig["continuity"] {
  const defaults = createDefaultConfig().continuity;
  if (!input) {
    return defaults;
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !KNOWN_CONTINUITY_KEYS.has(key as keyof SafeInstallConfig["continuity"])
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Config error: unknown key(s) in continuity: ${unknownKeys.map((key) => `"${key}"`).join(", ")}.`
    );
  }

  const mode = input.mode ?? defaults.mode;
  if (!CONTINUITY_MODES.has(mode)) {
    throw new Error(`Config error: continuity.mode must be one of "off", "warn", "block".`);
  }

  const baselineSize = input.baselineSize ?? defaults.baselineSize;
  if (!Number.isInteger(baselineSize) || baselineSize < 1 || baselineSize > 50) {
    throw new Error("Config error: continuity.baselineSize must be an integer between 1 and 50.");
  }

  return {
    mode,
    baselineSize
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
    provenance: validateProvenance(input.provenance),
    transitive: validateTransitive(input.transitive),
    continuity: validateContinuity(input.continuity)
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

export async function loadConfig(
  startDir: string,
  explicitPath?: string
): Promise<{ config: SafeInstallConfig; path?: string }> {
  let configPath: string | undefined;

  if (explicitPath) {
    // An explicit path is a hard requirement: failing to read it must error
    // rather than silently fall back to defaults, so CI cannot run with a
    // weaker policy than the caller intended.
    configPath = path.resolve(startDir, explicitPath);
  } else {
    configPath = await findConfigFile(startDir);
    if (!configPath) {
      return { config: createDefaultConfig() };
    }
  }

  let rawText: string;
  try {
    rawText = await readFile(configPath, "utf8");
  } catch (error) {
    if (explicitPath) {
      throw new Error(
        `Config error: cannot read config file at ${configPath} (${error instanceof Error ? error.message : String(error)}).`
      );
    }
    throw error;
  }

  const parsed = JSON.parse(rawText) as Partial<SafeInstallConfig>;
  return {
    config: mergeConfig(parsed),
    path: configPath
  };
}
