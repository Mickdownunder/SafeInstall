import type { Bundle } from "sigstore";

export type { Bundle };

import { DiskCache } from "./disk-cache";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type {
  ProvenanceConfig,
  ProvenanceVerificationResult,
  TrustedPublisherPattern
} from "./types";

const ATTESTATION_CACHE_NAMESPACE = "registry-attestations-v1";
const ATTESTATION_CACHE_TTL_MS = 60 * 60 * 1000;
const ATTESTATION_FETCH_TIMEOUT_MS = 15_000;
const SLSA_PREDICATE_TYPE_PREFIX = "https://slsa.dev/provenance";
const GITHUB_URL_PREFIX = "https://github.com/";

interface NpmAttestationResponse {
  attestations?: Array<{
    predicateType?: string;
    bundle?: Bundle;
  }>;
}

interface Slsa1Statement {
  _type?: string;
  subject?: Array<{
    name?: string;
    digest?: Record<string, string>;
  }>;
  predicateType?: string;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: {
          ref?: string;
          repository?: string;
          path?: string;
        };
      };
      resolvedDependencies?: Array<{
        uri?: string;
        digest?: Record<string, string>;
      }>;
    };
    runDetails?: {
      builder?: {
        id?: string;
      };
      metadata?: {
        invocationId?: string;
      };
    };
  };
}

function encodePackageNameForUrl(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, "@");
}

export function attestationUrl(registryUrl: string, name: string, version: string): string {
  const base = registryUrl.replace(/\/+$/, "");
  return `${base}/-/npm/v1/attestations/${encodePackageNameForUrl(name)}@${encodeURIComponent(version)}`;
}

function createFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ATTESTATION_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Parse a DSSE envelope payload (base64-encoded JSON) into a typed SLSA
 * statement. Returns undefined if the payload can't be decoded.
 */
function parseStatement(bundle: Bundle): Slsa1Statement | undefined {
  const envelope = bundle.dsseEnvelope;
  if (!envelope?.payload) {
    return undefined;
  }

  try {
    const decoded =
      typeof envelope.payload === "string"
        ? Buffer.from(envelope.payload, "base64").toString("utf8")
        : Buffer.from(envelope.payload as Uint8Array).toString("utf8");
    return JSON.parse(decoded) as Slsa1Statement;
  } catch {
    return undefined;
  }
}

/**
 * Extract the `<owner>/<repo>` slug from a GitHub repository URL in a SLSA
 * statement. Returns undefined if the URL doesn't look like a GitHub URL.
 */
export function extractRepositorySlug(repositoryUrl: string | undefined): string | undefined {
  if (!repositoryUrl || !repositoryUrl.startsWith(GITHUB_URL_PREFIX)) {
    return undefined;
  }

  const tail = repositoryUrl.slice(GITHUB_URL_PREFIX.length).replace(/\.git$/, "");
  const parts = tail.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return undefined;
  }

  return `${parts[0]}/${parts[1]}`;
}

/**
 * Resolve a package name against a map of glob patterns to values, returning
 * the value whose pattern matches the name. Supports only `*` wildcards (no
 * `?`, `**`, character classes) since that's all we need for scoped packages
 * and user/org prefixes.
 */
export function lookupGlobPattern<TValue>(
  map: Record<string, TValue>,
  key: string
): TValue | undefined {
  for (const [pattern, value] of Object.entries(map)) {
    if (matchesGlob(pattern, key)) {
      return value;
    }
  }
  return undefined;
}

export function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }

  if (!pattern.includes("*")) {
    return false;
  }

  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

/**
 * True if `matches` contains at least one glob pattern covering `name`.
 */
export function matchesAnyPattern(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, name));
}

/**
 * The trusted publisher expectation for a package is either an exact repo
 * slug (`axios/axios`) or a glob pattern (`my-org/*`). This function returns
 * true when the provenance-derived repository slug matches the expectation.
 */
export function repositoryMatchesPublisher(
  actualRepositorySlug: string,
  expectedPattern: TrustedPublisherPattern
): boolean {
  return matchesGlob(expectedPattern, actualRepositorySlug);
}

/**
 * True when policy requires provenance for this specific package, either
 * because mode is "require" globally, or because the package matches one of
 * the per-package override patterns.
 */
export function isProvenanceRequired(config: ProvenanceConfig, packageName: string): boolean {
  if (config.mode === "require") {
    return true;
  }
  return matchesAnyPattern(packageName, config.requireFor);
}

export interface ProvenanceDependencies {
  /** Fetch attestation JSON from the registry. Return null on 404. */
  fetchAttestations(url: string, signal?: AbortSignal): Promise<NpmAttestationResponse | null>;
  /** Cryptographically verify a Sigstore bundle. Throws on failure. */
  verifyBundle(bundle: Bundle): Promise<void>;
}

async function defaultFetchAttestations(
  url: string,
  signal?: AbortSignal
): Promise<NpmAttestationResponse | null> {
  const response = await fetch(url, { signal: createFetchSignal(signal) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`attestation fetch failed with HTTP ${response.status}`);
  }
  return (await response.json()) as NpmAttestationResponse;
}

async function defaultVerifyBundle(bundle: Bundle): Promise<void> {
  // Lazy-load the sigstore verification library so users who never enable
  // provenance.mode do not pay the module-load cost on every CLI invocation.
  // This keeps cold-start time and memory footprint low by default and only
  // loads the heavy transitive dependency tree (sigstore, @sigstore/bundle,
  // @sigstore/core, @sigstore/sign, @sigstore/tuf) when verification is
  // actually requested.
  const sigstore = await import("sigstore");
  await sigstore.verify(bundle);
}

export function createDefaultProvenanceDependencies(): ProvenanceDependencies {
  return {
    fetchAttestations: defaultFetchAttestations,
    verifyBundle: defaultVerifyBundle
  };
}

export interface VerifyProvenanceInput {
  packageName: string;
  version: string;
  registryUrl: string;
  diskCache: DiskCache;
  config: ProvenanceConfig;
  deps?: ProvenanceDependencies;
  signal?: AbortSignal;
}

/**
 * Fetch the attestation bundle for a package version from the npm registry,
 * cryptographically verify the SLSA provenance attestation via Sigstore, and
 * return a structured verification result.
 *
 * Never throws on ordinary failure modes (missing attestations, network
 * errors, verification failures). Callers translate the result status into a
 * policy decision according to the configured mode and offlineBehavior.
 */
export async function verifyProvenance(
  input: VerifyProvenanceInput
): Promise<ProvenanceVerificationResult> {
  throwIfAborted(input.signal);
  const deps = input.deps ?? createDefaultProvenanceDependencies();
  const url = attestationUrl(input.registryUrl, input.packageName, input.version);
  const cacheKey = `${input.registryUrl}|${input.packageName}@${input.version}`;

  let rawResponse: NpmAttestationResponse | null = null;
  let reachedRegistry = true;
  try {
    rawResponse = await deps.fetchAttestations(url, input.signal);
    if (rawResponse) {
      await input.diskCache.setJson(ATTESTATION_CACHE_NAMESPACE, cacheKey, rawResponse);
    }
  } catch (error) {
    const shutdownError = getShutdownSignalError(input.signal);
    if (shutdownError) {
      throw shutdownError;
    }
    reachedRegistry = false;
    if (input.config.offlineBehavior === "allow-cached") {
      const cached = await input.diskCache.getJson<NpmAttestationResponse>(
        ATTESTATION_CACHE_NAMESPACE,
        cacheKey
      );
      if (!cached) {
        return {
          status: "unreachable",
          error: error instanceof Error ? error.message : String(error)
        };
      }
      rawResponse = cached;
    } else {
      return {
        status: "unreachable",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Skip-ahead on TTL: even in fail-closed mode we still honor the disk
  // cache for packages already fetched this hour, so repeated installs of
  // the same version don't refetch. This is separate from allow-cached
  // offline behavior above, which reaches for cache only after a failure.
  if (rawResponse === null && reachedRegistry) {
    return { status: "missing" };
  }

  if (!rawResponse) {
    return { status: "missing" };
  }

  const attestations = rawResponse.attestations ?? [];
  const slsa = attestations.find((entry) =>
    entry.predicateType?.startsWith(SLSA_PREDICATE_TYPE_PREFIX)
  );
  if (!slsa?.bundle) {
    return { status: "missing" };
  }

  try {
    await deps.verifyBundle(slsa.bundle);
  } catch (error) {
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const statement = parseStatement(slsa.bundle);
  if (!statement) {
    return {
      status: "invalid",
      error: "could not decode SLSA statement payload from bundle"
    };
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const sourceRepository = extractRepositorySlug(workflow?.repository);
  if (!sourceRepository) {
    return {
      status: "invalid",
      error: "SLSA statement is missing a GitHub repository URL"
    };
  }

  return {
    status: "verified",
    sourceRepository,
    sourceRef: workflow?.ref,
    workflowPath: workflow?.path,
    builderId: statement.predicate?.runDetails?.builder?.id
  };
}
