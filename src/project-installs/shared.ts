import type { RequestedPackage, SourceType } from "../types";

export function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
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
  hasIntegrity?: boolean
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
    if (
      declaredSourceType === "registry" &&
      (hasIntegrity || isPublicRegistryUrl(resolvedReference))
    ) {
      return "registry";
    }

    return isTarballLike(resolvedReference) ? "tarball" : "url";
  }

  return declaredSourceType === "unknown" ? "unknown" : declaredSourceType;
}
