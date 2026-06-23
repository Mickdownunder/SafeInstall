import { mapConcurrent } from "./async";
import { evaluateContinuity } from "./continuity";
import { DiskCache } from "./disk-cache";
import { loadProjectDependencyState } from "./project-state";
import { evaluatePackage } from "./policy";
import { verifyProvenance } from "./provenance";
import { RegistryClient } from "./registry";
import type {
  ContinuityResult,
  PackageEvaluation,
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

export async function evaluateRequestedPackages(
  projectDir: string,
  requestedPackages: RequestedPackage[],
  registryClient: RegistryClient,
  config: SafeInstallConfig,
  signal?: AbortSignal
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
        resolvedRegistryPackage,
        priorLifecycleScripts,
        provenanceResult,
        continuityResult,
        resolutionError
      });
    }
  );
}
