import type {
  InstallLifecycleScriptName,
  PackageEvaluation,
  ProjectDependencyState,
  RequestedPackage,
  ResolvedRegistryPackage,
  SafeInstallConfig
} from "./types";

function isPackageAllowlisted(config: SafeInstallConfig, packageName: string): boolean {
  return config.allowedPackages.includes(packageName);
}

function isSourcePolicyRelevant(sourceType: RequestedPackage["sourceType"]): boolean {
  return sourceType !== "workspace" && sourceType !== "file" && sourceType !== "directory";
}

function allowedLifecycleScripts(
  config: SafeInstallConfig,
  packageName: string
): InstallLifecycleScriptName[] {
  return config.allowedScripts[packageName] ?? [];
}

function hasUnallowedLifecycleScripts(
  config: SafeInstallConfig,
  packageName: string,
  scripts: InstallLifecycleScriptName[]
): boolean {
  const allowed = new Set(allowedLifecycleScripts(config, packageName));
  return scripts.some((script) => !allowed.has(script));
}

function releaseAgeHours(now: Date, publishedAt: Date): number {
  return (now.getTime() - publishedAt.getTime()) / 1000 / 60 / 60;
}

function formatHours(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export interface EvaluatePackageInput {
  config: SafeInstallConfig;
  requested: RequestedPackage;
  now: Date;
  priorState?: ProjectDependencyState;
  resolvedRegistryPackage?: ResolvedRegistryPackage;
  priorLifecycleScripts?: InstallLifecycleScriptName[];
}

export function evaluatePackage(input: EvaluatePackageInput): PackageEvaluation {
  const evaluation: PackageEvaluation = {
    requested: input.requested,
    priorState: input.priorState,
    resolvedRegistryPackage: input.resolvedRegistryPackage,
    blockedReasons: [],
    warnings: []
  };

  if (isPackageAllowlisted(input.config, input.requested.name)) {
    evaluation.warnings.push(`Package ${input.requested.name} is allowlisted; policy checks were skipped.`);
    return evaluation;
  }

  if (
    isSourcePolicyRelevant(input.requested.sourceType) &&
    !input.config.allowedSources.includes(input.requested.sourceType)
  ) {
    evaluation.blockedReasons.push({
      code: "untrusted-source",
      message: `Blocked: untrusted source (${input.requested.sourceType}).`,
      suggestion: "Use a registry release or allow this source intentionally."
    });
  }

  const priorSourceType = input.priorState?.declaredSourceType;
  if (
    priorSourceType === "registry" &&
    (input.requested.sourceType === "git" ||
      input.requested.sourceType === "url" ||
      input.requested.sourceType === "tarball")
  ) {
    evaluation.blockedReasons.push({
      code: "trust-level-dropped",
      message: `Blocked: trust level dropped (${input.requested.name} changed from registry to ${input.requested.sourceType}).`,
      suggestion: "Keep this package on a registry release or allow the source change intentionally."
    });
  }

  if (!input.resolvedRegistryPackage) {
    return evaluation;
  }

  const ageHours = releaseAgeHours(input.now, input.resolvedRegistryPackage.publishedAt);
  if (ageHours < input.config.minimumReleaseAgeHours) {
    evaluation.blockedReasons.push({
      code: "release-too-new",
      message: `Blocked: release too new (${input.requested.name}@${input.resolvedRegistryPackage.resolvedVersion} is ${formatHours(ageHours)} hours old; minimum is ${input.config.minimumReleaseAgeHours} hours).`,
      suggestion: "Retry later or lower minimumReleaseAgeHours if this package is intentionally urgent."
    });
  }

  if (
    input.resolvedRegistryPackage.lifecycleScripts.length > 0 &&
    hasUnallowedLifecycleScripts(
      input.config,
      input.requested.name,
      input.resolvedRegistryPackage.lifecycleScripts
    )
  ) {
    evaluation.blockedReasons.push({
      code: "install-script-present",
      message: `Blocked: install script present (${input.requested.name}@${input.resolvedRegistryPackage.resolvedVersion} has ${input.resolvedRegistryPackage.lifecycleScripts.join(", ")}).`,
      suggestion: "Allow this package explicitly in allowedScripts if you trust its install hooks."
    });
  }

  const priorHadLifecycleScripts = (input.priorLifecycleScripts ?? []).length > 0;
  const currentHasLifecycleScripts = input.resolvedRegistryPackage.lifecycleScripts.length > 0;

  if (!priorHadLifecycleScripts && currentHasLifecycleScripts && input.priorState?.installedVersion) {
    evaluation.blockedReasons.push({
      code: "trust-level-dropped",
      message: `Blocked: trust level dropped (${input.requested.name} introduces lifecycle scripts in ${input.resolvedRegistryPackage.resolvedVersion}; installed ${input.priorState.installedVersion} had none).`,
      suggestion: "Review the new version carefully and allow the script only if you intend to trust it."
    });
  }

  return evaluation;
}
