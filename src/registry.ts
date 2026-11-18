import semver from "semver";

import { DEFAULT_REGISTRY_URL } from "./config";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type {
  InstallLifecycleScriptName,
  PublishTimeSource,
  RequestedPackage,
  ResolvedRegistryPackage
} from "./types";

interface RegistryPackageDocument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryPackageVersionDocument>;
  time?: Record<string, string>;
}

interface RegistryPackageVersionDocument {
  version?: string;
  dist?: {
    tarball?: string;
  };
}

interface RegistryVersionManifest {
  name?: string;
  version?: string;
  scripts?: Partial<Record<InstallLifecycleScriptName, string>>;
  dist?: {
    tarball?: string;
    integrity?: string;
  };
}

const ABBREVIATED_METADATA_HEADER = "application/vnd.npm.install-v1+json";
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;

function encodePackageName(name: string): string {
  // Preserve the leading "@" for scoped packages so the registry URL reads
  // as /@scope%2Fname, then percent-encode every other reserved character.
  return encodeURIComponent(name).replace(/^%40/, "@");
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function createTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS);
}

function cacheKey(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

function parsePublishedAt(packageName: string, version: string, rawValue: string): Date {
  const publishedAt = new Date(rawValue);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new Error(`Registry error: invalid publish time for ${packageName}@${version}.`);
  }

  return publishedAt;
}

interface PublishTimeRecord {
  publishedAt: Date;
  source: PublishTimeSource;
}

export class RegistryClient {
  private readonly registryUrl: string;
  private readonly signal?: AbortSignal | undefined;
  private readonly packageCache = new Map<string, RegistryPackageDocument>();
  private readonly versionCache = new Map<string, RegistryVersionManifest>();
  private readonly publishTimeCache = new Map<string, PublishTimeRecord>();
  private readonly fullMetadataCache = new Map<string, RegistryPackageDocument>();

  constructor(options?: {
    registryUrl?: string;
    /** @deprecated Registry policy metadata is always revalidated online. */
    cacheDir?: string;
    /** @deprecated Registry policy metadata is always revalidated online. */
    cacheTtlMs?: number;
    signal?: AbortSignal | undefined;
  }) {
    this.registryUrl = (options?.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
    this.signal = options?.signal;
  }

  async resolvePackage(requested: RequestedPackage): Promise<ResolvedRegistryPackage> {
    const resolvedVersion =
      requested.registrySpecKind === "version"
        ? requested.requested
        : this.resolveVersion(await this.fetchPackageDocument(requested.name), requested);
    const versionDoc = await this.fetchVersionManifest(requested.name, resolvedVersion);
    if ((versionDoc.name !== undefined && versionDoc.name !== requested.name) ||
        (versionDoc.version !== undefined && versionDoc.version !== resolvedVersion)) {
      throw new Error(`Registry error: manifest identity does not match ${requested.name}@${resolvedVersion}.`);
    }
    const publishTime = await this.fetchPublishedAt(requested.name, resolvedVersion);
    const lifecycleScripts = this.collectLifecycleScripts(versionDoc.scripts);

    return {
      requested,
      resolvedVersion,
      publishedAt: publishTime.publishedAt,
      publishTimeSource: publishTime.source,
      lifecycleScripts,
      ...(typeof versionDoc.dist?.tarball === "string" && typeof versionDoc.dist.integrity === "string"
        ? { artifact: { tarballUrl: versionDoc.dist.tarball, integrity: versionDoc.dist.integrity } }
        : {})
    };
  }

  async getLifecycleScripts(packageName: string, version: string): Promise<InstallLifecycleScriptName[]> {
    try {
      const versionDoc = await this.fetchVersionManifest(packageName, version);
      return this.collectLifecycleScripts(versionDoc.scripts);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return [];
      }

      throw error;
    }
  }

  private async fetchPackageDocument(packageName: string): Promise<RegistryPackageDocument> {
    throwIfAborted(this.signal);

    const cached = this.packageCache.get(packageName);
    if (cached) {
      return cached;
    }

    const document = await this.fetchJson<RegistryPackageDocument>(
      `${this.registryUrl}/${encodePackageName(packageName)}`,
      packageName,
      {
        headers: {
          Accept: ABBREVIATED_METADATA_HEADER
        }
      }
    );

    this.packageCache.set(packageName, document);
    return document;
  }

  private async fetchVersionManifest(
    packageName: string,
    version: string
  ): Promise<RegistryVersionManifest> {
    throwIfAborted(this.signal);

    const versionKey = cacheKey(packageName, version);
    const cached = this.versionCache.get(versionKey);
    if (cached) {
      return cached;
    }

    // Registry manifests supply lifecycle scripts and artifact identity, so
    // only a fresh registry observation may populate the in-process cache.
    const manifest = await this.fetchJson<RegistryVersionManifest>(
      `${this.registryUrl}/${encodePackageName(packageName)}/${encodeURIComponent(version)}`,
      `${packageName}@${version}`
    );

    this.versionCache.set(versionKey, manifest);
    return manifest;
  }

  private async fetchPublishedAt(
    packageName: string,
    version: string
  ): Promise<PublishTimeRecord> {
    throwIfAborted(this.signal);

    const versionKey = cacheKey(packageName, version);
    const cached = this.publishTimeCache.get(versionKey);
    if (cached) {
      return cached;
    }

    // Publish time is a policy fact. Process-external cache contents are not
    // authenticated, so revalidate it against the selected registry.
    // The registry time map is the authoritative publish record (RFC-001 §14
    // D7). The tarball last-modified header is a mutable CDN artifact; it is a
    // same-origin-only fallback and the answering source is recorded.
    const fromTimeMap = await this.fetchPublishedAtFromTimeMap(packageName, version);
    if (fromTimeMap) {
      return this.rememberPublishedAt(versionKey, fromTimeMap, "registry-time");
    }

    // Fallback only for a tarball served by the configured registry itself.
    // dist.tarball is registry-controlled metadata; requesting an arbitrary
    // origin from it would let a hostile packument aim a request at internal
    // hosts. Otherwise publish time stays unknown and resolution fails closed.
    const tarballUrl = (await this.fetchVersionManifest(packageName, version)).dist?.tarball;
    if (tarballUrl && this.isSameOriginAsRegistry(tarballUrl)) {
      const lastModified = await this.fetchTarballLastModified(packageName, version, tarballUrl);
      if (lastModified) {
        return this.rememberPublishedAt(
          versionKey,
          parsePublishedAt(packageName, version, lastModified),
          "tarball-last-modified"
        );
      }
    }

    throw new Error(`Registry error: missing publish time for ${packageName}@${version}.`);
  }

  private rememberPublishedAt(
    versionKey: string,
    publishedAt: Date,
    source: PublishTimeSource
  ): PublishTimeRecord {
    const record: PublishTimeRecord = { publishedAt, source };
    this.publishTimeCache.set(versionKey, record);
    return record;
  }

  private isSameOriginAsRegistry(tarballUrl: string): boolean {
    try {
      const tarball = new URL(tarballUrl);
      return !tarball.username && !tarball.password && tarball.origin === new URL(this.registryUrl).origin;
    } catch {
      return false;
    }
  }

  private async fetchTarballLastModified(
    packageName: string,
    version: string,
    tarballUrl: string
  ): Promise<string | undefined> {
    try {
      // "manual": a redirect would leave the registry origin; treat it as no answer.
      const response = await fetch(tarballUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: this.fetchSignal()
      });

      if (!response.ok) {
        return undefined;
      }

      return response.headers.get("last-modified") ?? undefined;
    } catch (error) {
      const shutdownError = getShutdownSignalError(this.signal);
      if (shutdownError) {
        throw shutdownError;
      }

      if (isTimeoutError(error)) {
        throw new Error(
          `Registry error: timed out while fetching tarball metadata for ${packageName}@${version}.`
        );
      }

      return undefined;
    }
  }

  /**
   * Publish time from the full packument's `time` map, or undefined so the
   * caller can try the same-origin tarball fallback or fail closed. Timeouts and shutdowns stay fatal (they are
   * environment failures, not evidence the map is absent); other fetch
   * errors are reported as missing authoritative publish-time evidence.
   */
  private async fetchPublishedAtFromTimeMap(packageName: string, version: string): Promise<Date | undefined> {
    let document: RegistryPackageDocument;
    try {
      document = await this.fetchFullPackageDocument(packageName);
    } catch (error) {
      const shutdownError = getShutdownSignalError(this.signal);
      if (shutdownError) {
        throw shutdownError;
      }
      if (error instanceof Error && error.message.includes("timed out")) {
        throw error;
      }
      return undefined;
    }

    const publishedAtRaw = document.time?.[version];
    if (!publishedAtRaw) {
      return undefined;
    }

    return parsePublishedAt(packageName, version, publishedAtRaw);
  }

  private async fetchFullPackageDocument(packageName: string): Promise<RegistryPackageDocument> {
    const cached = this.fullMetadataCache.get(packageName);
    if (cached) {
      return cached;
    }

    const document = await this.fetchJson<RegistryPackageDocument>(
      `${this.registryUrl}/${encodePackageName(packageName)}`,
      packageName
    );

    this.fullMetadataCache.set(packageName, document);
    return document;
  }

  private async fetchJson<TResponse>(
    url: string,
    packageLabel: string,
    init?: RequestInit
  ): Promise<TResponse> {
    try {
      // "manual": an answer has to come from the configured registry. A
      // redirect would let it send the request anywhere, so it counts as a
      // failed fetch (status 3xx below).
      const response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: this.fetchSignal()
      });

      if (!response.ok) {
        throw new Error(`Registry error: could not fetch ${packageLabel} (${response.status}).`);
      }

      return (await response.json()) as TResponse;
    } catch (error) {
      const shutdownError = getShutdownSignalError(this.signal);
      if (shutdownError) {
        throw shutdownError;
      }

      if (isTimeoutError(error)) {
        throw new Error(`Registry error: timed out while fetching ${packageLabel}.`);
      }

      throw error;
    }
  }

  private fetchSignal(): AbortSignal {
    return this.signal ? AbortSignal.any([this.signal, createTimeoutSignal()]) : createTimeoutSignal();
  }

  private resolveVersion(document: RegistryPackageDocument, requested: RequestedPackage): string {
    const versions = Object.keys(document.versions ?? {});
    if (versions.length === 0) {
      throw new Error(`Registry error: package ${requested.name} has no published versions.`);
    }

    if (!requested.registrySpecKind) {
      const resolved = document["dist-tags"]?.latest ?? semver.rsort(versions)[0];
      if (resolved === undefined) {
        // Invariant: versions is non-empty (checked above) and semver.rsort throws
        // on invalid input rather than dropping entries, so rsort(versions)[0] is
        // always present when no dist-tag latest exists.
        throw new Error(`Registry error: could not resolve a version for ${requested.name}.`);
      }
      return resolved;
    }

    if (requested.registrySpecKind === "version") {
      if (!document.versions?.[requested.requested]) {
        throw new Error(`Package ${requested.name} does not have version ${requested.requested}.`);
      }

      return requested.requested;
    }

    if (requested.registrySpecKind === "tag") {
      const version = document["dist-tags"]?.[requested.requested];
      if (!version) {
        throw new Error(`Package ${requested.name} does not have dist-tag "${requested.requested}".`);
      }

      return version;
    }

    const resolved = semver.maxSatisfying(versions, requested.requested, {
      includePrerelease: requested.requested.includes("-")
    });

    if (!resolved) {
      throw new Error(`Package ${requested.name} has no version matching "${requested.requested}".`);
    }

    return resolved;
  }

  private collectLifecycleScripts(
    scripts: RegistryVersionManifest["scripts"]
  ): InstallLifecycleScriptName[] {
    const lifecycleNames: InstallLifecycleScriptName[] = ["preinstall", "install", "postinstall"];
    return lifecycleNames.filter((scriptName) => Boolean(scripts?.[scriptName]));
  }

  private isNotFoundError(error: unknown): boolean {
    return error instanceof Error && /\(404\)\.$/.test(error.message);
  }
}
