import {
  isProvenanceRequired,
  lookupGlobPattern,
  repositoryMatchesPublisher
} from "./provenance";
import { isLocalSourceType, type LocalSourceClassification } from "./local-source";
import { detectTypoSquat } from "./typo-squat";
import type {
  ContinuityResult,
  InstallLifecycleScriptName,
  PackageEvaluation,
  PriorSourceEvidence,
  ProjectDependencyState,
  ProvenanceVerificationResult,
  RequestedPackage,
  ResolvedRegistryPackage,
  SafeInstallConfig,
  SourceType
} from "./types";

function isPackageAllowlisted(config: SafeInstallConfig, packageName: string): boolean {
  return config.allowedPackages.includes(packageName.toLowerCase());
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
  priorState?: ProjectDependencyState | undefined;
  priorSource?: PriorSourceEvidence | undefined;
  /** How a local (workspace/file/directory) source relates to the repository. */
  localSource?: LocalSourceClassification | undefined;
  resolvedRegistryPackage?: ResolvedRegistryPackage | undefined;
  priorLifecycleScripts?: InstallLifecycleScriptName[];
  provenanceResult?: ProvenanceVerificationResult | undefined;
  continuityResult?: ContinuityResult | undefined;
  /**
   * Error captured when registry metadata resolution failed (package does
   * not exist, network error, 5xx, etc.). If a typo-squat check fires on
   * the same requested name, the typo-squat block is the user-facing
   * result and this error is ignored. Otherwise, a `package-resolution-failed`
   * block is added so the user sees a real error message rather than a
   * silent, empty allow.
   */
  resolutionError?: Error | undefined;
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

  // Local sources: a first-party workspace member is never a supply-chain
  // source and is exempt from allowedSources. Any other local directory (name
  // "directory") or local tarball/file (name "file") is checked against
  // allowedSources under the name of what it actually is, whichever label the
  // package manager's lockfile used.
  const local = input.localSource;
  const isLocal = isLocalSourceType(input.requested.sourceType);
  const policySourceName: SourceType =
    local === undefined || local.kind === "member" ? input.requested.sourceType : local.kind;
  const exemptFirstParty =
    isLocal && (local?.kind === "member" || (local === undefined && input.requested.sourceType === "workspace"));
  if (!exemptFirstParty && !input.config.allowedSources.includes(policySourceName)) {
    evaluation.blockedReasons.push({
      code: "untrusted-source",
      message: `Blocked: untrusted source (${policySourceName}${local?.outsideRepository ? ", outside the repository" : ""}).`,
      suggestion: "Use a registry release or allow this source intentionally."
    });
  }

  const priorSource: PriorSourceEvidence = input.priorSource ?? { status: "unavailable" };
  const dropsRegistryTrust =
    input.requested.sourceType === "git" ||
    input.requested.sourceType === "url" ||
    input.requested.sourceType === "tarball";
  if (
    dropsRegistryTrust &&
    priorSource.status === "unavailable" &&
    input.config.allowedSources.includes(input.requested.sourceType)
  ) {
    evaluation.blockedReasons.push({
      code: "trust-level-dropped",
      message: `Blocked: trust level could not be evaluated (no independent source baseline exists for ${input.requested.name} before ${input.requested.sourceType}).`,
      suggestion:
        "Record the established package source in sourceBaselines or evaluate the change against a trusted base commit."
    });
  } else if (
    (dropsRegistryTrust || isLocal) &&
    priorSource.status === "known" &&
    priorSource.sourceType === "registry"
  ) {
    // A registry -> local swap is reported for every local kind, including a
    // workspace member. An unavailable baseline does not block a local source
    // by itself (fresh projects and monorepos without history are common);
    // only committed evidence of a registry dependency does.
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

  // This also covers native builds: a package shipping a `binding.gyp` runs
  // `node-gyp rebuild` at install time. npm normalizes that into an explicit
  // `install` script at publish, so it appears in `lifecycleScripts` from the
  // registry metadata — no tarball inspection needed. The only case this misses
  // is a non-standard publish that omits the normalization while still shipping
  // a binding.gyp (documented as a known limitation in the README).
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
 * "consistent" surfaces as an info line in warn mode. "no-baseline" is
 * silent — most packages never adopted provenance. "unevaluated" (verification
 * tooling or registry unavailable) warns but never blocks: a hiccup must not
 * block installs, and unverified data must not decide either way.
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
    const attestedFrom = result.baselineRepository ? ` from ${result.baselineRepository}` : "";
    const history = result.skippedRecentVersions
      ? `earlier versions were attested${attestedFrom}, but this version and ${result.skippedRecentVersions} recent ${result.skippedRecentVersions === 1 ? "release" : "releases"} before it have no attestation`
      : `recent versions were attested${attestedFrom}, but this version has no attestation`;
    const message = `${name}@${input.resolvedRegistryPackage?.resolvedVersion ?? input.requested.requested} dropped provenance: ${history}. This is the signature of a compromised-account publish.`;
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

  if (result.status === "unevaluated" && result.error) {
    // Never silent: continuity could not verify attestations (missing
    // sigstore, offline trust root, registry error), so no decision was made.
    evaluation.warnings.push(
      `${name}: provenance continuity was not evaluated (${result.error}).`
    );
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

  if (result.status === "tooling-unavailable") {
    // The sigstore tool is absent, so provenance cannot be evaluated for ANY
    // package — an environment state, not a verdict on this one.
    //
    // The sigstore package cannot verify its own bootstrap install (it is not
    // present yet), so installing sigstore itself is ALWAYS exempt: blocking it
    // would deadlock the very install that re-enables verification.
    const isSigstoreBootstrap = requested === "sigstore";

    // `toolingUnavailable: "fail-closed"` (opt-in) treats a missing verifier as
    // suspicious and blocks — closing the known-gap where an attacker with
    // node_modules write access removes sigstore to slip provenance past the
    // check. The default "warn" keeps the old behaviour so a fresh environment
    // (no sigstore yet) is not bricked.
    if (config.toolingUnavailable === "fail-closed" && !isSigstoreBootstrap) {
      evaluation.blockedReasons.push({
        code: "attestation-tooling-unavailable",
        message:
          `Blocked: provenance cannot be verified for ${requested} because the 'sigstore' package is ` +
          `not installed, and policy requires provenance tooling (provenance.toolingUnavailable: "fail-closed"). ` +
          `A missing verifier is itself suspicious.`,
        suggestion:
          "Install sigstore (npm install sigstore) so provenance can be verified, or set " +
          "provenance.toolingUnavailable to \"warn\" to allow installs without it."
      });
      return;
    }

    // warn (default), or the sigstore bootstrap under fail-closed: the policy is
    // NOT being enforced this run, and the fix is named. This does not weaken the
    // other layers (release age, typo-squat, sources). The residual — an attacker
    // removing sigstore to slip provenance — is closeable with fail-closed above;
    // in warn mode it stays a documented known-gap in the Attack Lab.
    evaluation.warnings.push(
      isSigstoreBootstrap
        ? `Provenance NOT verified for ${requested}: sigstore cannot verify its own bootstrap install; ` +
            `provenance enforcement activates once it is installed.`
        : `Provenance NOT verified for ${requested}: the 'sigstore' package is not installed, ` +
            `so provenance enforcement is inactive for every package. Install it (npm install sigstore) ` +
            `to enable verification.`
    );
    return;
  }

  if (result.status === "unreachable") {
    // allow-cached falls back to a verified cached attestation and only gets
    // here when there is none. Availability may win over a check nobody asked
    // for, never over one that policy requires or pins: otherwise a registry
    // that fails only its attestation endpoint turns the requirement into a
    // warning.
    const enforced = required || lookupGlobPattern(config.trustedPublishers, requested) !== undefined;
    if (config.offlineBehavior === "fail-closed") {
      evaluation.blockedReasons.push({
        code: "attestation-unreachable",
        message: `Blocked: could not fetch provenance attestation for ${requested}${result.error ? ` (${result.error})` : ""}.`,
        suggestion:
          "Retry when the network is available, or set provenance.offlineBehavior to allow-cached."
      });
    } else if (enforced) {
      evaluation.blockedReasons.push({
        code: "attestation-unreachable",
        message:
          `Blocked: could not fetch provenance attestation for ${requested}${result.error ? ` (${result.error})` : ""}, ` +
          "no verified attestation for this version is cached, and policy requires or pins its provenance.",
        suggestion:
          "Retry when the network is available. allow-cached only covers versions whose attestation was verified and cached before."
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
