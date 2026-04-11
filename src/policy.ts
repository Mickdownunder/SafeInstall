import {
  isProvenanceRequired,
  lookupGlobPattern,
  repositoryMatchesPublisher
} from "./provenance";
import { detectTypoSquat } from "./typo-squat";
import type {
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

  if (isPackageAllowlisted(input.config, input.requested.name)) {
    evaluation.warnings.push(`Package ${input.requested.name} is allowlisted; policy checks were skipped.`);
    return evaluation;
  }

  if (input.config.typoSquat.mode !== "off") {
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

  applyProvenanceDecision(evaluation, input);

  return evaluation;
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
