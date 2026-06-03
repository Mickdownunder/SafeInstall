import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { classifyResolvedSource } from "./project-installs/shared";
import type { PolicyBlockReason, SafeInstallConfig, SourceType } from "./types";

export interface TransitivePackage {
  name: string;
  version: string;
  sourceType: SourceType;
  /** undefined means the lockfile does not record install-script presence. */
  hasInstallScript: boolean | undefined;
}

export interface TransitiveEvaluation {
  blockedReasons: PolicyBlockReason[];
  warnings: string[];
  installScriptPackages: string[];
  untrustedSourcePackages: string[];
}

interface NpmLockfileTree {
  packages?: Record<
    string,
    {
      version?: string;
      resolved?: string;
      integrity?: string;
      link?: boolean;
      hasInstallScript?: boolean;
    }
  >;
}

interface PnpmLockfileTree {
  packages?: Record<
    string,
    {
      version?: string;
      resolution?: { integrity?: string; tarball?: string };
    }
  >;
}

const SOURCE_NOT_POLICY_RELEVANT: ReadonlySet<SourceType> = new Set<SourceType>([
  "workspace",
  "file",
  "directory"
]);

function isSourcePolicyRelevant(sourceType: SourceType): boolean {
  return !SOURCE_NOT_POLICY_RELEVANT.has(sourceType);
}

function extractNpmName(packageKey: string): string | undefined {
  const marker = "node_modules/";
  const index = packageKey.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }
  const name = packageKey.slice(index + marker.length);
  return name.length > 0 ? name : undefined;
}

/**
 * Parse a pnpm `packages` key into name and version. Handles both the
 * modern `name@version` form (including scoped names and peer-dependency
 * suffixes like `foo@1.0.0(bar@2.0.0)`) and the legacy `/name/version` form.
 */
export function parsePnpmPackageKey(
  packageKey: string
): { name: string; version: string } | undefined {
  const base = packageKey.replace(/\(.*\)$/, "");

  if (base.startsWith("/")) {
    const withoutLead = base.slice(1);
    const lastSlash = withoutLead.lastIndexOf("/");
    if (lastSlash === -1) {
      return undefined;
    }
    const name = withoutLead.slice(0, lastSlash);
    const version = withoutLead.slice(lastSlash + 1);
    return name && version ? { name, version } : undefined;
  }

  const atIndex = base.lastIndexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  const name = base.slice(0, atIndex);
  const version = base.slice(atIndex + 1);
  return name && version ? { name, version } : undefined;
}

function dedupe(packages: TransitivePackage[]): TransitivePackage[] {
  const seen = new Set<string>();
  const result: TransitivePackage[] = [];
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(pkg);
  }
  return result;
}

export function collectNpmTransitivePackages(
  lockfile: NpmLockfileTree,
  directNames: ReadonlySet<string>
): TransitivePackage[] {
  const packages = lockfile.packages ?? {};
  const collected: TransitivePackage[] = [];

  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || !key.includes("node_modules/") || entry.link) {
      continue;
    }
    const name = extractNpmName(key);
    if (!name || directNames.has(name)) {
      continue;
    }
    collected.push({
      name,
      version: entry.version ?? "",
      sourceType: classifyResolvedSource("registry", entry.resolved, Boolean(entry.integrity)),
      hasInstallScript: entry.hasInstallScript === true
    });
  }

  return dedupe(collected);
}

export function collectPnpmTransitivePackages(
  lockfile: PnpmLockfileTree,
  directNames: ReadonlySet<string>
): TransitivePackage[] {
  const packages = lockfile.packages ?? {};
  const collected: TransitivePackage[] = [];

  for (const [key, entry] of Object.entries(packages)) {
    const parsed = parsePnpmPackageKey(key);
    if (!parsed || directNames.has(parsed.name)) {
      continue;
    }
    const tarball = entry.resolution?.tarball;
    collected.push({
      name: parsed.name,
      version: entry.version ?? parsed.version,
      sourceType: classifyResolvedSource("registry", tarball, Boolean(entry.resolution?.integrity)),
      // pnpm lockfiles do not record install-script presence; left unknown.
      hasInstallScript: undefined
    });
  }

  return dedupe(collected);
}

function label(pkg: TransitivePackage): string {
  return pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
}

/**
 * Format a potentially long list of package labels for a single block
 * message, capping the inline list so the output stays readable while the
 * full count is still reported.
 */
function summarizeList(labels: string[], cap = 10): string {
  if (labels.length <= cap) {
    return labels.join(", ");
  }
  const shown = labels.slice(0, cap).join(", ");
  return `${shown}, and ${labels.length - cap} more`;
}

export function evaluateTransitivePackages(
  packages: TransitivePackage[],
  config: SafeInstallConfig
): TransitiveEvaluation {
  const evaluation: TransitiveEvaluation = {
    blockedReasons: [],
    warnings: [],
    installScriptPackages: [],
    untrustedSourcePackages: []
  };

  const transitiveConfig = config.transitive;
  if (transitiveConfig.mode === "off") {
    return evaluation;
  }

  const checkInstallScript = transitiveConfig.checks.includes("install-script");
  const checkUntrustedSource = transitiveConfig.checks.includes("untrusted-source");

  for (const pkg of packages) {
    if (checkInstallScript && pkg.hasInstallScript === true) {
      evaluation.installScriptPackages.push(label(pkg));
    }
    if (
      checkUntrustedSource &&
      isSourcePolicyRelevant(pkg.sourceType) &&
      !config.allowedSources.includes(pkg.sourceType)
    ) {
      evaluation.untrustedSourcePackages.push(`${label(pkg)} (${pkg.sourceType})`);
    }
  }

  const emit = (code: PolicyBlockReason["code"], message: string, suggestion: string): void => {
    if (transitiveConfig.mode === "block") {
      evaluation.blockedReasons.push({ code, message: `Blocked: ${message}`, suggestion });
    } else {
      evaluation.warnings.push(`${message} ${suggestion}`);
    }
  };

  if (evaluation.installScriptPackages.length > 0) {
    const count = evaluation.installScriptPackages.length;
    emit(
      "transitive-install-script",
      `${count} transitive ${count === 1 ? "dependency declares" : "dependencies declare"} an install script: ${summarizeList(evaluation.installScriptPackages)}.`,
      "Review these packages. Install scripts run arbitrary code at install time."
    );
  }

  if (evaluation.untrustedSourcePackages.length > 0) {
    const count = evaluation.untrustedSourcePackages.length;
    emit(
      "transitive-untrusted-source",
      `${count} transitive ${count === 1 ? "dependency resolves" : "dependencies resolve"} from an untrusted source: ${summarizeList(evaluation.untrustedSourcePackages)}.`,
      "Review these packages or add the source type to allowedSources if intentional."
    );
  }

  return evaluation;
}

function collectFromLockfile(
  lockfilePath: string,
  rawLockfile: string,
  directNames: ReadonlySet<string>
): TransitivePackage[] {
  const basename = path.basename(lockfilePath);

  if (basename === "pnpm-lock.yaml") {
    const lockfile = parseYaml(rawLockfile) as PnpmLockfileTree;
    return collectPnpmTransitivePackages(lockfile, directNames);
  }

  // package-lock.json or npm-shrinkwrap.json
  const lockfile = JSON.parse(rawLockfile) as NpmLockfileTree;
  return collectNpmTransitivePackages(lockfile, directNames);
}

/**
 * Read the project lockfile, walk the full dependency tree, and evaluate
 * transitive dependencies against the configured transitive checks.
 *
 * Returns an empty evaluation when transitive mode is off, when there is no
 * lockfile, or when the lockfile cannot be read or parsed. The parser is
 * chosen by lockfile filename (pnpm-lock.yaml vs package-lock.json /
 * npm-shrinkwrap.json); a bun binary lockfile fails JSON parsing and yields
 * an empty result. This evaluation is purely additive over the
 * direct-dependency evaluation.
 */
export async function evaluateTransitiveDependencies(options: {
  lockfilePath: string | undefined;
  directNames: ReadonlySet<string>;
  config: SafeInstallConfig;
}): Promise<TransitiveEvaluation> {
  const empty: TransitiveEvaluation = {
    blockedReasons: [],
    warnings: [],
    installScriptPackages: [],
    untrustedSourcePackages: []
  };

  if (options.config.transitive.mode === "off" || !options.lockfilePath) {
    return empty;
  }

  let rawLockfile: string;
  try {
    rawLockfile = await readFile(options.lockfilePath, "utf8");
  } catch {
    return empty;
  }

  let packages: TransitivePackage[];
  try {
    packages = collectFromLockfile(options.lockfilePath, rawLockfile, options.directNames);
  } catch {
    return empty;
  }

  return evaluateTransitivePackages(packages, options.config);
}
