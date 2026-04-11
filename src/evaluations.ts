import { mapConcurrent } from "./async";
import { loadProjectDependencyState } from "./project-state";
import { RegistryClient } from "./registry";
import { evaluatePackage } from "./policy";
import type { PackageEvaluation, RequestedPackage, SafeInstallConfig } from "./types";

const REGISTRY_EVALUATION_CONCURRENCY = 8;

export async function evaluateRequestedPackages(
  projectDir: string,
  requestedPackages: RequestedPackage[],
  registryClient: RegistryClient,
  config: SafeInstallConfig
): Promise<PackageEvaluation[]> {
  const now = new Date();

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

      return evaluatePackage({
        config,
        requested,
        now,
        priorState,
        resolvedRegistryPackage,
        priorLifecycleScripts
      });
    }
  );
}
