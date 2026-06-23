import { DiskCache } from "./disk-cache";
import { fetchAttestationIdentity } from "./provenance";
import type { AttestationIdentity } from "./provenance";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type { ContinuityConfig, ContinuityResult } from "./types";

const VERSION_HISTORY_CACHE_NAMESPACE = "registry-version-history-v1";
const VERSION_HISTORY_FETCH_TIMEOUT_MS = 15_000;

// A package whose recent history is at least this provenance-bearing is
// treated as "provenance-bearing", so a version that suddenly arrives
// without provenance is a downgrade. Below this rate the package has no
// usable baseline and continuity stays silent (avoids noise on the large
// majority of packages that never adopted provenance).
const BASELINE_PROVENANCE_THRESHOLD = 0.5;

export interface VersionRecord {
  version: string;
  publishedAt: Date;
}

export interface ContinuityDependencies {
  fetchVersionHistory(
    packageName: string,
    registryUrl: string,
    signal?: AbortSignal
  ): Promise<VersionRecord[]>;
  fetchIdentity(
    packageName: string,
    version: string,
    registryUrl: string,
    signal?: AbortSignal
  ): Promise<AttestationIdentity>;
}

interface PackumentTimeShape {
  time?: Record<string, string>;
  versions?: Record<string, unknown>;
}

function encodePackageNameForUrl(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, "@");
}

function createFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(VERSION_HISTORY_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createDefaultContinuityDependencies(diskCache?: DiskCache): ContinuityDependencies {
  return {
    async fetchVersionHistory(packageName, registryUrl, signal) {
      const cacheKey = `${registryUrl}|${packageName}`;
      const cached = diskCache
        ? await diskCache.getJson<Array<{ version: string; publishedAt: string }>>(
            VERSION_HISTORY_CACHE_NAMESPACE,
            cacheKey
          )
        : undefined;
      if (cached) {
        return cached.map((entry) => ({
          version: entry.version,
          publishedAt: new Date(entry.publishedAt)
        }));
      }

      const base = registryUrl.replace(/\/+$/, "");
      const response = await fetch(`${base}/${encodePackageNameForUrl(packageName)}`, {
        signal: createFetchSignal(signal)
      });
      if (!response.ok) {
        throw new Error(`version history fetch failed with HTTP ${response.status}`);
      }
      const packument = (await response.json()) as PackumentTimeShape;
      const time = packument.time ?? {};
      const versions = packument.versions ?? {};

      const records: VersionRecord[] = [];
      for (const [version, published] of Object.entries(time)) {
        if (version === "created" || version === "modified") {
          continue;
        }
        if (!(version in versions)) {
          continue;
        }
        const publishedAt = new Date(published);
        if (Number.isNaN(publishedAt.getTime())) {
          continue;
        }
        records.push({ version, publishedAt });
      }

      if (diskCache) {
        await diskCache.setJson(
          VERSION_HISTORY_CACHE_NAMESPACE,
          cacheKey,
          records.map((record) => ({
            version: record.version,
            publishedAt: record.publishedAt.toISOString()
          }))
        );
      }

      return records;
    },

    async fetchIdentity(packageName, version, registryUrl, signal) {
      return fetchAttestationIdentity({ packageName, version, registryUrl, diskCache, signal });
    }
  };
}

/**
 * Select the baseline: the most recent versions published strictly before
 * the target version, capped at `baselineSize`. If the target version is not
 * found in the history, fall back to the most recent versions overall
 * (excluding the target name).
 */
export function selectBaseline(
  history: VersionRecord[],
  targetVersion: string,
  baselineSize: number
): VersionRecord[] {
  const target = history.find((record) => record.version === targetVersion);
  const candidates = history.filter((record) => record.version !== targetVersion);

  const priors = target
    ? candidates.filter((record) => record.publishedAt.getTime() < target.publishedAt.getTime())
    : candidates;

  return priors
    .slice()
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, baselineSize);
}

function dominantRepository(identities: AttestationIdentity[]): string | undefined {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    if (identity.hasProvenance && identity.sourceRepository) {
      counts.set(identity.sourceRepository, (counts.get(identity.sourceRepository) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [repo, count] of counts) {
    if (count > bestCount) {
      best = repo;
      bestCount = count;
    }
  }
  return best;
}

export interface EvaluateContinuityInput {
  packageName: string;
  targetVersion: string;
  registryUrl: string;
  config: ContinuityConfig;
  diskCache: DiskCache;
  deps?: ContinuityDependencies;
  signal?: AbortSignal;
}

/**
 * Learn a per-package trust baseline from the provenance identity of recent
 * versions and classify the target version against it. Detects
 * provenance-downgrade (baseline was provenance-bearing, target is not) and
 * identity-discontinuity (target's source repository differs from the
 * baseline's). Never throws on ordinary failures; on infrastructure errors
 * it returns `unevaluated` rather than blocking, so a registry hiccup does
 * not break installs.
 */
export async function evaluateContinuity(
  input: EvaluateContinuityInput
): Promise<ContinuityResult> {
  if (input.config.mode === "off") {
    return { status: "unevaluated" };
  }

  throwIfAborted(input.signal);
  const deps = input.deps ?? createDefaultContinuityDependencies(input.diskCache);

  let history: VersionRecord[];
  try {
    history = await deps.fetchVersionHistory(input.packageName, input.registryUrl, input.signal);
  } catch (error) {
    const shutdownError = getShutdownSignalError(input.signal);
    if (shutdownError) {
      throw shutdownError;
    }
    return { status: "unevaluated", error: error instanceof Error ? error.message : String(error) };
  }

  const baseline = selectBaseline(history, input.targetVersion, input.config.baselineSize);
  if (baseline.length === 0) {
    return { status: "no-baseline", sampledVersions: 0 };
  }

  let baselineIdentities: AttestationIdentity[];
  let targetIdentity: AttestationIdentity;
  try {
    baselineIdentities = await Promise.all(
      baseline.map((record) =>
        deps.fetchIdentity(input.packageName, record.version, input.registryUrl, input.signal)
      )
    );
    targetIdentity = await deps.fetchIdentity(
      input.packageName,
      input.targetVersion,
      input.registryUrl,
      input.signal
    );
  } catch (error) {
    const shutdownError = getShutdownSignalError(input.signal);
    if (shutdownError) {
      throw shutdownError;
    }
    return { status: "unevaluated", error: error instanceof Error ? error.message : String(error) };
  }

  const provenanceCount = baselineIdentities.filter((identity) => identity.hasProvenance).length;
  const baselineProvenanceRate = provenanceCount / baselineIdentities.length;
  const baselineRepository = dominantRepository(baselineIdentities);

  const base: ContinuityResult = {
    status: "consistent",
    sampledVersions: baselineIdentities.length,
    baselineProvenanceRate,
    baselineRepository,
    targetHasProvenance: targetIdentity.hasProvenance,
    targetRepository: targetIdentity.sourceRepository
  };

  if (baselineProvenanceRate < BASELINE_PROVENANCE_THRESHOLD) {
    // The package isn't reliably provenance-bearing; nothing to downgrade
    // from. Stay silent to avoid flagging the large majority of packages
    // that never adopted provenance.
    return { ...base, status: "no-baseline" };
  }

  if (!targetIdentity.hasProvenance) {
    return { ...base, status: "provenance-downgrade" };
  }

  if (
    targetIdentity.sourceRepository &&
    baselineRepository &&
    targetIdentity.sourceRepository !== baselineRepository
  ) {
    return { ...base, status: "identity-discontinuity" };
  }

  return base;
}
