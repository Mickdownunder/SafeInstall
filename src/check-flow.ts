import { loadConfig } from "./config";
import { evaluateRequestedPackages } from "./evaluations";
import { formatCommand } from "./output";
import { loadManifestDependencies } from "./project-state";
import { resolveInvocationContext } from "./project-discovery";
import { inferProjectInstallTargetsForCheck } from "./project-installs";
import { RegistryClient } from "./registry";
import { throwIfAborted } from "./signals";
import { parseManifestDependency } from "./specs";
import { evaluateTransitiveDependencies } from "./transitive";
import type { CliReason, CliResult, PackageEvaluation } from "./types";

function configLabel(configPath?: string): string {
  return configPath ?? "built-in defaults";
}

function createProjectIssueReason(message: string): CliReason {
  if (message.includes("both pnpm-lock.yaml and an npm lockfile exist")) {
    return {
      code: "ambiguous-lockfiles",
      message,
      suggestion: "Set packageManager in package.json or remove the stale lockfile so SafeInstall can choose one source of truth."
    };
  }

  if (message.includes("required for safeinstall")) {
    return {
      code: "lockfile-required",
      message,
      suggestion: "Create or refresh the lockfile before relying on SafeInstall for project-level checks."
    };
  }

  if (message.includes("specifier")) {
    return {
      code: "lockfile-specifier-mismatch",
      message,
      suggestion: "Regenerate the lockfile so package.json and the lockfile match."
    };
  }

  return {
    code: "check-blocked",
    message,
    suggestion: "Fix the project metadata inconsistency and run safeinstall check again."
  };
}

function createAffectedPackage(evaluation: PackageEvaluation) {
  return {
    name: evaluation.requested.name,
    requested: evaluation.requested.raw,
    sourceType: evaluation.requested.sourceType,
    resolvedVersion: evaluation.resolvedRegistryPackage?.resolvedVersion,
    reasons: evaluation.blockedReasons,
    warnings: evaluation.warnings,
    infos: evaluation.infos
  };
}

export async function runCheckFlow(
  cwd: string,
  argv: string[],
  options: { signal?: AbortSignal; configPath?: string } = {}
): Promise<CliResult> {
  throwIfAborted(options.signal);

  const invocation = await resolveInvocationContext(cwd, []);
  const { config, path } = await loadConfig(invocation.effectiveCwd, options.configPath);
  const projectTargets = await inferProjectInstallTargetsForCheck(
    invocation.effectiveCwd,
    invocation.packageDir
  );
  const commandString = formatCommand("safeinstall", argv);

  if (!invocation.packageDir) {
    return {
      mode: "check",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Check was blocked because the current directory does not map to a package.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      reasons: [
        {
          code: "package-root-not-found",
          message: "Check blocked: the current directory does not map to a package.json-backed project.",
          suggestion: "Run SafeInstall from a package directory."
        }
      ],
      summary: "Check blocked.",
      warnings: [],
      infos: [],
      affectedPackages: []
    };
  }

  if (projectTargets?.issues.length) {
    return {
      mode: "check",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Check was blocked because project metadata was incomplete or inconsistent.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      reasons: projectTargets.issues.map(createProjectIssueReason),
      summary: "Check blocked.",
      warnings: [],
      infos: [],
      affectedPackages: []
    };
  }

  const requestedPackages = projectTargets
    ? projectTargets.targets.map((target) => target.requested)
    : Object.entries(await loadManifestDependencies(invocation.packageDir ?? invocation.effectiveCwd)).map(([name, spec]) =>
        parseManifestDependency(name, spec)
      );

  if (requestedPackages.length === 0) {
    return {
      mode: "check",
      decision: "allow",
      exitCode: 0,
      exitCodeMeaning: "Check passed; there were no direct dependencies to evaluate.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      reasons: [],
      summary: "Check skipped: package.json has no direct dependencies.",
      warnings: [],
      infos: [],
      affectedPackages: []
    };
  }

  const registryClient = new RegistryClient({
    registryUrl: config.registryUrl,
    signal: options.signal
  });
  const evaluations = await evaluateRequestedPackages(
    invocation.packageDir ?? invocation.effectiveCwd,
    requestedPackages,
    registryClient,
    config,
    options.signal
  );
  const transitive = await evaluateTransitiveDependencies({
    lockfilePath: projectTargets?.lockfilePath,
    directNames: new Set(requestedPackages.map((requested) => requested.name)),
    config
  });

  const blocked = evaluations.filter((evaluation) => evaluation.blockedReasons.length > 0);
  const warnings = [...evaluations.flatMap((evaluation) => evaluation.warnings), ...transitive.warnings];
  const infos = evaluations.flatMap((evaluation) => evaluation.infos);
  const directBlockReasons = blocked.flatMap((evaluation) => evaluation.blockedReasons);
  const allBlockReasons = [...directBlockReasons, ...transitive.blockedReasons];

  if (allBlockReasons.length > 0) {
    return {
      mode: "check",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Check found dependencies that violate the current policy.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      reasons: allBlockReasons,
      summary: "Check blocked.",
      warnings,
      infos,
      affectedPackages: blocked.map(createAffectedPackage)
    };
  }

  return {
    mode: "check",
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "Check passed with no direct dependency policy violations.",
    command: argv,
    commandString,
    configPath: path,
    configLabel: configLabel(path),
    reasons: [],
    summary: "Check passed: no direct dependency policy violations found.",
    warnings,
    infos,
    affectedPackages: requestedPackages.map((requested) => ({
      name: requested.name,
      requested: requested.raw,
      sourceType: requested.sourceType,
      reasons: [],
      warnings: [],
      infos: []
    }))
  };
}
