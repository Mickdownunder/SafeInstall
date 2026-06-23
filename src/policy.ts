import {
  isProvenanceRequired,
  lookupGlobPattern,
  repositoryMatchesPublisher
} from "./provenance";
import { detectTypoSquat } from "./typo-squat";
import type {
  ContinuityResult,
  InstallLifecycleScriptName,
  PackageEvaluation,
  ProjectDependencyState,
  ProvenanceVerificationResult,
  RequestedPackage,
  ResolvedRegistryPackage,
  SafeInstallConfig
} from "./types";

function isPackageAllowlisted(config: SafeInstallConfig, packageName: string): boolean {
  return config.allowedPackages.includes(packageName.toLowerCase());
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
  provenanceResult?: ProvenanceVerificationResult;
  continuityResult?: ContinuityResult;
  /**
   * Error captured when registry metadata resolution failed (package does
   * not exist, network error, 5xx, etc.). If a typo-squat check fires on
   * the same requested name, the typo-squat block is the user-facing
   * result and this error is ignored. Otherwise, a `package-resolution-failed`
   * block is added so the user sees a real error message rather than a
   * silent, empty allow.
   */
  resolutionError?: Error;
}

export function evaluatePackage(input: EvaluatePackageInput): PackageEvaluation {
  const evaluation: PackageEvaluation = {
    requested: input.requested,
    priorState: input.priorState,
    resolvedRegistryPackage: input.resolvedRegistryPackage,
    blockedReasons: [],
    warnings: [],
    infos: []
  };

  // Allowlisting vouches for a package's identity and accepts its normal
  // risk profile (fresh releases, declared install scripts, name spelling).
  // It does NOT bypass active attack signals: source-type, trust downgrades,
  // newly-introduced scripts, and provenance/publisher checks still run.
  // This is the 0.3.0 tightening of the previous "skip everything" behavior.
  const allowlisted = isPackageAllowlisted(input.config, input.requested.name);
  if (allowlisted) {
    evaluation.warnings.push(
      `Package ${input.requested.name} is allowlisted; release-age, install-script, and typo-squat checks were skipped. Source, trust-downgrade, and provenance checks still apply.`
    );
  }

  if (!allowlisted && input.config.typoSquat.mode !== "off") {
    const suspicion = detectTypoSquat(input.requested.name, input.config.typoSquat);
    if (suspicion) {
      const message = `Suspected typo-squat: "${suspicion.requested}" is ${suspicion.editDistance} edit(s) away from popular package "${suspicion.suspectedTarget}".`;
      const suggestion = `Verify you meant to install "${suspicion.suspectedTarget}". If this package is intentional, add "${suspicion.requested.toLowerCase()}" to typoSquat.ignore.`;
      if (input.config.typoSquat.mode === "block") {
        evaluation.blockedReasons.push({
          code: "typo-squat-suspected",
          message: `Blocked: ${message}`,
          suggestion
        });
      } else {
        evaluation.warnings.push(`${message} ${suggestion}`);
      }
    }
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
    // If registry resolution failed for a registry-sourced package AND
    // nothing else (typo-squat, source, trust-downgrade) caught it, surface
    // a real error so the user isn't left with a silent empty allow.
    if (
      input.resolutionError &&
      input.requested.sourceType === "registry" &&
      evaluation.blockedReasons.length === 0
    ) {
      evaluation.blockedReasons.push({
        code: "package-resolution-failed",
        message: `Blocked: could not resolve ${input.requested.name} from the registry (${input.resolutionError.message}).`,
        suggestion:
          "Check the package name spelling and your network connectivity, then retry."
      });
    }
    return evaluation;
  }

  const ageHours = releaseAgeHours(input.now, input.resolvedRegistryPackage.publishedAt);
  if (!allowlisted && ageHours < input.config.minimumReleaseAgeHours) {
    evaluation.blockedReasons.push({
      code: "release-too-new",
      message: `Blocked: release too new (${input.requested.name}@${input.resolvedRegistryPackage.resolvedVersion} is ${formatHours(ageHours)} hours old; minimum is ${input.config.minimumReleaseAgeHours} hours).`,
      suggestion: "Retry later or lower minimumReleaseAgeHours if this package is intentionally urgent."
    });
  }

  if (
    !allowlisted &&
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

  applyProvenanceDecision(evaluation, input);
  applyContinuityDecision(evaluation, input);

  evaluation.sourceRepository = deriveSourceRepository(input);

  return evaluation;
}

/**
 * Surface the package's publish source repository (`owner/repo`) so callers
 * that present a verdict — the MCP server, JSON consumers — can show where the
 * installed version came from. Prefers a cryptographically verified provenance
 * repository, then the target version's continuity identity, then the
 * continuity baseline. Returns undefined when no attestation data is available.
 */
function deriveSourceRepository(input: EvaluatePackageInput): string | undefined {
  if (input.provenanceResult?.status === "verified" && input.provenanceResult.sourceRepository) {
    return input.provenanceResult.sourceRepository;
  }

  const continuity = input.continuityResult;
  if (continuity) {
    return continuity.targetRepository ?? continuity.baselineRepository;
  }

  return undefined;
}

/**
 * Translate a provenance continuity result into blocked reasons, warnings,
 * or info on the package evaluation.
 *
 * Continuity learns a per-package trust baseline from the provenance
 * identity of recent versions. The two block-worthy deviations are:
 *   - provenance-downgrade: the baseline was provenance-bearing, but the
 *     installed version carries no attestation (the signature of an account
 *     compromise publishing from a personal token, e.g. Mastra).
 *   - identity-discontinuity: the installed version is attested from a
 *     different source repository than the established baseline.
 *
 * "consistent" surfaces as an info line in warn mode. "no-baseline" and
 * "unevaluated" are silent — most packages never adopted provenance, and a
 * registry hiccup must not block.
 */
function applyContinuityDecision(evaluation: PackageEvaluation, input: EvaluatePackageInput): void {
  const config = input.config.continuity;
  if (config.mode === "off" || !input.continuityResult) {
    return;
  }

  const result = input.continuityResult;
  const name = input.requested.name;
  const block = config.mode === "block";

  if (result.status === "provenance-downgrade") {
    const message = `${name}@${input.resolvedRegistryPackage?.resolvedVersion ?? input.requested.requested} dropped provenance: recent versions were attested${result.baselineRepository ? ` from ${result.baselineRepository}` : ""}, but this version has no attestation. This is the signature of a compromised-account publish.`;
    const suggestion =
      "Treat this as a likely account compromise. Do not install until the maintainer confirms the release.";
    if (block) {
      evaluation.blockedReasons.push({ code: "provenance-downgrade", message: `Blocked: ${message}`, suggestion });
    } else {
      evaluation.warnings.push(`${message} ${suggestion}`);
    }
    return;
  }

  if (result.status === "identity-discontinuity") {
    const message = `${name} changed publish identity: recent versions were attested from ${result.baselineRepository}, but this version is attested from ${result.targetRepository}.`;
    const suggestion =
      "Verify the source repository change is intentional before installing.";
    if (block) {
      evaluation.blockedReasons.push({ code: "identity-discontinuity", message: `Blocked: ${message}`, suggestion });
    } else {
      evaluation.warnings.push(`${message} ${suggestion}`);
    }
    return;
  }

  if (result.status === "consistent" && config.mode === "warn") {
    evaluation.infos.push(
      `${name}: provenance consistent with baseline${result.baselineRepository ? ` (${result.baselineRepository})` : ""}.`
    );
  }
}

/**
 * Translate a provenance verification result into blocked reasons or
 * warnings on the package evaluation, respecting the configured mode and
 * the per-package `requireFor` overrides.
 *
 * Mode semantics:
 *   - "off"     → no check; result is ignored even if present
 *   - "warn"    → always record verification status as a warning; never block
 *   - "require" → verification failures always block; verified results are silent
 *
 * Trusted publisher mismatches are **always** a block regardless of mode.
 * An attacker who compromises an npm maintainer and republishes from a fork
 * can produce valid provenance, so the publisher pin must be enforced the
 * moment it's configured.
 */
function applyProvenanceDecision(
  evaluation: PackageEvaluation,
  input: EvaluatePackageInput
): void {
  const config = input.config.provenance;
  if (config.mode === "off") {
    return;
  }

  if (!input.provenanceResult) {
    return;
  }

  const requested = input.requested.name;
  const required = isProvenanceRequired(config, requested);
  const result = input.provenanceResult;

  if (result.status === "missing") {
    if (required) {
      evaluation.blockedReasons.push({
        code: "attestation-missing",
        message: `Blocked: ${requested} has no provenance attestation and policy requires one.`,
        suggestion:
          "Ask the maintainer to publish with --provenance, or remove this package from provenance.requireFor."
      });
    } else if (config.mode === "warn") {
      evaluation.warnings.push(`${requested} has no provenance attestation.`);
    }
    return;
  }

  if (result.status === "invalid") {
    evaluation.blockedReasons.push({
      code: "attestation-invalid",
      message: `Blocked: provenance verification failed for ${requested}${result.error ? ` (${result.error})` : ""}.`,
      suggestion:
        "The attestation could not be cryptographically verified. Do not trust this package without further review."
    });
    return;
  }

  if (result.status === "unreachable") {
    if (config.offlineBehavior === "fail-closed") {
      evaluation.blockedReasons.push({
        code: "attestation-unreachable",
        message: `Blocked: could not fetch provenance attestation for ${requested}${result.error ? ` (${result.error})` : ""}.`,
        suggestion:
          "Retry when the network is available, or set provenance.offlineBehavior to allow-cached."
      });
    } else {
      evaluation.warnings.push(
        `${requested}: provenance attestation unreachable${result.error ? ` (${result.error})` : ""}.`
      );
    }
    return;
  }

  // Verified — check the trusted publisher pin.
  const expectedPublisher = lookupGlobPattern(config.trustedPublishers, requested);
  if (expectedPublisher && result.sourceRepository) {
    if (!repositoryMatchesPublisher(result.sourceRepository, expectedPublisher)) {
      evaluation.blockedReasons.push({
        code: "publisher-mismatch",
        message: `Blocked: publisher mismatch for ${requested} (expected ${expectedPublisher}, got ${result.sourceRepository}).`,
        suggestion:
          "Verify the package source. Update provenance.trustedPublishers only if the change is intentional."
      });
      return;
    }
  }

  if (config.mode === "warn") {
    evaluation.infos.push(
      `${requested}: provenance verified from ${result.sourceRepository ?? "unknown repository"}${result.workflowPath ? ` via ${result.workflowPath}` : ""}.`
    );
  }
}
