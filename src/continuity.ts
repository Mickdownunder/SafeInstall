import { DiskCache } from "./disk-cache";
import { fetchAttestationIdentity } from "./provenance";
import type { AttestationIdentity } from "./provenance";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type { ContinuityConfig, ContinuityResult } from "./types";

const VERSION_HISTORY_FETCH_TIMEOUT_MS = 15_000;

// A package whose recent history is at least this provenance-bearing is
// treated as "provenance-bearing", so a version that suddenly arrives
// without provenance is a downgrade. Below this rate the package has no
// usable baseline and continuity stays silent (avoids noise on the large
// majority of packages that never adopted provenance).
const BASELINE_PROVENANCE_THRESHOLD = 0.5;

// How far back an established baseline is looked for when the most recent
// versions carry no provenance, in multiples of `baselineSize`. Releases
// without provenance must not be able to erase the history they follow: with
// a baseline of 5, the 10 versions before the most recent 5 still count.
const ESTABLISHED_BASELINE_WINDOWS = 3;

export interface VersionRecord {
  version: string;
  publishedAt: Date;
  artifactIntegrity?: string | undefined;
  /**
   * The registry lists a provenance attestation for this version. A hint for
   * where to look, never evidence: identities are verified separately.
   */
  claimsProvenance?: boolean | undefined;
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
    signal?: AbortSignal,
    artifactIntegrity?: string
  ): Promise<AttestationIdentity>;
}

interface PackumentTimeShape {
  time?: Record<string, string>;
  versions?: Record<
    string,
    {
      dist?: {
        integrity?: unknown;
        attestations?: unknown;
      };
    }
  >;
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
      // Baseline membership directly controls continuity decisions, so it
      // must come from the selected registry rather than an unsigned cache.
      const base = registryUrl.replace(/\/+$/, "");
      // "manual": a redirect would leave the registry origin; it counts as a failed fetch.
      const response = await fetch(`${base}/${encodePackageNameForUrl(packageName)}`, {
        redirect: "manual",
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
        const artifactIntegrity = versions[version]?.dist?.integrity;
        const attestations = versions[version]?.dist?.attestations;
        const claimsProvenance =
          typeof attestations === "object" && attestations !== null && "provenance" in attestations;
        records.push({
          version,
          publishedAt,
          ...(typeof artifactIntegrity === "string" ? { artifactIntegrity } : {}),
          ...(claimsProvenance ? { claimsProvenance } : {})
        });
      }

      return records;
    },

    async fetchIdentity(packageName, version, registryUrl, signal, artifactIntegrity) {
      return fetchAttestationIdentity({
        packageName,
        version,
        artifactIntegrity,
        registryUrl,
        diskCache,
        signal
      });
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
  return selectPriors(history, targetVersion).slice(0, baselineSize);
}

/** Every version published before the target, most recent first. */
function selectPriors(history: VersionRecord[], targetVersion: string): VersionRecord[] {
  const target = history.find((record) => record.version === targetVersion);
  const candidates = history.filter((record) => record.version !== targetVersion);

  const priors = target
    ? candidates.filter((record) => record.publishedAt.getTime() < target.publishedAt.getTime())
    : candidates;

  return priors.slice().sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

function provenanceRate(identities: AttestationIdentity[]): number {
  return identities.filter((identity) => identity.hasProvenance).length / identities.length;
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
  targetArtifactIntegrity?: string | undefined;
  registryUrl: string;
  config: ContinuityConfig;
  diskCache: DiskCache;
  deps?: ContinuityDependencies;
  signal?: AbortSignal | undefined;
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

  const priors = selectPriors(history, input.targetVersion);
  const baseline = priors.slice(0, input.config.baselineSize);
  if (baseline.length === 0) {
    return { status: "no-baseline", sampledVersions: 0 };
  }
  const fetchIdentities = (records: VersionRecord[]): Promise<AttestationIdentity[]> =>
    Promise.all(
      records.map((record) =>
        deps.fetchIdentity(
          input.packageName,
          record.version,
          input.registryUrl,
          input.signal,
          record.artifactIntegrity
        )
      )
    );

  let baselineIdentities: AttestationIdentity[];
  let targetIdentity: AttestationIdentity;
  try {
    baselineIdentities = await fetchIdentities(baseline);
    targetIdentity = await deps.fetchIdentity(
      input.packageName,
      input.targetVersion,
      input.registryUrl,
      input.signal,
      input.targetArtifactIntegrity
    );
  } catch (error) {
    const shutdownError = getShutdownSignalError(input.signal);
    if (shutdownError) {
      throw shutdownError;
    }
    return { status: "unevaluated", error: error instanceof Error ? error.message : String(error) };
  }

  let baselineProvenanceRate = provenanceRate(baselineIdentities);
  let skippedRecentVersions = 0;

  if (baselineProvenanceRate < BASELINE_PROVENANCE_THRESHOLD) {
    // The most recent versions are not provenance-bearing. Either the package
    // never was, or releases without provenance were published on top of an
    // attested history. The registry's own listing says where to look, at no
    // extra request for the packages that never had provenance; what counts
    // is still the verified identity of those earlier versions.
    const earlier = priors.slice(baseline.length, input.config.baselineSize * ESTABLISHED_BASELINE_WINDOWS);
    const claimed = earlier.filter((record) => record.claimsProvenance === true);
    if (earlier.length > 0 && claimed.length / earlier.length >= BASELINE_PROVENANCE_THRESHOLD) {
      let earlierIdentities: AttestationIdentity[];
      try {
        earlierIdentities = await fetchIdentities(claimed.slice(0, input.config.baselineSize));
      } catch (error) {
        const shutdownError = getShutdownSignalError(input.signal);
        if (shutdownError) {
          throw shutdownError;
        }
        return { status: "unevaluated", error: error instanceof Error ? error.message : String(error) };
      }
      if (provenanceRate(earlierIdentities) >= BASELINE_PROVENANCE_THRESHOLD) {
        skippedRecentVersions = baselineIdentities.filter((identity) => !identity.hasProvenance).length;
        baselineIdentities = earlierIdentities;
        baselineProvenanceRate = provenanceRate(earlierIdentities);
      }
    }
  }

  const baselineRepository = dominantRepository(baselineIdentities);

  const base: ContinuityResult = {
    status: "consistent",
    sampledVersions: baselineIdentities.length,
    baselineProvenanceRate,
    baselineRepository,
    targetHasProvenance: targetIdentity.hasProvenance,
    targetRepository: targetIdentity.sourceRepository,
    ...(skippedRecentVersions > 0 ? { skippedRecentVersions } : {})
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
