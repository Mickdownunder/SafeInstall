import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { classifyResolvedSource, isHttpUrl } from "./project-installs/shared";
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
  lockfileVersion?: string | number;
  packages?: Record<
    string,
    {
      version?: string;
      resolution?: {
        integrity?: string;
        tarball?: string;
        /** `git` and `directory` resolutions carry no tarball. */
        type?: string;
        repo?: string;
        commit?: string;
        directory?: string;
      };
    }
  >;
}

const SUPPORTED_TRANSITIVE_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml"
]);

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
 * The name and the separator that follows it in a key with a leading slash:
 * `@` in lockfile v6 (`/name@1.0.0`), `/` in v5 (`/name/1.0.0`). The name
 * ends at the first of the two after the scope, so a v5 peer context such as
 * `_react@18.0.0` is never taken for the separator.
 */
const LEADING_SLASH_KEY = /^(@[^/@]+\/[^/@]+|[^/@]+)[/@](.+)$/;

/**
 * Parse a pnpm `packages` key into name and version. Handles the
 * `name@version` form of lockfile v9 (including scoped names and
 * peer-dependency suffixes like `foo@1.0.0(bar@2.0.0)`), `/name@version` of
 * v6 and `/name/version` of v5.
 */
export function parsePnpmPackageKey(
  packageKey: string
): { name: string; version: string } | undefined {
  const base = packageKey.replace(/\(.*\)$/, "");

  if (base.startsWith("/")) {
    const match = LEADING_SLASH_KEY.exec(base.slice(1));
    return match?.[1] && match[2] ? { name: match[1], version: match[2] } : undefined;
  }

  const atIndex = base.lastIndexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  const name = base.slice(0, atIndex);
  const version = base.slice(atIndex + 1);
  return name && version ? { name, version } : undefined;
}

/** Drop the peer-dependency context from a pnpm package key (`(peer)` in v6+, `_peer` in v5). */
function stripPnpmPeerSuffix(packageKey: string): string {
  const base = packageKey.replace(/\(.*\)$/, "");
  if (base.startsWith("/")) {
    const slash = base.lastIndexOf("/");
    const underscore = base.indexOf("_", slash);
    return underscore === -1 ? base : base.slice(0, underscore);
  }
  return base;
}

/**
 * Collapse records that policy cannot tell apart. A package name and version
 * do not identify a lockfile record: two records can share both and still
 * resolve from different sources, so the key carries every fact the checks
 * below read. Collapsing by name and version alone would let a record from an
 * untrusted source hide behind an earlier registry record.
 */
function dedupe(packages: TransitivePackage[]): TransitivePackage[] {
  const seen = new Set<string>();
  const result: TransitivePackage[] = [];
  for (const pkg of packages) {
    const key = JSON.stringify([pkg.name, pkg.version, pkg.sourceType, pkg.hasInstallScript ?? null]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(pkg);
  }
  return result;
}

/**
 * The source of a transitive lockfile record. A record from the registry has
 * no resolved reference (pnpm) or an HTTP(S) one (npm, pnpm tarballs). A
 * reference in any other form that the classifier still left at "registry"
 * (`evil/x`, `github:evil/x`) is a spelling it does not know, and an unknown
 * source is not the registry.
 */
function transitiveSourceType(reference: string | undefined, registryUrl: string | undefined): SourceType {
  const sourceType = classifyResolvedSource("registry", reference, undefined, registryUrl);
  return sourceType === "registry" && reference !== undefined && !isHttpUrl(reference) ? "unknown" : sourceType;
}

export function collectNpmTransitivePackages(
  lockfile: NpmLockfileTree,
  directLockfileKeys: ReadonlySet<string>,
  registryUrl?: string
): TransitivePackage[] {
  const packages = lockfile.packages ?? {};
  const collected: TransitivePackage[] = [];

  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || !key.includes("node_modules/") || entry.link) {
      continue;
    }
    const name = extractNpmName(key);
    // A package name is not a node identity: only the selected direct key is
    // exempt, while nested same-name instances remain subject to policy.
    if (!name || directLockfileKeys.has(key)) {
      continue;
    }
    collected.push({
      name,
      version: entry.version ?? "",
      // Lockfile integrity only binds bytes to the lockfile author's value;
      // unlike direct targets, transitive entries are not compared with a
      // freshly checked registry manifest here.
      sourceType: transitiveSourceType(entry.resolved, registryUrl),
      hasInstallScript: entry.hasInstallScript === true
    });
  }

  return dedupe(collected);
}

export function collectPnpmTransitivePackages(
  lockfile: PnpmLockfileTree,
  directLockfileKeys: ReadonlySet<string>,
  registryUrl?: string
): TransitivePackage[] {
  const packages = lockfile.packages ?? {};
  const collected: TransitivePackage[] = [];
  const directKeys = new Set([...directLockfileKeys].map(stripPnpmPeerSuffix));

  for (const [key, entry] of Object.entries(packages)) {
    const parsed = parsePnpmPackageKey(key);
    // A direct package exempts its resolved package record (including every
    // peer-context variant of it), not every record that parses to the same
    // name.
    if (!parsed || directKeys.has(stripPnpmPeerSuffix(key))) {
      continue;
    }
    const resolution = entry.resolution;
    collected.push({
      name: parsed.name,
      version: entry.version ?? parsed.version,
      // A git or directory resolution has no tarball, and without one the
      // record would read as a registry package.
      sourceType:
        resolution?.type === "git"
          ? "git"
          : resolution?.type === "directory"
            ? "directory"
            : transitiveSourceType(resolution?.tarball, registryUrl),
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
  // The source of a lockfile entry decides what the package manager downloads,
  // so allowedSources applies to every entry and always blocks: a lockfile
  // line that points a transitive dependency at another host or a git
  // repository must not depend on an opt-in mode to be noticed.
  // transitive.mode governs only the install-script check and how an
  // unreadable lockfile is treated.
  const checkInstallScript =
    transitiveConfig.mode !== "off" && transitiveConfig.checks.includes("install-script");

  for (const pkg of packages) {
    if (checkInstallScript && pkg.hasInstallScript === true) {
      evaluation.installScriptPackages.push(label(pkg));
    }
    // Lockfile entries that are `link:` references (every workspace member in
    // a pnpm lockfile) are first-party directories, not supply-chain sources,
    // and are never flagged. Local tarballs ("file") are unverifiable artifacts
    // and are checked against allowedSources like any other source.
    if (
      pkg.sourceType !== "workspace" &&
      pkg.sourceType !== "directory" &&
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
    evaluation.blockedReasons.push({
      code: "transitive-untrusted-source",
      message: `Blocked: ${count} transitive ${count === 1 ? "dependency resolves" : "dependencies resolve"} from an untrusted source: ${summarizeList(evaluation.untrustedSourcePackages)}.`,
      suggestion: "Review these lockfile entries or add the source type to allowedSources if intentional."
    });
  }

  return evaluation;
}

function collectFromLockfile(
  lockfilePath: string,
  rawLockfile: string,
  directLockfileKeys: ReadonlySet<string>,
  registryUrl?: string
): TransitivePackage[] {
  const basename = path.basename(lockfilePath);

  if (basename === "pnpm-lock.yaml") {
    const lockfile = parseYaml(rawLockfile) as unknown;
    if (
      !isRecord(lockfile) ||
      !isSupportedPnpmLockfileVersion(lockfile.lockfileVersion) ||
      (lockfile.packages !== undefined && !isRecord(lockfile.packages))
    ) {
      throw new Error("Unsupported pnpm lockfile structure.");
    }
    return collectPnpmTransitivePackages(lockfile as PnpmLockfileTree, directLockfileKeys, registryUrl);
  }

  if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") {
    const lockfile = JSON.parse(rawLockfile) as unknown;
    if (
      !isRecord(lockfile) ||
      (lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) ||
      !isRecord(lockfile.packages)
    ) {
      throw new Error("Unsupported npm lockfile structure.");
    }
    return collectNpmTransitivePackages(lockfile as NpmLockfileTree, directLockfileKeys, registryUrl);
  }

  throw new Error(`Unsupported lockfile: ${basename}`);
}

/**
 * pnpm lockfile majors whose `packages` keys `parsePnpmPackageKey` understands
 * (`/name/version` in 5, `/name@version` in 6, `name@version` in 9). A newer
 * major may rename the section, which would read as "no transitive packages".
 */
function isSupportedPnpmLockfileVersion(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }
  const major = Number.parseInt(String(value), 10);
  return major >= 5 && major <= 9;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailableEvaluation(
  config: SafeInstallConfig,
  message: string,
  suggestion: string
): TransitiveEvaluation {
  const evaluation: TransitiveEvaluation = {
    blockedReasons: [],
    warnings: [],
    installScriptPackages: [],
    untrustedSourcePackages: []
  };

  if (config.transitive.mode === "block") {
    evaluation.blockedReasons.push({
      code: "transitive-evaluation-unavailable",
      message: `Blocked: ${message}`,
      suggestion
    });
  } else if (config.transitive.mode === "warn") {
    evaluation.warnings.push(`${message} ${suggestion}`);
  }

  return evaluation;
}

/**
 * Read the project lockfile, walk the full dependency tree, and evaluate
 * transitive dependencies against the configured transitive checks.
 *
 * The source of every lockfile entry is checked against allowedSources in
 * every mode. Missing, unreadable, unsupported, and invalid lockfiles block in
 * block mode, produce an explicit warning in warn mode, and are not an error
 * with mode off, where there is simply nothing to check. This evaluation is
 * purely additive over the direct-dependency evaluation.
 */
export async function evaluateTransitiveDependencies(options: {
  lockfilePath: string | undefined;
  directLockfileKeys: ReadonlySet<string>;
  config: SafeInstallConfig;
}): Promise<TransitiveEvaluation> {
  const empty: TransitiveEvaluation = {
    blockedReasons: [],
    warnings: [],
    installScriptPackages: [],
    untrustedSourcePackages: []
  };

  // With mode "off" a lockfile that is absent or cannot be read is not an
  // error: there is nothing to check the sources of. A readable lockfile is
  // still checked against allowedSources below.
  const sourcesOnly = options.config.transitive.mode === "off";

  const unavailableSuggestion =
    "Create or repair package-lock.json, npm-shrinkwrap.json, or pnpm-lock.yaml before retrying.";

  if (!options.lockfilePath) {
    if (sourcesOnly) return empty;
    return unavailableEvaluation(
      options.config,
      "Transitive dependencies could not be evaluated because no npm or pnpm lockfile was found (yarn and bun lockfiles are not supported).",
      unavailableSuggestion
    );
  }

  const lockfileName = path.basename(options.lockfilePath);
  if (!SUPPORTED_TRANSITIVE_LOCKFILES.has(lockfileName)) {
    if (sourcesOnly) return empty;
    return unavailableEvaluation(
      options.config,
      `Transitive dependencies could not be evaluated because ${lockfileName} is not a supported lockfile.`,
      unavailableSuggestion
    );
  }

  let rawLockfile: string;
  try {
    rawLockfile = await readFile(options.lockfilePath, "utf8");
  } catch {
    if (sourcesOnly) return empty;
    return unavailableEvaluation(
      options.config,
      `Transitive dependencies could not be evaluated because ${lockfileName} could not be read.`,
      unavailableSuggestion
    );
  }

  let packages: TransitivePackage[];
  try {
    packages = collectFromLockfile(
      options.lockfilePath,
      rawLockfile,
      options.directLockfileKeys,
      options.config.registryUrl
    );
  } catch {
    if (sourcesOnly) return empty;
    return unavailableEvaluation(
      options.config,
      `Transitive dependencies could not be evaluated because ${lockfileName} is invalid or unsupported.`,
      unavailableSuggestion
    );
  }

  return evaluateTransitivePackages(packages, options.config);
}
