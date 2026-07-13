import npa from "npm-package-arg";

import type { InstallPlan, PackageManagerName, RequestedPackage, SourceType } from "./types";

export const FLAGS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "-w",
  "--cache",
  "--config",
  "--cwd",
  "--dir",
  "--filter",
  "--global-dir",
  "--lockfile-dir",
  "--prefix",
  "--registry",
  "--save-prefix",
  "--store-dir",
  "--tag",
  "--userconfig",
  "--workspace"
]);

function classifySourceType(result: npa.Result): SourceType {
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
}

function classifyRegistrySpecKind(result: npa.Result): RequestedPackage["registrySpecKind"] {
  switch (result.type) {
    case "tag":
      return "tag";
    case "version":
      return "version";
    case "range":
    case "alias":
      return "range";
    case "git":
    case "file":
    case "directory":
    case "remote":
      return undefined;
  }
}

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

export function extractRequestedSpecs(args: string[]): string[] {
  const specs: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--" && !positionalOnly) {
      // Everything after `--` is positional. For install commands the
      // package managers treat those tokens as package specs, so skipping
      // them would let `npm install -- evil` bypass evaluation entirely
      // while npm still installs the package.
      positionalOnly = true;
      continue;
    }

    if (positionalOnly) {
      specs.push(token);
      continue;
    }

    if (!isFlag(token)) {
      specs.push(token);
      continue;
    }

    if (token.includes("=")) {
      continue;
    }

    if (FLAGS_WITH_VALUES.has(token)) {
      index += 1;
    }
  }

  return specs;
}

function parseRequestedPackage(raw: string): RequestedPackage {
  if (
    raw.startsWith("github:") ||
    raw.startsWith("git+ssh://") ||
    raw.startsWith("git+https://") ||
    raw.startsWith("git@")
  ) {
    return {
      name: raw,
      raw,
      requested: raw,
      sourceType: "git"
    };
  }

  const parsed = raw.startsWith("workspace:")
    ? {
        name: raw.replace(/^workspace:/, ""),
        rawSpec: raw,
        type: "directory"
      }
    : npa(raw);

  const sourceType = raw.startsWith("workspace:") ? "workspace" : classifySourceType(parsed as npa.Result);
  const name = parsed.name ?? raw;
  const requested =
    raw.startsWith("workspace:")
      ? raw
      : parsed.type === "version" || parsed.type === "range" || parsed.type === "tag"
        ? parsed.rawSpec ?? "latest"
        : raw;

  return {
    name,
    raw,
    requested,
    sourceType,
    registrySpecKind: raw.startsWith("workspace:")
      ? undefined
      : classifyRegistrySpecKind(parsed as npa.Result)
  };
}

const NPM_INSTALL_ALIASES = new Set([
  "install",
  "i",
  "add",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall"
]);
const NPM_CI_ALIASES = new Set(["ci", "clean-install", "ic", "install-clean", "isntall-clean"]);

/**
 * Map a package-manager subcommand (including documented aliases like
 * `npm i` or `bun a`) to its canonical install command, or undefined when
 * the subcommand is not an install/add/ci flow SafeInstall gates.
 */
export function normalizeInstallCommand(
  manager: PackageManagerName,
  command: string
): string | undefined {
  const normalized = command.toLowerCase();

  if (manager === "npm") {
    if (NPM_INSTALL_ALIASES.has(normalized)) {
      return "install";
    }
    if (NPM_CI_ALIASES.has(normalized)) {
      return "ci";
    }
    return undefined;
  }

  // pnpm and bun: `install`/`i` resolve the whole project, `add` (and bun's
  // `a`) add new dependencies.
  if (normalized === "install" || normalized === "i") {
    return "install";
  }
  if (normalized === "add" || (manager === "bun" && normalized === "a")) {
    return "add";
  }
  return undefined;
}

function splitManagerArgsAndCommand(argv: string[]): {
  manager: PackageManagerName;
  managerArgs: string[];
  command: string;
  forwardedArgs: string[];
} {
  const [managerRaw, ...rest] = argv;
  const manager = managerRaw as PackageManagerName | undefined;

  if (!manager || (manager !== "npm" && manager !== "pnpm" && manager !== "bun")) {
    throw new Error("Usage: safeinstall <npm|pnpm|bun> <install-command> [...args]");
  }

  const preCommandArgs: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!isFlag(token)) {
      return {
        manager,
        managerArgs: preCommandArgs,
        command: token,
        forwardedArgs: rest.slice(index + 1)
      };
    }

    preCommandArgs.push(token);

    if (!token.includes("=") && FLAGS_WITH_VALUES.has(token) && rest[index + 1]) {
      preCommandArgs.push(rest[index + 1]);
      index += 1;
    }
  }

  throw new Error(`Missing command for ${manager}.`);
}

export function buildInstallPlan(argv: string[]): InstallPlan {
  const { manager, managerArgs, command, forwardedArgs } = splitManagerArgsAndCommand(argv);

  const canonicalCommand = normalizeInstallCommand(manager, command);
  if (!canonicalCommand) {
    throw new Error(`Unsupported command: ${manager} ${command}. SafeInstall supports install/add flows only.`);
  }

  const requestedSpecs = extractRequestedSpecs(forwardedArgs);
  const packages = requestedSpecs.map(parseRequestedPackage);

  return {
    manager,
    command: canonicalCommand,
    managerArgs,
    forwardedArgs,
    packages,
    projectInstall: packages.length === 0
  };
}

export function parseManifestDependency(name: string, spec: string): RequestedPackage {
  if (spec.startsWith("workspace:")) {
    return {
      name,
      raw: `${name}@${spec}`,
      requested: spec,
      sourceType: "workspace"
    };
  }

  const parsed = npa.resolve(name, spec);
  return {
    name,
    raw: `${name}@${spec}`,
    requested: parsed.rawSpec ?? spec,
    sourceType: spec.startsWith("workspace:") ? "workspace" : classifySourceType(parsed),
    registrySpecKind: spec.startsWith("workspace:") ? undefined : classifyRegistrySpecKind(parsed)
  };
}
