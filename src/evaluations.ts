import { mapConcurrent } from "./async";
import { evaluateContinuity } from "./continuity";
import { DiskCache } from "./disk-cache";
import { loadProjectDependencyState } from "./project-state";
import { evaluatePackage } from "./policy";
import { verifyProvenance } from "./provenance";
import { RegistryClient } from "./registry";
import type {
  ContinuityResult,
  DependencySourceBaseline,
  PackageEvaluation,
  PriorSourceEvidence,
  ProvenanceVerificationResult,
  RequestedPackage,
  SafeInstallConfig
} from "./types";

const REGISTRY_EVALUATION_CONCURRENCY = 8;

export interface EvaluateRequestedPackagesOptions {
  projectDir: string;
  requestedPackages: RequestedPackage[];
  registryClient: RegistryClient;
  config: SafeInstallConfig;
  signal?: AbortSignal;
}

function configuredSourceBaseline(config: SafeInstallConfig): DependencySourceBaseline {
  return { complete: false, sourceTypes: config.sourceBaselines ?? {} };
}

function priorSourceEvidence(
  packageName: string,
  baseline: DependencySourceBaseline
): PriorSourceEvidence {
  const normalizedName = packageName.toLowerCase();
  if (Object.hasOwn(baseline.sourceTypes, normalizedName)) {
    return { status: "known", sourceType: baseline.sourceTypes[normalizedName] };
  }

  return baseline.complete ? { status: "known" } : { status: "unavailable" };
}

export async function evaluateRequestedPackages(
  projectDir: string,
  requestedPackages: RequestedPackage[],
  registryClient: RegistryClient,
  config: SafeInstallConfig,
  signal?: AbortSignal,
  sourceBaseline: DependencySourceBaseline = configuredSourceBaseline(config)
): Promise<PackageEvaluation[]> {
  const now = new Date();
  const provenanceCache = new DiskCache({ ttlMs: 60 * 60 * 1000 });

  return mapConcurrent(
    requestedPackages,
    REGISTRY_EVALUATION_CONCURRENCY,
    async (requested) => {
      const priorState = await loadProjectDependencyState(projectDir, requested.name);
      const priorLifecycleScripts =
        priorState?.installedVersion && requested.sourceType === "registry"
          ? await registryClient.getLifecycleScripts(requested.name, priorState.installedVersion)
          : [];

      let resolvedRegistryPackage: Awaited<
        ReturnType<typeof registryClient.resolvePackage>
      > | undefined;
      let resolutionError: Error | undefined;
      if (requested.sourceType === "registry") {
        try {
          resolvedRegistryPackage = await registryClient.resolvePackage(requested);
        } catch (error) {
          // Capture instead of throwing so typo-squat detection — which does
          // not need registry data — can still fire on close-but-nonexistent
          // names. If nothing else blocks, evaluatePackage surfaces the
          // original error as a package-resolution-failed block.
          resolutionError = error instanceof Error ? error : new Error(String(error));
        }
      }

      let provenanceResult: ProvenanceVerificationResult | undefined;
      if (
        config.provenance.mode !== "off" &&
        requested.sourceType === "registry" &&
        resolvedRegistryPackage
      ) {
        provenanceResult = await verifyProvenance({
          packageName: requested.name,
          version: resolvedRegistryPackage.resolvedVersion,
          artifactIntegrity: resolvedRegistryPackage.artifact?.integrity,
          registryUrl: config.registryUrl,
          diskCache: provenanceCache,
          config: config.provenance,
          signal
        });
      }

      let continuityResult: ContinuityResult | undefined;
      if (
        config.continuity.mode !== "off" &&
        requested.sourceType === "registry" &&
        resolvedRegistryPackage
      ) {
        continuityResult = await evaluateContinuity({
          packageName: requested.name,
          targetVersion: resolvedRegistryPackage.resolvedVersion,
          targetArtifactIntegrity: resolvedRegistryPackage.artifact?.integrity,
          registryUrl: config.registryUrl,
          config: config.continuity,
          diskCache: provenanceCache,
          signal
        });
      }

      return evaluatePackage({
        config,
        requested,
        now,
        priorState,
        priorSource: priorSourceEvidence(requested.name, sourceBaseline),
        resolvedRegistryPackage,
        priorLifecycleScripts,
        provenanceResult,
        continuityResult,
        resolutionError
      });
    }
  );
}
