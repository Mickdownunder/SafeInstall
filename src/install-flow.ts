import { cliVersionWarning } from "./cli-version";
import { loadConfig } from "./config";
import { captureDecisionState, emitDecisionRecord } from "./decision-emit";
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
import { trustSurfacePrecheck } from "./trust-surface-check";
import type { CliReason, CliResult, PackageEvaluation } from "./types";

export interface InstallFlowOptions {
  jsonMode: boolean;
  signal?: AbortSignal;
  configPath?: string | undefined;
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
  lockfilePath?: string | undefined;
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
  const versionWarning = cliVersionWarning(config.minimumCliVersion);
  const cliVersionWarnings = versionWarning ? [versionWarning] : [];

  const trust = await trustSurfacePrecheck(invocation.effectiveCwd);
  if (trust.reasons.length > 0) {
    return {
      mode: "install",
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Install was blocked because the Agent Trust Surface has drifted.",
      command: argv,
      commandString,
      configPath: path,
      configLabel: configLabel(path),
      packageManager: rawPlan.manager,
      reasons: trust.reasons,
      summary: "Install blocked.",
      warnings: [...cliVersionWarnings, ...trust.warnings],
      infos: [],
      affectedPackages: [],
      execution: {
        ranPackageManager: false
      }
    };
  }
  const trustWarnings = trust.warnings;

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
      warnings: [...cliVersionWarnings, ...trustWarnings],
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
      warnings: [...cliVersionWarnings, ...trustWarnings],
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
      warnings: [...cliVersionWarnings, ...trustWarnings],
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
      warnings: [...cliVersionWarnings, ...trustWarnings],
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
  const warnings = [
    ...cliVersionWarnings,
    ...trustWarnings,
    ...evaluations.flatMap((evaluation) => evaluation.warnings),
    ...transitive.warnings
  ];
  const infos = evaluations.flatMap((evaluation) => evaluation.infos);
  const directBlockReasons = blocked.flatMap((evaluation) => evaluation.blockedReasons);
  const allBlockReasons = [...directBlockReasons, ...transitive.blockedReasons];

  // Bind the repository state BEFORE the package manager can change it: the
  // decision record's before/after lockfile bindings are what CI later
  // verifies (RFC-001 §5.2, §7). Emission is audit evidence, never a gate —
  // when it cannot happen (no git repo), the result says so instead of
  // staying silent.
  const decisionState = await captureDecisionState({
    packageDir: invocation.packageDir ?? invocation.effectiveCwd,
    manager: plan.manager,
    lockfilePath,
    configPath: path
  });
  if (!decisionState.captured) {
    infos.push(`Decision record not written: ${decisionState.skippedReason}.`);
  }

  if (allBlockReasons.length > 0) {
    if (decisionState.captured) {
      const emitted = await emitDecisionRecord({
        capture: decisionState.captured,
        recordType: "install",
        argv,
        packageManager: plan.manager,
        config,
        evaluations,
        decision: "block",
        reasons: allBlockReasons,
        installed: null
      });
      if (emitted.info) infos.push(emitted.info);
      if (emitted.warning) warnings.push(emitted.warning);
    }
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
    for (const warning of cliVersionWarnings) {
      console.error(`Warning: ${warning}`);
    }
    printWarnings(evaluations);
    if (!decisionState.captured) {
      console.error(`Info: Decision record not written: ${decisionState.skippedReason}.`);
    }
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

  if (decisionState.captured) {
    const emitted = await emitDecisionRecord({
      capture: decisionState.captured,
      recordType: "install",
      argv,
      packageManager: plan.manager,
      config,
      evaluations,
      decision: "allow",
      reasons: [],
      installed: execution.code === 0
    });
    if (emitted.info) {
      infos.push(emitted.info);
      if (!options.jsonMode) {
        console.error(`Info: ${emitted.info}`);
      }
    }
    if (emitted.warning) {
      warnings.push(emitted.warning);
      if (!options.jsonMode) {
        console.error(`Warning: ${emitted.warning}`);
      }
    }
  }

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
