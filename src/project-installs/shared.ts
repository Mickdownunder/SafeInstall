import type { RequestedPackage, SourceType } from "../types";

export function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function isTarballLike(value: string): boolean {
  return value.endsWith(".tgz") || value.endsWith(".tar.gz");
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
      (hasIntegrity || resolvedReference.includes("registry.npmjs.org") || resolvedReference.includes("registry.yarnpkg.com"))
    ) {
      return "registry";
    }

    return isTarballLike(resolvedReference) ? "tarball" : "url";
  }

  return declaredSourceType === "unknown" ? "unknown" : declaredSourceType;
}
