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

export interface SafeInstallConfig {
  minimumReleaseAgeHours: number;
  registryUrl: string;
  allowedScripts: Record<string, InstallLifecycleScriptName[]>;
  allowedSources: SourceType[];
  allowedPackages: string[];
  ciMode: boolean;
  packageManagerDefaults: Record<PackageManagerName, PackageManagerDefaults>;
}

export interface RequestedPackage {
  name: string;
  raw: string;
  requested: string;
  sourceType: SourceType;
  registrySpecKind?: "tag" | "version" | "range";
}

export interface ProjectInstallResolution {
  requested: RequestedPackage;
  manifestSpec: string;
  lockfilePath?: string;
}

export interface ProjectDependencyState {
  declaredSpec?: string;
  declaredSourceType?: SourceType;
  installedVersion?: string;
}

export interface ResolvedRegistryPackage {
  requested: RequestedPackage;
  resolvedVersion: string;
  publishedAt: Date;
  lifecycleScripts: InstallLifecycleScriptName[];
}

export interface PackageEvaluation {
  requested: RequestedPackage;
  priorState?: ProjectDependencyState;
  resolvedRegistryPackage?: ResolvedRegistryPackage;
  blockedReasons: PolicyBlockReason[];
  warnings: string[];
}

export type PolicyBlockCode =
  | "release-too-new"
  | "install-script-present"
  | "untrusted-source"
  | "trust-level-dropped";

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
  resolvedVersion?: string;
  reasons: CliReason[];
  warnings: string[];
}

export interface CliExecutionInfo {
  ranPackageManager: boolean;
  packageManagerExitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface CliResult {
  command: string[];
  commandString: string;
  configPath?: string;
  configLabel?: string;
  decision: CliDecision;
  exitCode: number;
  exitCodeMeaning: string;
  mode: "install" | "check" | "init";
  packageManager?: PackageManagerName;
  reasons: CliReason[];
  summary: string;
  warnings: string[];
  affectedPackages: CliAffectedPackage[];
  execution?: CliExecutionInfo;
  details?: Record<string, unknown>;
}
