import { loadConfig } from "./config";
import { evaluateRequestedPackages } from "./evaluations";
import { formatCommand, printConfigInfo, printWarnings } from "./output";
import { runPackageManager } from "./package-managers";
import { loadManifestDependencies } from "./project-state";
import { hasAmbiguousWorkspaceFlags, resolveInvocationContext } from "./project-discovery";
import { loadProjectInstallTargetsForManager } from "./project-installs";
import { RegistryClient } from "./registry";
import { throwIfAborted } from "./signals";
import { buildInstallPlan, parseManifestDependency } from "./specs";
import { evaluateTransitiveDependencies } from "./transitive";
import type { CliReason, CliResult, PackageEvaluation } from "./types";

export interface InstallFlowOptions {
  jsonMode: boolean;
  signal?: AbortSignal;
  configPath?: string;
}

function configLabel(configPath?: string): string {
  return configPath ?? "built-in defaults";
}

function createProjectIssueReason(message: string): CliReason {
  if (message.includes("declares") && message.includes("as packageManager")) {
    return {
      code: "package-manager-mismatch",
      message,
      suggestion: "Run SafeInstall with the declared package manager or update package.json intentionally."
    };
  }

  if (message.includes("required for safeinstall")) {
    return {
      code: "lockfile-required",
      message,
      suggestion: "Create or refresh the lockfile before retrying the project install."
    };
  }

  if (message.includes("missing from pnpm-lock.yaml") || message.includes("missing from package-lock.json")) {
    return {
      code: "lockfile-missing-entry",
      message,
      suggestion: "Refresh the lockfile so it contains every direct dependency declared in package.json."
    };
  }

  if (message.includes("specifier")) {
    return {
      code: "lockfile-specifier-mismatch",
      message,
      suggestion: "Regenerate the lockfile so package.json and the lockfile agree before installing."
    };
  }

  return {
    code: "project-install-blocked",
    message,
    suggestion: "Fix the lockfile inconsistency before retrying."
  };
}

async function collectTargetPackages(
  packageDir: string,
  effectiveCwd: string,
  argv: string[]
): Promise<{
  issues: CliReason[];
  plan: ReturnType<typeof buildInstallPlan>;
  lockfilePath?: string;
}> {
  const plan = buildInstallPlan(argv);
  if (!plan.projectInstall) {
    return { issues: [], plan };
  }

  const lockfileResult = await loadProjectInstallTargetsForManager(effectiveCwd, packageDir, plan.manager);
  if (lockfileResult) {
    if (lockfileResult.issues.length > 0) {
      return {
        issues: lockfileResult.issues.map(createProjectIssueReason),
        plan,
        lockfilePath: lockfileResult.lockfilePath
      };
    }

    return {
      issues: [],
      plan: {
        ...plan,
        packages: lockfileResult.targets.map((target) => target.requested)
      },
      lockfilePath: lockfileResult.lockfilePath
    };
  }

  const manifestDependencies = await loadManifestDependencies(packageDir);
  const packages = Object.entries(manifestDependencies).map(([name, spec]) =>
    parseManifestDependency(name, spec)
  );

  return {
    issues: [],
    plan: {
      ...plan,
      packages
    }
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

export async function runInstallFlow(
  cwd: string,
  argv: string[],
  options: InstallFlowOptions
): Promise<CliResult> {
  throwIfAborted(options.signal);

  const rawPlan = buildInstallPlan(argv);
  const invocation = await resolveInvocationContext(cwd, [...rawPlan.managerArgs, ...rawPlan.forwardedArgs]);
  const { config, path } = await loadConfig(invocation.effectiveCwd, options.configPath);
  const commandString = formatCommand("safeinstall", argv);

  if (hasAmbiguousWorkspaceFlags(rawPlan.manager, [...rawPlan.managerArgs, ...rawPlan.forwardedArgs])) {
    return {
      mode: "install",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Install was blocked because the target workspace is ambiguous.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: rawPlan.manager,
      reasons: [
        {
          code: "ambiguous-workspace-target",
          message: "Install blocked: workspace-targeting flags are ambiguous for SafeInstall in this command.",
          suggestion: "Run SafeInstall from the target package directory or use -C/--prefix to point at one package."
        }
      ],
      summary: "Install blocked.",
      warnings: [],
      infos: [],
      affectedPackages: [],
      execution: {
        ranPackageManager: false
      }
    };
  }

  if (!invocation.packageDir && rawPlan.projectInstall) {
    return {
      mode: "install",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Install was blocked because the current directory does not map to a package.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: rawPlan.manager,
      reasons: [
        {
          code: "package-root-not-found",
          message: "Install blocked: the current directory does not map to a package.json-backed project.",
          suggestion: "Run SafeInstall from a package directory or use -C/--prefix to target one package."
        }
      ],
      summary: "Install blocked.",
      warnings: [],
      infos: [],
      affectedPackages: [],
      execution: {
        ranPackageManager: false
      }
    };
  }

  const { issues, plan, lockfilePath } = await collectTargetPackages(
    invocation.packageDir ?? invocation.effectiveCwd,
    invocation.effectiveCwd,
    argv
  );

  if (issues.length > 0) {
    return {
      mode: "install",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Install was blocked by policy before the package manager ran.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: plan.manager,
      reasons: issues,
      summary: "Install blocked.",
      warnings: [],
      infos: [],
      affectedPackages: [],
      execution: {
        ranPackageManager: false
      }
    };
  }

  if (plan.packages.length === 0) {
    return {
      mode: "install",
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "SafeInstall could not determine what to install.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: plan.manager,
      reasons: [
        {
          code: "nothing-to-install",
          message: "Nothing to install: no package arguments were provided and package.json has no dependencies."
        }
      ],
      summary: "Install failed: no packages found.",
      warnings: [],
      infos: [],
      affectedPackages: [],
      execution: {
        ranPackageManager: false
      }
    };
  }

  const registryClient = new RegistryClient({
    registryUrl: config.registryUrl,
    signal: options.signal
  });
  const evaluations = await evaluateRequestedPackages(
    invocation.packageDir ?? invocation.effectiveCwd,
    plan.packages,
    registryClient,
    config,
    options.signal
  );
  const transitive = await evaluateTransitiveDependencies({
    lockfilePath,
    directNames: new Set(plan.packages.map((requested) => requested.name)),
    config
  });

  const blocked = evaluations.filter((evaluation) => evaluation.blockedReasons.length > 0);
  const warnings = [...evaluations.flatMap((evaluation) => evaluation.warnings), ...transitive.warnings];
  const infos = evaluations.flatMap((evaluation) => evaluation.infos);
  const directBlockReasons = blocked.flatMap((evaluation) => evaluation.blockedReasons);
  const allBlockReasons = [...directBlockReasons, ...transitive.blockedReasons];

  if (allBlockReasons.length > 0) {
    return {
      mode: "install",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Install was blocked by policy before the package manager ran.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: plan.manager,
      reasons: allBlockReasons,
      summary: "Install blocked.",
      warnings,
      infos,
      affectedPackages: blocked.map(createAffectedPackage),
      execution: {
        ranPackageManager: false
      }
    };
  }

  if (!options.jsonMode) {
    printConfigInfo(path);
    printWarnings(evaluations);
    console.error("Allowed: policy checks passed.");
  }

  throwIfAborted(options.signal);

  const execution = await runPackageManager({
    manager: plan.manager,
    managerArgs: plan.managerArgs,
    command: plan.command,
    forwardedArgs: plan.forwardedArgs,
    config,
    cwd,
    signal: options.signal,
    stdio: options.jsonMode ? "pipe" : "inherit"
  });

  return {
    mode: "install",
    decision: "allow",
    exitCode: execution.code,
    exitCodeMeaning:
      execution.code === 0
        ? "Policy checks passed and the package manager completed successfully."
        : "Policy checks passed, but the underlying package manager exited non-zero.",
    command: argv,
    commandString,
    configPath: path,
    configLabel: configLabel(path),
    packageManager: plan.manager,
    reasons: [],
    summary:
      execution.code === 0
        ? "Allowed: policy checks passed."
        : `Allowed by policy, but ${plan.manager} exited with code ${execution.code}.`,
    warnings,
    infos,
    affectedPackages: plan.packages.map((requested) => ({
      name: requested.name,
      requested: requested.raw,
      sourceType: requested.sourceType,
      reasons: [],
      warnings: [],
      infos: []
    })),
    execution: {
      ranPackageManager: true,
      packageManagerExitCode: execution.code,
      stdout: execution.stdout,
      stderr: execution.stderr
    },
    details: {
      suppressHumanOutput: !options.jsonMode
    }
  };
}
