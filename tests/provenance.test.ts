import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiskCache } from "../src/disk-cache";
import {
  attestationUrl,
  extractRepositorySlug,
  isProvenanceRequired,
  lookupGlobPattern,
  matchesGlob,
  repositoryMatchesPublisher,
  verifyProvenance
} from "../src/provenance";
import type { Bundle, ProvenanceDependencies } from "../src/provenance";
import type { ProvenanceConfig } from "../src/types";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

function createConfig(overrides: Partial<ProvenanceConfig> = {}): ProvenanceConfig {
  return {
    mode: "require",
    requireFor: [],
    trustedPublishers: {},
    offlineBehavior: "fail-closed",
    ...overrides
  };
}

function makeBundleWithStatement(statement: unknown): Bundle {
  const payload = Buffer.from(JSON.stringify(statement), "utf8").toString("base64");
  return {
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
    dsseEnvelope: {
      payload,
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "fake-signature" }]
    }
  } as unknown as Bundle;
}

function createDeps(overrides: Partial<ProvenanceDependencies> = {}): ProvenanceDependencies {
  return {
    fetchAttestations: async () => null,
    verifyBundle: async () => {},
    ...overrides
  };
}

const exampleStatement = {
  _type: "https://in-toto.io/Statement/v1",
  predicateType: "https://slsa.dev/provenance/v1",
  subject: [
    {
      name: "pkg:npm/axios@1.14.0",
      digest: { sha512: "abc123" }
    }
  ],
  predicate: {
    buildDefinition: {
      externalParameters: {
        workflow: {
          repository: "https://github.com/axios/axios",
          ref: "refs/tags/v1.14.0",
          path: ".github/workflows/release.yml"
        }
      }
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" }
    }
  }
};

describe("attestationUrl", () => {
  it("builds the npm attestations endpoint URL for an unscoped package", () => {
    expect(attestationUrl("https://registry.npmjs.org", "axios", "1.14.0")).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/axios@1.14.0"
    );
  });

  it("builds the attestations URL for a scoped package with the scope preserved", () => {
    expect(attestationUrl("https://registry.npmjs.org", "@sigstore/verify", "3.1.0")).toBe(
      "https://registry.npmjs.org/-/npm/v1/attestations/@sigstore%2Fverify@3.1.0"
    );
  });

  it("strips trailing slashes from the registry URL", () => {
    expect(attestationUrl("https://mirror.example.com/npm/", "axios", "1.14.0")).toBe(
      "https://mirror.example.com/npm/-/npm/v1/attestations/axios@1.14.0"
    );
  });
});

describe("matchesGlob", () => {
  it("matches exact strings", () => {
    expect(matchesGlob("axios", "axios")).toBe(true);
  });

  it("does not match different strings without wildcards", () => {
    expect(matchesGlob("axios", "axiosx")).toBe(false);
  });

  it("matches with a trailing wildcard", () => {
    expect(matchesGlob("@acme/*", "@acme/widgets")).toBe(true);
    expect(matchesGlob("@acme/*", "@other/widgets")).toBe(false);
  });

  it("matches with a leading wildcard", () => {
    expect(matchesGlob("*/widgets", "acme/widgets")).toBe(true);
    expect(matchesGlob("*/widgets", "acme/tools")).toBe(false);
  });

  it("matches with a middle wildcard", () => {
    expect(matchesGlob("acme/*/widgets", "acme/v2/widgets")).toBe(true);
  });

  it("escapes regex metacharacters in the pattern", () => {
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("a.b", "axb")).toBe(false);
  });
});

describe("lookupGlobPattern", () => {
  it("returns undefined when no pattern matches", () => {
    expect(lookupGlobPattern({ axios: "axios/axios" }, "lodash")).toBeUndefined();
  });

  it("returns the exact match when available", () => {
    expect(lookupGlobPattern({ axios: "axios/axios" }, "axios")).toBe("axios/axios");
  });

  it("returns the first matching glob pattern", () => {
    const map = { "@acme/*": "acme/*" };
    expect(lookupGlobPattern(map, "@acme/widgets")).toBe("acme/*");
  });
});

describe("extractRepositorySlug", () => {
  it("extracts owner/repo from a GitHub HTTPS URL", () => {
    expect(extractRepositorySlug("https://github.com/axios/axios")).toBe("axios/axios");
  });

  it("extracts from a URL with a .git suffix", () => {
    expect(extractRepositorySlug("https://github.com/axios/axios.git")).toBe("axios/axios");
  });

  it("returns undefined for non-GitHub URLs", () => {
    expect(extractRepositorySlug("https://gitlab.com/axios/axios")).toBeUndefined();
  });

  it("returns undefined for empty or malformed URLs", () => {
    expect(extractRepositorySlug(undefined)).toBeUndefined();
    expect(extractRepositorySlug("")).toBeUndefined();
    expect(extractRepositorySlug("https://github.com/")).toBeUndefined();
  });
});

describe("isProvenanceRequired", () => {
  it("returns true when mode is require", () => {
    expect(isProvenanceRequired(createConfig({ mode: "require" }), "anything")).toBe(true);
  });

  it("returns false when mode is off", () => {
    expect(isProvenanceRequired(createConfig({ mode: "off" }), "anything")).toBe(false);
  });

  it("returns true for packages matching the requireFor glob list in warn mode", () => {
    expect(
      isProvenanceRequired(createConfig({ mode: "warn", requireFor: ["axios"] }), "axios")
    ).toBe(true);
    expect(
      isProvenanceRequired(createConfig({ mode: "warn", requireFor: ["@acme/*"] }), "@acme/widgets")
    ).toBe(true);
  });

  it("returns false in warn mode for packages not in requireFor", () => {
    expect(
      isProvenanceRequired(createConfig({ mode: "warn", requireFor: ["axios"] }), "lodash")
    ).toBe(false);
  });
});

describe("repositoryMatchesPublisher", () => {
  it("matches exact slug", () => {
    expect(repositoryMatchesPublisher("axios/axios", "axios/axios")).toBe(true);
  });

  it("matches glob pattern", () => {
    expect(repositoryMatchesPublisher("acme/tools", "acme/*")).toBe(true);
    expect(repositoryMatchesPublisher("other/tools", "acme/*")).toBe(false);
  });
});

describe("verifyProvenance", () => {
  it("returns missing when npm has no attestations (404)", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "lodash",
      version: "4.17.21",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({ fetchAttestations: async () => null })
    });

    expect(result.status).toBe("missing");
  });

  it("returns missing when the response contains no SLSA attestation", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
              bundle: makeBundleWithStatement({})
            }
          ]
        })
      })
    });

    expect(result.status).toBe("missing");
  });

  it("returns verified with extracted source repository on a valid attestation", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: makeBundleWithStatement(exampleStatement)
            }
          ]
        }),
        verifyBundle: async () => {}
      })
    });

    expect(result.status).toBe("verified");
    expect(result.sourceRepository).toBe("axios/axios");
    expect(result.sourceRef).toBe("refs/tags/v1.14.0");
    expect(result.workflowPath).toBe(".github/workflows/release.yml");
  });

  it("returns invalid when the bundle verification throws", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: makeBundleWithStatement(exampleStatement)
            }
          ]
        }),
        verifyBundle: async () => {
          throw new Error("signature mismatch");
        }
      })
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("signature mismatch");
  });

  it("returns invalid when the SLSA statement has no repository URL", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: makeBundleWithStatement({
                ...exampleStatement,
                predicate: {
                  buildDefinition: { externalParameters: {} }
                }
              })
            }
          ]
        })
      })
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("missing a GitHub repository");
  });

  it("returns unreachable on a fetch failure with offlineBehavior fail-closed", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig({ offlineBehavior: "fail-closed" }),
      deps: createDeps({
        fetchAttestations: async () => {
          throw new Error("network down");
        }
      })
    });

    expect(result.status).toBe("unreachable");
    expect(result.error).toContain("network down");
  });

  it("falls back to cached attestation on fetch failure when offlineBehavior is allow-cached", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const diskCache = new DiskCache({ cacheDir, ttlMs: 60_000 });

    // Populate the cache with a successful prior fetch
    await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache,
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: makeBundleWithStatement(exampleStatement)
            }
          ]
        })
      })
    });

    // Now a failing fetch should fall back to the cached result
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache,
      config: createConfig({ offlineBehavior: "allow-cached" }),
      deps: createDeps({
        fetchAttestations: async () => {
          throw new Error("network down");
        }
      })
    });

    expect(result.status).toBe("verified");
    expect(result.sourceRepository).toBe("axios/axios");
  });

  it("returns invalid with a clear message when verifyBundle throws because sigstore is missing", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
      config: createConfig(),
      deps: createDeps({
        fetchAttestations: async () => ({
          attestations: [
            {
              predicateType: "https://slsa.dev/provenance/v1",
              bundle: makeBundleWithStatement(exampleStatement)
            }
          ]
        }),
        verifyBundle: async () => {
          throw new Error(
            "Sigstore provenance verification requires the optional 'sigstore' package. " +
              "Install it with: npm install sigstore"
          );
        }
      })
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("sigstore");
    expect(result.error).toContain("npm install");
  });
});
