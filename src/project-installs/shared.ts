import type { RequestedPackage, SourceType } from "../types";

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isTarballLike(value: string): boolean {
  return value.endsWith(".tgz") || value.endsWith(".tar.gz");
}

const PUBLIC_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

function isPublicRegistryUrl(value: string): boolean {
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * True when `value` is served by the configured registry: same origin and,
 * if the registry URL has a non-root path, a path under that prefix.
 */
export function isConfiguredRegistryUrl(value: string, registryUrl: string | undefined): boolean {
  if (!registryUrl) {
    return false;
  }
  try {
    const candidate = new URL(value);
    const registry = new URL(registryUrl);
    if (candidate.origin !== registry.origin) {
      return false;
    }
    const prefix = registry.pathname.endsWith("/") ? registry.pathname : `${registry.pathname}/`;
    if (prefix === "/") {
      return true;
    }
    return candidate.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

export function extractSemverPrefix(value: string): string | undefined {
  const match = value.match(/^(\d+\.\d+\.\d+(?:[-+][^()\s]+)?)/);
  return match?.[1];
}

export function createRegistryRequestedPackage(name: string, version: string): RequestedPackage {
  return {
    name,
    raw: `${name}@${version}`,
    requested: version,
    sourceType: "registry",
    registrySpecKind: "version"
  };
}

export function createNonRegistryRequestedPackage(
  name: string,
  manifestSpec: string,
  sourceType: SourceType,
  requested?: string
): RequestedPackage {
  return {
    name,
    raw: `${name}@${manifestSpec}`,
    requested: requested ?? manifestSpec,
    sourceType
  };
}

export function classifyResolvedSource(
  declaredSourceType: SourceType,
  resolvedReference?: string,
  hasIntegrity?: boolean,
  registryUrl?: string
): SourceType {
  if (declaredSourceType !== "unknown" && declaredSourceType !== "registry") {
    return declaredSourceType;
  }

  if (!resolvedReference) {
    return declaredSourceType === "unknown" ? "registry" : declaredSourceType;
  }

  if (
    resolvedReference.startsWith("git+") ||
    resolvedReference.startsWith("git@") ||
    resolvedReference.includes("github.com:")
  ) {
    return "git";
  }

  if (resolvedReference.startsWith("link:")) {
    return "workspace";
  }

  if (resolvedReference.startsWith("file:")) {
    return "file";
  }

  if (isHttpUrl(resolvedReference)) {
    // Integrity alone is not registry provenance. Direct npm/pnpm targets
    // may remain registry candidates here only because every production
    // consumer binds their URL and SHA-512 to fresh registry metadata before
    // check, authorization, or install can succeed. Transitive callers omit
    // hasIntegrity because they have no equivalent artifact binding; they
    // accept only public registries and the configured registry URL.
    if (
      declaredSourceType === "registry" &&
      (hasIntegrity ||
        isPublicRegistryUrl(resolvedReference) ||
        isConfiguredRegistryUrl(resolvedReference, registryUrl))
    ) {
      return "registry";
    }

    return isTarballLike(resolvedReference) ? "tarball" : "url";
  }

  return declaredSourceType === "unknown" ? "unknown" : declaredSourceType;
}
