import semver from "semver";

import { DEFAULT_REGISTRY_URL } from "./config";
import { DiskCache } from "./disk-cache";
import { getShutdownSignalError, throwIfAborted } from "./signals";
import type {
  InstallLifecycleScriptName,
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
  version?: string;
  scripts?: Partial<Record<InstallLifecycleScriptName, string>>;
  dist?: {
    tarball?: string;
  };
}

const ABBREVIATED_METADATA_HEADER = "application/vnd.npm.install-v1+json";
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
const REGISTRY_DISK_CACHE_TTL_MS = 60 * 60 * 1000;
const VERSION_MANIFEST_CACHE_NAMESPACE = "registry-version-manifests-v1";
const PUBLISH_TIME_CACHE_NAMESPACE = "registry-publish-times-v1";

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

function scopedCacheKey(registryUrl: string, packageName: string, version: string): string {
  return `${registryUrl}|${cacheKey(packageName, version)}`;
}

function parsePublishedAt(packageName: string, version: string, rawValue: string): Date {
  const publishedAt = new Date(rawValue);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new Error(`Registry error: invalid publish time for ${packageName}@${version}.`);
  }

  return publishedAt;
}

export class RegistryClient {
  private readonly registryUrl: string;
  private readonly diskCache: DiskCache;
  private readonly signal?: AbortSignal;
  private readonly packageCache = new Map<string, RegistryPackageDocument>();
  private readonly versionCache = new Map<string, RegistryVersionManifest>();
  private readonly publishTimeCache = new Map<string, Date>();
  private readonly fullMetadataCache = new Map<string, RegistryPackageDocument>();

  constructor(options?: {
    registryUrl?: string;
    cacheDir?: string;
    cacheTtlMs?: number;
    signal?: AbortSignal;
  }) {
    this.registryUrl = (options?.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
    this.diskCache = new DiskCache({
      cacheDir: options?.cacheDir,
      ttlMs: options?.cacheTtlMs ?? REGISTRY_DISK_CACHE_TTL_MS
    });
    this.signal = options?.signal;
  }

  async resolvePackage(requested: RequestedPackage): Promise<ResolvedRegistryPackage> {
    const resolvedVersion =
      requested.registrySpecKind === "version"
        ? requested.requested
        : this.resolveVersion(await this.fetchPackageDocument(requested.name), requested);
    const versionDoc = await this.fetchVersionManifest(requested.name, resolvedVersion);
    const publishedAt = await this.fetchPublishedAt(requested.name, resolvedVersion, versionDoc);
    const lifecycleScripts = this.collectLifecycleScripts(versionDoc.scripts);

    return {
      requested,
      resolvedVersion,
      publishedAt,
      lifecycleScripts
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

    const persistentKey = scopedCacheKey(this.registryUrl, packageName, version);
    const cachedFromDisk = await this.diskCache.getJson<RegistryVersionManifest>(
      VERSION_MANIFEST_CACHE_NAMESPACE,
      persistentKey
    );
    if (cachedFromDisk) {
      this.versionCache.set(versionKey, cachedFromDisk);
      return cachedFromDisk;
    }

    const manifest = await this.fetchJson<RegistryVersionManifest>(
      `${this.registryUrl}/${encodePackageName(packageName)}/${encodeURIComponent(version)}`,
      `${packageName}@${version}`
    );

    this.versionCache.set(versionKey, manifest);
    await this.diskCache.setJson(VERSION_MANIFEST_CACHE_NAMESPACE, persistentKey, manifest);
    return manifest;
  }

  private async fetchPublishedAt(
    packageName: string,
    version: string,
    versionDoc: RegistryVersionManifest
  ): Promise<Date> {
    throwIfAborted(this.signal);

    const versionKey = cacheKey(packageName, version);
    const cached = this.publishTimeCache.get(versionKey);
    if (cached) {
      return cached;
    }

    const persistentKey = scopedCacheKey(this.registryUrl, packageName, version);
    const cachedFromDisk = await this.diskCache.getJson<string>(PUBLISH_TIME_CACHE_NAMESPACE, persistentKey);
    if (cachedFromDisk) {
      const publishedAt = parsePublishedAt(packageName, version, cachedFromDisk);
      this.publishTimeCache.set(versionKey, publishedAt);
      return publishedAt;
    }

    const tarballUrl = versionDoc.dist?.tarball;
    if (tarballUrl) {
      const lastModified = await this.fetchTarballLastModified(packageName, version, tarballUrl);
      if (lastModified) {
        const publishedAt = parsePublishedAt(packageName, version, lastModified);
        this.publishTimeCache.set(versionKey, publishedAt);
        await this.diskCache.setJson(PUBLISH_TIME_CACHE_NAMESPACE, persistentKey, publishedAt.toISOString());
        return publishedAt;
      }
    }

    const publishedAt = await this.fetchPublishedAtFromFullMetadata(packageName, version);
    this.publishTimeCache.set(versionKey, publishedAt);
    await this.diskCache.setJson(PUBLISH_TIME_CACHE_NAMESPACE, persistentKey, publishedAt.toISOString());
    return publishedAt;
  }

  private async fetchTarballLastModified(
    packageName: string,
    version: string,
    tarballUrl: string
  ): Promise<string | undefined> {
    try {
      const response = await fetch(tarballUrl, {
        method: "HEAD",
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

  private async fetchPublishedAtFromFullMetadata(packageName: string, version: string): Promise<Date> {
    const document = await this.fetchFullPackageDocument(packageName);
    const publishedAtRaw = document.time?.[version];
    if (!publishedAtRaw) {
      throw new Error(`Registry error: missing publish time for ${packageName}@${version}.`);
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
      const response = await fetch(url, {
        ...init,
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
      return document["dist-tags"]?.latest ?? semver.rsort(versions)[0];
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
