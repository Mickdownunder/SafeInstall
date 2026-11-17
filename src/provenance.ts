/**
 * Minimal Bundle shape compatible with sigstore's Bundle type. Defined
 * inline so the build succeeds even when the optional sigstore package
 * is not installed — TypeScript needs resolvable types at compile time,
 * but sigstore is only loaded at runtime when provenance.mode is enabled.
 */
export interface Bundle {
  mediaType?: string;
  dsseEnvelope?: {
    payload: string | Uint8Array;
    payloadType: string;
    signatures: Array<{ sig: string; keyid?: string }>;
  };
}

import { DiskCache } from "./disk-cache";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type {
  ProvenanceConfig,
  ProvenanceVerificationResult,
  TrustedPublisherPattern
} from "./types";

const ATTESTATION_CACHE_NAMESPACE = "registry-attestations-v1";
const ATTESTATION_FETCH_TIMEOUT_MS = 15_000;
const SLSA_PREDICATE_TYPE_PREFIX = "https://slsa.dev/provenance";
const SLSA_V1_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1_TYPE = "https://in-toto.io/Statement/v1";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const GITHUB_URL_PREFIX = "https://github.com/";
const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_WORKFLOW_PATH_PREFIX = ".github/workflows/";

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
  /** Cryptographically verify a Sigstore bundle and its expected signer. Throws on failure. */
  verifyBundle(bundle: Bundle, signingIdentity: ProvenanceSigningIdentity): Promise<void>;
}

/**
 * The signer expectation enforced on the Sigstore certificate. The signer is
 * bound through the Fulcio "Source Repository URI" extension rather than the
 * workflow identity (SAN): packages published through reusable workflows have
 * a SAN naming a different workflow, sometimes in another repository, while
 * the source repository extension always names the repository being built.
 */
export interface ProvenanceSigningIdentity {
  certificateIssuer: string;
  /** Expected source repository URL, e.g. `https://github.com/owner/repo`. */
  sourceRepositoryUrl: string;
}

/** Fulcio certificate extension OID: Source Repository URI. */
export const FULCIO_SOURCE_REPOSITORY_URI_OID = "1.3.6.1.4.1.57264.1.12";

/**
 * DER-encode a UTF8String (tag 0x0c, DER length, bytes). Sigstore compares the
 * expected OID value byte for byte with the raw extension value, which for
 * Fulcio's Source Repository URI is a DER UTF8String.
 */
export function encodeDerUtf8String(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  const length = content.length;
  let lengthBytes: Buffer;
  if (length < 0x80) {
    lengthBytes = Buffer.from([length]);
  } else {
    const octets: number[] = [];
    for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
      octets.unshift(remaining % 256);
    }
    lengthBytes = Buffer.from([0x80 | octets.length, ...octets]);
  }
  return Buffer.concat([Buffer.from([0x0c]), lengthBytes, content]);
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

/**
 * Thrown when the `sigstore` verification tooling itself is absent — as
 * opposed to a bundle that loads but fails to verify. The distinction is a
 * security boundary: a missing tool means provenance cannot be evaluated for
 * ANY package (an environment/config state, e.g. a fresh checkout whose
 * `sigstore` peer dep is still being installed), whereas a failed verification
 * is a package-specific signal. Callers must degrade the former to a warning
 * and keep failing the latter closed — collapsing them makes SafeInstall
 * unbootstrappable (it cannot install the very `sigstore` it demands).
 */
export class SigstoreToolingUnavailableError extends Error {
  constructor() {
    super(
      "Sigstore provenance verification requires the optional 'sigstore' package. " +
        "Install it with: npm install sigstore"
    );
    this.name = "SigstoreToolingUnavailableError";
  }
}

interface SigstoreVerifyOptions {
  certificateIssuer: string;
  // sigstore runs Buffer.from(value) on each value. Its typings say string,
  // but a string would be UTF-8 encoded, expanding the DER long-form length
  // bytes (>= 0x80). A Buffer is copied byte for byte, so we pass one.
  certificateOIDs: Record<string, string>;
}

export async function defaultVerifyBundle(
  bundle: Bundle,
  signingIdentity: ProvenanceSigningIdentity
): Promise<void> {
  let verify: (b: unknown, options: SigstoreVerifyOptions) => Promise<unknown>;
  try {
    const sigstore = await import("sigstore");
    verify = sigstore.verify as typeof verify;
  } catch {
    // The tool is not installed — distinct from a bundle that fails to verify.
    throw new SigstoreToolingUnavailableError();
  }
  // sigstore's verify(bundle, dataOrOptions, options) treats a non-Buffer
  // second argument as the options, so the options MUST be passed second.
  // Passing them third silently discards them and enforces nothing.
  await verify(bundle, {
    certificateIssuer: signingIdentity.certificateIssuer,
    certificateOIDs: {
      [FULCIO_SOURCE_REPOSITORY_URI_OID]: encodeDerUtf8String(
        signingIdentity.sourceRepositoryUrl
      ) as unknown as string
    }
  });
}

export function createDefaultProvenanceDependencies(): ProvenanceDependencies {
  return {
    fetchAttestations: defaultFetchAttestations,
    verifyBundle: defaultVerifyBundle
  };
}

/**
 * The publish identity of a single package version, derived from npm's
 * attestation metadata. Used by the continuity check to compare a version
 * against the package's historical baseline. Identity extraction does NOT
 * cryptographically verify the bundle — npm verifies provenance at publish
 * time and binds the repository, so the presence and contents of the
 * attestation are meaningful on their own. This keeps continuity fast and
 * usable even when the optional sigstore package is not installed.
 */
export interface AttestationIdentity {
  hasProvenance: boolean;
  sourceRepository?: string | undefined;
  workflowPath?: string | undefined;
}

export interface FetchAttestationIdentityInput {
  packageName: string;
  version: string;
  registryUrl: string;
  diskCache?: DiskCache | undefined;
  deps?: Pick<ProvenanceDependencies, "fetchAttestations">;
  signal?: AbortSignal | undefined;
}

/**
 * Fetch a single version's attestation from the registry and extract its
 * publish identity (whether it has SLSA provenance, and from which GitHub
 * repository and workflow). Returns `{ hasProvenance: false }` when the
 * version has no attestation or the attestation can't be parsed. Never
 * throws on ordinary failures; re-throws shutdown signals.
 */
export async function fetchAttestationIdentity(
  input: FetchAttestationIdentityInput
): Promise<AttestationIdentity> {
  throwIfAborted(input.signal);
  const fetchAttestations = input.deps?.fetchAttestations ?? defaultFetchAttestations;
  const url = attestationUrl(input.registryUrl, input.packageName, input.version);
  const cacheKey = `${input.registryUrl}|${input.packageName}@${input.version}`;

  let rawResponse: NpmAttestationResponse | null = null;
  const cached = input.diskCache
    ? await input.diskCache.getJson<NpmAttestationResponse>(ATTESTATION_CACHE_NAMESPACE, cacheKey)
    : undefined;
  if (cached) {
    rawResponse = cached;
  } else {
    try {
      rawResponse = await fetchAttestations(url, input.signal);
      if (rawResponse && input.diskCache) {
        await input.diskCache.setJson(ATTESTATION_CACHE_NAMESPACE, cacheKey, rawResponse);
      }
    } catch {
      const shutdownError = getShutdownSignalError(input.signal);
      if (shutdownError) {
        throw shutdownError;
      }
      return { hasProvenance: false };
    }
  }

  if (!rawResponse) {
    return { hasProvenance: false };
  }

  const slsa = (rawResponse.attestations ?? []).find((entry) =>
    entry.predicateType?.startsWith(SLSA_PREDICATE_TYPE_PREFIX)
  );
  if (!slsa?.bundle) {
    return { hasProvenance: false };
  }

  const statement = parseStatement(slsa.bundle);
  const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
  const sourceRepository = extractRepositorySlug(workflow?.repository);
  if (!sourceRepository) {
    // Has an attestation but no usable repository — treat as provenance
    // present but identity unknown.
    return { hasProvenance: true };
  }

  return {
    hasProvenance: true,
    sourceRepository,
    workflowPath: workflow?.path
  };
}

export interface VerifyProvenanceInput {
  packageName: string;
  version: string;
  artifactIntegrity: string | undefined;
  registryUrl: string;
  diskCache: DiskCache;
  config: ProvenanceConfig;
  deps?: ProvenanceDependencies;
  signal?: AbortSignal | undefined;
}

interface ValidatedProvenanceStatement {
  sourceRepository: string;
  sourceRef: string;
  workflowPath: string;
  builderId?: string | undefined;
  signingIdentity: ProvenanceSigningIdentity;
}

function sha512DigestFromIntegrity(integrity: string | undefined): string | undefined {
  const entry = (integrity ?? "").trim();
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry)) {
    return undefined;
  }

  const encoded = entry.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    return undefined;
  }
  return digest.toString("hex");
}

function decodePurlSegment(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("/") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function parseNpmPurl(
  value: string | undefined
): { packageName: string; version: string } | undefined {
  const prefix = "pkg:npm/";
  if (!value?.startsWith(prefix) || value.includes("?") || value.includes("#")) {
    return undefined;
  }

  const identity = value.slice(prefix.length);
  const versionSeparator = identity.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === identity.length - 1) {
    return undefined;
  }

  const packageSegments = identity.slice(0, versionSeparator).split("/");
  const version = decodePurlSegment(identity.slice(versionSeparator + 1));
  if (!version) {
    return undefined;
  }

  if (packageSegments.length === 1) {
    const packageName = decodePurlSegment(packageSegments[0]!);
    if (!packageName || packageName.startsWith("@")) {
      return undefined;
    }
    return { packageName, version };
  }

  if (packageSegments.length === 2) {
    const scope = decodePurlSegment(packageSegments[0]!);
    const name = decodePurlSegment(packageSegments[1]!);
    if (!scope?.startsWith("@") || scope.length === 1 || !name) {
      return undefined;
    }
    return { packageName: `${scope}/${name}`, version };
  }

  return undefined;
}

function validateProvenanceStatement(
  bundle: Bundle,
  statement: Slsa1Statement,
  input: Pick<VerifyProvenanceInput, "packageName" | "version" | "artifactIntegrity">
): ValidatedProvenanceStatement | string {
  if (bundle.dsseEnvelope?.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    return "SLSA bundle has an unexpected DSSE payload type";
  }
  if (statement._type !== IN_TOTO_STATEMENT_V1_TYPE) {
    return "SLSA statement has an unexpected in-toto statement type";
  }
  if (statement.predicateType !== SLSA_V1_PREDICATE_TYPE) {
    return "SLSA statement has an unexpected signed predicate type";
  }

  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    return "SLSA statement must contain exactly one package subject";
  }
  const subject = statement.subject[0]!;
  const subjectIdentity = parseNpmPurl(subject.name);
  if (
    !subjectIdentity ||
    subjectIdentity.packageName !== input.packageName ||
    subjectIdentity.version !== input.version
  ) {
    return `SLSA statement subject does not match ${input.packageName}@${input.version}`;
  }

  const expectedDigest = sha512DigestFromIntegrity(input.artifactIntegrity);
  if (!expectedDigest) {
    return "registry manifest is missing a canonical SHA-512 artifact integrity";
  }
  const subjectDigest = subject.digest?.sha512;
  if (!subjectDigest || !/^[a-fA-F0-9]{128}$/.test(subjectDigest)) {
    return "SLSA statement subject is missing a valid SHA-512 digest";
  }
  if (subjectDigest.toLowerCase() !== expectedDigest) {
    return "SLSA statement subject SHA-512 does not match the registry artifact";
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const sourceRepository = extractRepositorySlug(workflow?.repository);
  if (!sourceRepository) {
    return "SLSA statement is missing a GitHub repository URL";
  }
  const canonicalRepositoryUrl = `${GITHUB_URL_PREFIX}${sourceRepository}`;
  if (
    workflow?.repository !== canonicalRepositoryUrl &&
    workflow?.repository !== `${canonicalRepositoryUrl}.git`
  ) {
    return "SLSA statement has a non-canonical GitHub repository URL";
  }

  const workflowPath = workflow?.path;
  if (
    !workflowPath?.startsWith(GITHUB_WORKFLOW_PATH_PREFIX) ||
    workflowPath === GITHUB_WORKFLOW_PATH_PREFIX ||
    workflowPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "SLSA statement is missing a valid GitHub Actions workflow path";
  }
  const sourceRef = workflow?.ref;
  if (!sourceRef?.startsWith("refs/")) {
    return "SLSA statement is missing a valid GitHub ref";
  }

  return {
    sourceRepository,
    sourceRef,
    workflowPath,
    builderId: statement.predicate?.runDetails?.builder?.id,
    signingIdentity: {
      certificateIssuer: GITHUB_ACTIONS_OIDC_ISSUER,
      sourceRepositoryUrl: canonicalRepositoryUrl
    }
  };
}

/**
 * Fetch the attestation bundle for a package version from the npm registry,
 * bind its signed subject to the resolved registry artifact and GitHub Actions
 * signer, cryptographically verify it via Sigstore, and return a structured
 * verification result.
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

  // No attestation for this version: a registry 404 resolves to null, and the
  // allow-cached fallback above already returned "unreachable" when nothing was
  // cached — so reaching here with no response means missing provenance. The
  // policy layer decides whether that blocks.
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

  const statement = parseStatement(slsa.bundle);
  if (!statement) {
    return {
      status: "invalid",
      error: "could not decode SLSA statement payload from bundle"
    };
  }

  const validatedStatement = validateProvenanceStatement(slsa.bundle, statement, input);
  if (typeof validatedStatement === "string") {
    return { status: "invalid", error: validatedStatement };
  }

  try {
    await deps.verifyBundle(slsa.bundle, validatedStatement.signingIdentity);
  } catch (error) {
    // Missing verification tooling is an environment state, not a verdict on
    // this package: report it distinctly so the policy layer degrades it to a
    // warning instead of blocking every package (the bootstrap deadlock).
    if (error instanceof SigstoreToolingUnavailableError) {
      return {
        status: "tooling-unavailable",
        error: error.message
      };
    }
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    status: "verified",
    sourceRepository: validatedStatement.sourceRepository,
    sourceRef: validatedStatement.sourceRef,
    workflowPath: validatedStatement.workflowPath,
    builderId: validatedStatement.builderId
  };
}
