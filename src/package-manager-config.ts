import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { CliReason, PackageManagerName } from "./types";

/**
 * Configuration the package manager picks up on its own, next to the command
 * line SafeInstall builds for it: `.npmrc` files and `pnpm-workspace.yaml` in
 * the project, and `npm_config_*` environment variables.
 *
 * Credentials and registry scopes belong there and stay untouched. A few
 * settings do something else: they move what the package manager writes or
 * reads to another place, switch off its integrity checks, or make it load
 * code. Those would take effect behind a reviewed lockfile and a clean
 * command line, so a project that sets them is not installed.
 */

/** Unsafe whatever their value. */
const UNSAFE_SETTINGS: Record<PackageManagerName, ReadonlySet<string>> = {
  pnpm: new Set([
    // Where dependencies are written and which lockfile is read.
    "modules-dir", "virtual-store-dir", "lockfile-dir", "global-dir", "global-bin-dir",
    // A store the project supplies is content nobody verified.
    "store-dir",
    // Code or a runtime loaded by the package manager.
    "pnpmfile", "global-pnpmfile", "use-node-version"
  ]),
  npm: new Set(["prefix", "global", "location", "git", "script-shell", "shell", "node-options", "onload-script"]),
  bun: new Set()
};

/** Unsafe unless set to `true`. */
const REQUIRED_TRUE_SETTINGS: Record<PackageManagerName, ReadonlySet<string>> = {
  pnpm: new Set(["verify-store-integrity", "strict-store-pkg-content-check", "lockfile", "ignore-pnpmfile", "ignore-scripts"]),
  npm: new Set(["ignore-scripts", "package-lock"]),
  bun: new Set()
};

/** Path settings a user or CI sets for itself; unsafe only when the project supplies them. */
const PROJECT_ONLY_SETTINGS = new Set(["store-dir"]);

const UNSAFE_PREFIXES: Record<PackageManagerName, string[]> = {
  pnpm: ["node-mirror:"],
  npm: [],
  bun: []
};

/** `modulesDir`, `modules_dir` and `MODULES-DIR` all name `modules-dir`. */
function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/\[\]$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function isUnsafe(manager: PackageManagerName, key: string, value: string, fromProject: boolean): boolean {
  const normalized = normalizeKey(key);
  if (!fromProject && PROJECT_ONLY_SETTINGS.has(normalized)) {
    return false;
  }
  if (UNSAFE_SETTINGS[manager].has(normalized) || UNSAFE_PREFIXES[manager].some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return REQUIRED_TRUE_SETTINGS[manager].has(normalized) && value.trim().toLowerCase() !== "true";
}

/** `key=value` lines of an `.npmrc`; comments and blank lines dropped. */
export function parseNpmrc(content: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "true" : line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    entries.push([key.trim(), value]);
  }
  return entries;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The project's directories from `packageDir` up to its repository root. The
 * home directory and everything above it hold the user's own configuration
 * and are never part of the project.
 */
async function projectDirectories(packageDir: string): Promise<string[]> {
  const home = path.resolve(os.homedir());
  const directories: string[] = [];
  let current = path.resolve(packageDir);
  for (;;) {
    if (current === home) {
      break;
    }
    directories.push(current);
    if (await exists(path.join(current, ".git"))) {
      return directories;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  // No repository: only the package's own directory is certainly the project.
  return directories.slice(0, 1);
}

function envSetting(name: string): string | undefined {
  const match = /^(?:npm|pnpm)_config_(.+)$/i.exec(name);
  return match?.[1];
}

/**
 * Reasons not to start the package manager because of configuration it would
 * read by itself. Empty when there is nothing of the kind.
 */
export async function packageManagerConfigReasons(
  manager: PackageManagerName,
  packageDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CliReason[]> {
  const found: Array<{ source: string; key: string }> = [];
  const directories = await projectDirectories(packageDir);
  const projectRoot = directories[directories.length - 1] ?? path.resolve(packageDir);

  const npmrcFiles = directories.map((directory) => path.join(directory, ".npmrc"));
  for (const [name, value] of Object.entries(env)) {
    // A user configuration file inside the project is project content.
    if (/^npm_config_userconfig$/i.test(name) && value) {
      const resolved = path.resolve(packageDir, value);
      const relative = path.relative(projectRoot, resolved);
      if (!relative.startsWith("..") && !path.isAbsolute(relative) && !npmrcFiles.includes(resolved)) {
        npmrcFiles.push(resolved);
      }
    }
  }

  for (const file of npmrcFiles) {
    const content = await readIfPresent(file);
    if (content === undefined) {
      continue;
    }
    for (const [key, value] of parseNpmrc(content)) {
      if (isUnsafe(manager, key, value, true)) {
        found.push({ source: path.relative(projectRoot, file) || path.basename(file), key: key.trim() });
      }
    }
  }

  if (manager === "pnpm") {
    for (const directory of directories) {
      const file = path.join(directory, "pnpm-workspace.yaml");
      const content = await readIfPresent(file);
      if (content === undefined) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseYaml(content);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (isUnsafe(manager, key, String(value), true)) {
          found.push({ source: path.relative(projectRoot, file) || path.basename(file), key });
        }
      }
    }
  }

  for (const [name, value] of Object.entries(env)) {
    const setting = envSetting(name);
    if (setting !== undefined && value !== undefined && isUnsafe(manager, setting, value, false)) {
      found.push({ source: "the environment", key: name });
    }
  }

  return found.map(({ source, key }) => ({
    code: "unsafe-package-manager-config",
    message:
      `Install blocked: ${source} sets ${JSON.stringify(key)}, which changes where ${manager} reads or writes, ` +
      "switches off one of its checks, or makes it load code. SafeInstall cannot bind an install that depends on it.",
    suggestion: "Remove the setting. Credentials and registry scopes in .npmrc are not affected."
  }));
}
