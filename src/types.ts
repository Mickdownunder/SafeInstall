export type PackageManagerName = "npm" | "pnpm" | "bun";

export type InstallLifecycleScriptName = "preinstall" | "install" | "postinstall";

export type SourceType =
  | "registry"
  | "git"
  | "tarball"
  | "url"
  | "file"
  | "directory"
  | "workspace"
  | "unknown";

export interface PackageManagerDefaults {
  ignoreScripts: boolean;
}

export type TypoSquatMode = "off" | "warn" | "block";

export interface TypoSquatConfig {
  mode: TypoSquatMode;
  minNameLength: number;
  ignore: string[];
}

export type ProvenanceMode = "off" | "warn" | "require";

export type TrustedPublisherPattern = string;

export interface ProvenanceConfig {
  mode: ProvenanceMode;
  requireFor: string[];
  trustedPublishers: Record<string, TrustedPublisherPattern>;
  offlineBehavior: "fail-closed" | "allow-cached";
  /**
   * What to do when the sigstore verifier itself is not installed, so no
   * package's provenance can be checked at all. "warn" (default) degrades to a
   * loud warning — provenance is simply not enforced this run. "fail-closed"
   * treats a missing verifier as suspicious and blocks every install; the
   * sigstore bootstrap install is always exempt, since it cannot verify itself.
   */
  toolingUnavailable: "warn" | "fail-closed";
}

export type ProvenanceVerificationStatus =
  | "verified"
  | "missing"
  | "invalid"
  | "unreachable"
  | "tooling-unavailable";

export interface ProvenanceVerificationResult {
  status: ProvenanceVerificationStatus;
  sourceRepository?: string;
  sourceRef?: string | undefined;
  workflowPath?: string | undefined;
  builderId?: string | undefined;
  error?: string;
}

export type TransitiveMode = "off" | "warn" | "block";

export type TransitiveCheck = "install-script" | "untrusted-source";

export interface TransitiveConfig {
  mode: TransitiveMode;
  checks: TransitiveCheck[];
}

export type ContinuityMode = "off" | "warn" | "block";

export interface ContinuityConfig {
  mode: ContinuityMode;
  baselineSize: number;
}

export type ContinuityStatus =
  | "consistent"
  | "provenance-downgrade"
  | "identity-discontinuity"
  | "no-baseline"
  | "unevaluated";

export interface ContinuityResult {
  status: ContinuityStatus;
  sampledVersions?: number;
  baselineProvenanceRate?: number;
  baselineRepository?: string | undefined;
  targetHasProvenance?: boolean;
  targetRepository?: string | undefined;
  error?: string;
}

export interface SafeInstallConfig {
  /**
   * Lowest safeinstall-cli version whose behavior this project's protections
   * assume (exact semver, e.g. "0.12.0"). An older running CLI warns — never
   * hard-fails — in the guard, install/check, and trust-status flows. Absent
   * from the default config: it only makes sense as an explicit project claim.
   */
  minimumCliVersion?: string;
  minimumReleaseAgeHours: number;
  registryUrl: string;
  allowedScripts: Record<string, InstallLifecycleScriptName[]>;
  allowedSources: SourceType[];
  allowedPackages: string[];
  packageManagerDefaults: Record<PackageManagerName, PackageManagerDefaults>;
  typoSquat: TypoSquatConfig;
  provenance: ProvenanceConfig;
  transitive: TransitiveConfig;
  continuity: ContinuityConfig;
}

export interface RequestedPackage {
  name: string;
  raw: string;
  requested: string;
  sourceType: SourceType;
  registrySpecKind?: "tag" | "version" | "range" | undefined;
}

export interface ProjectInstallResolution {
  requested: RequestedPackage;
  manifestSpec: string;
  lockfilePath?: string;
}

export interface ProjectDependencyState {
  declaredSpec?: string | undefined;
  declaredSourceType?: SourceType | undefined;
  installedVersion?: string | undefined;
}

/**
 * Where a package's publish time was observed (RFC-001 §14 D7). The registry
 * document's `time` map is the authoritative record; the tarball
 * `last-modified` header is a mutable CDN artifact and only a fallback —
 * release-age decisions resting on the fallback must be able to say so.
 */
export type PublishTimeSource = "registry-time" | "tarball-last-modified";

export interface ResolvedRegistryPackage {
  requested: RequestedPackage;
  resolvedVersion: string;
  publishedAt: Date;
  publishTimeSource: PublishTimeSource;
  lifecycleScripts: InstallLifecycleScriptName[];
}

export interface PackageEvaluation {
  requested: RequestedPackage;
  priorState?: ProjectDependencyState | undefined;
  resolvedRegistryPackage?: ResolvedRegistryPackage | undefined;
  blockedReasons: PolicyBlockReason[];
  warnings: string[];
  infos: string[];
  /**
   * The GitHub `owner/repo` slug the installed version was published from,
   * derived from Sigstore provenance or the continuity baseline when
   * available. Undefined for packages without usable attestation data.
   */
  sourceRepository?: string | undefined;
}

export type PolicyBlockCode =
  | "release-too-new"
  | "install-script-present"
  | "untrusted-source"
  | "trust-level-dropped"
  | "typo-squat-suspected"
  | "attestation-missing"
  | "attestation-invalid"
  | "attestation-unreachable"
  | "attestation-tooling-unavailable"
  | "publisher-mismatch"
  | "package-resolution-failed"
  | "transitive-install-script"
  | "transitive-untrusted-source"
  | "provenance-downgrade"
  | "identity-discontinuity";

export interface PolicyBlockReason {
  code: PolicyBlockCode;
  message: string;
  suggestion?: string;
}

export interface InstallPlan {
  manager: PackageManagerName;
  command: string;
  managerArgs: string[];
  forwardedArgs: string[];
  packages: RequestedPackage[];
  projectInstall: boolean;
}

export type CliDecision = "allow" | "block" | "error";

export interface CliReason {
  code: string;
  message: string;
  suggestion?: string;
}

export interface CliAffectedPackage {
  name: string;
  requested: string;
  sourceType: SourceType;
  resolvedVersion?: string | undefined;
  reasons: CliReason[];
  warnings: string[];
  infos: string[];
}

export interface CliExecutionInfo {
  ranPackageManager: boolean;
  packageManagerExitCode?: number;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

export interface CliResult {
  command: string[];
  commandString: string;
  configPath?: string | undefined;
  configLabel?: string;
  decision: CliDecision;
  exitCode: number;
  exitCodeMeaning: string;
  mode: "install" | "check" | "init" | "guard" | "trust" | "decisions";
  packageManager?: PackageManagerName;
  reasons: CliReason[];
  summary: string;
  warnings: string[];
  infos: string[];
  affectedPackages: CliAffectedPackage[];
  execution?: CliExecutionInfo;
  details?: Record<string, unknown> | undefined;
}
