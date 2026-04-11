import { mapConcurrent } from "./async";
import { DiskCache } from "./disk-cache";
import { loadProjectDependencyState } from "./project-state";
import { evaluatePackage } from "./policy";
import { verifyProvenance } from "./provenance";
import { RegistryClient } from "./registry";
import type {
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

      const resolvedRegistryPackage =
        requested.sourceType === "registry"
          ? await registryClient.resolvePackage(requested)
          : undefined;

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

      return evaluatePackage({
        config,
        requested,
        now,
        priorState,
        resolvedRegistryPackage,
        priorLifecycleScripts,
        provenanceResult
      });
    }
  );
}
