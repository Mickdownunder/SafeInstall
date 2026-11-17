import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiskCache } from "../src/disk-cache";
import {
  attestationUrl,
  encodeDerUtf8String,
  extractRepositorySlug,
  fetchAttestationIdentity,
  isProvenanceRequired,
  lookupGlobPattern,
  matchesGlob,
  repositoryMatchesPublisher,
  SigstoreToolingUnavailableError,
  verifyProvenance
} from "../src/provenance";
import type { Bundle, ProvenanceDependencies } from "../src/provenance";
import type { ProvenanceConfig } from "../src/types";

const tempDirs: string[] = [];
const EXAMPLE_DIGEST = Buffer.alloc(64, 7);
const EXAMPLE_INTEGRITY = `sha512-${EXAMPLE_DIGEST.toString("base64")}`;
const EXAMPLE_SHA512 = EXAMPLE_DIGEST.toString("hex");

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
    toolingUnavailable: "warn",
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
      digest: { sha512: EXAMPLE_SHA512 }
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

async function verifyStatement(
  statement: unknown,
  options: {
    packageName?: string;
    version?: string;
    artifactIntegrity?: string;
    verifyBundle?: ProvenanceDependencies["verifyBundle"];
  } = {}
) {
  const cacheDir = await createTempDir("safeinstall-provenance-");
  return verifyProvenance({
    packageName: options.packageName ?? "axios",
    version: options.version ?? "1.14.0",
    artifactIntegrity: options.artifactIntegrity ?? EXAMPLE_INTEGRITY,
    registryUrl: "https://registry.npmjs.org",
    diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
    config: createConfig(),
    deps: createDeps({
      fetchAttestations: async () => ({
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: makeBundleWithStatement(statement)
          }
        ]
      }),
      verifyBundle: options.verifyBundle ?? (async () => {})
    })
  });
}

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

describe("fetchAttestationIdentity", () => {
  it("fetches continuity identity instead of trusting a planted disk response", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-identity-");
    const diskCache = new DiskCache({ cacheDir, ttlMs: 60_000 });
    const cacheKey = "https://registry.npmjs.org|axios@1.14.0";
    await diskCache.setJson("registry-attestations-v1", cacheKey, {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: makeBundleWithStatement({
            ...exampleStatement,
            predicate: {
              ...exampleStatement.predicate,
              buildDefinition: {
                externalParameters: {
                  workflow: {
                    repository: "https://github.com/attacker/axios",
                    path: ".github/workflows/release.yml"
                  }
                }
              }
            }
          })
        }
      ]
    });
    const fetchAttestations = vi.fn().mockResolvedValue({
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: makeBundleWithStatement(exampleStatement)
        }
      ]
    });

    const identity = await fetchAttestationIdentity({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache,
      deps: { fetchAttestations }
    });

    expect(identity.sourceRepository).toBe("axios/axios");
    expect(fetchAttestations).toHaveBeenCalledTimes(1);
  });

  it("propagates registry failures so continuity can remain unevaluated", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-identity-");

    await expect(
      fetchAttestationIdentity({
        packageName: "axios",
        version: "1.14.0",
        registryUrl: "https://registry.npmjs.org",
        diskCache: new DiskCache({ cacheDir, ttlMs: 60_000 }),
        deps: {
          fetchAttestations: async () => {
            throw new Error("registry unavailable");
          }
        }
      })
    ).rejects.toThrow("registry unavailable");
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
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
    let signingIdentity: Parameters<ProvenanceDependencies["verifyBundle"]>[1] | undefined;
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
        verifyBundle: async (_bundle, expectedIdentity) => {
          signingIdentity = expectedIdentity;
        }
      })
    });

    expect(result.status).toBe("verified");
    expect(result.sourceRepository).toBe("axios/axios");
    expect(result.sourceRef).toBe("refs/tags/v1.14.0");
    expect(result.workflowPath).toBe(".github/workflows/release.yml");
    expect(signingIdentity).toEqual({
      certificateIssuer: "https://token.actions.githubusercontent.com",
      sourceRepositoryUrl: "https://github.com/axios/axios"
    });
  });

  it("returns invalid when the signed subject names a different package", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      subject: [{ ...exampleStatement.subject[0], name: "pkg:npm/lodash@1.14.0" }]
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("subject does not match axios@1.14.0");
  });

  it("returns invalid for a replayed bundle signed for an older version", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      subject: [{ ...exampleStatement.subject[0], name: "pkg:npm/axios@1.13.0" }]
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("subject does not match axios@1.14.0");
  });

  it("returns invalid when the signed SHA-512 differs from the registry artifact", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      subject: [{ ...exampleStatement.subject[0], digest: { sha512: "0".repeat(128) } }]
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("SHA-512 does not match the registry artifact");
  });

  it("returns invalid when the registry artifact has no canonical SHA-512 integrity", async () => {
    const result = await verifyStatement(exampleStatement, {
      artifactIntegrity: "sha512-not-a-canonical-digest"
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("missing a canonical SHA-512 artifact integrity");
  });

  it("returns invalid when the signed predicate type is not SLSA v1", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      predicateType: "https://slsa.dev/provenance/v0.2"
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("unexpected signed predicate type");
  });

  it("returns invalid when the signed statement is not in-toto v1", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      _type: "https://in-toto.io/Statement/v0.1"
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("unexpected in-toto statement type");
  });

  it("returns invalid when multiple subjects make the artifact binding ambiguous", async () => {
    const result = await verifyStatement({
      ...exampleStatement,
      subject: [
        exampleStatement.subject[0],
        { name: "pkg:npm/lodash@4.17.21", digest: { sha512: EXAMPLE_SHA512 } }
      ]
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("exactly one package subject");
  });

  it.each([
    ["a null subject", { subject: [null] }],
    ["a non-string subject name", { subject: [{ name: 42, digest: { sha512: EXAMPLE_SHA512 } }] }],
    ["a non-object workflow", { predicate: { buildDefinition: { externalParameters: { workflow: 7 } } } }],
    ["a null predicate", { predicate: null }]
  ])("returns invalid instead of throwing for %s", async (_label, override) => {
    const result = await verifyStatement({ ...exampleStatement, ...override } as unknown as typeof exampleStatement);

    expect(result.status).toBe("invalid");
  });

  it("binds the claimed repository to the certificate source repository", async () => {
    let signingIdentity: Parameters<ProvenanceDependencies["verifyBundle"]>[1] | undefined;
    const actualSourceRepository = "https://github.com/axios/axios";
    const result = await verifyStatement(
      {
        ...exampleStatement,
        predicate: {
          ...exampleStatement.predicate,
          buildDefinition: {
            ...exampleStatement.predicate.buildDefinition,
            externalParameters: {
              workflow: {
                ...exampleStatement.predicate.buildDefinition.externalParameters.workflow,
                repository: "https://github.com/attacker/axios"
              }
            }
          }
        }
      },
      {
        verifyBundle: async (_bundle, expectedIdentity) => {
          signingIdentity = expectedIdentity;
          if (expectedIdentity.sourceRepositoryUrl !== actualSourceRepository) {
            throw new Error("certificate source repository mismatch");
          }
        }
      }
    );

    expect(signingIdentity?.sourceRepositoryUrl).toBe("https://github.com/attacker/axios");
    expect(result.status).toBe("invalid");
    expect(result.error).toContain("certificate source repository mismatch");
  });

  it("accepts the normalized npm PURL for a scoped package", async () => {
    const result = await verifyStatement(
      {
        ...exampleStatement,
        subject: [
          {
            name: "pkg:npm/%40acme/widget@2.0.0",
            digest: { sha512: EXAMPLE_SHA512 }
          }
        ]
      },
      { packageName: "@acme/widget", version: "2.0.0" }
    );

    expect(result.status).toBe("verified");
  });

  it("returns invalid when the bundle verification throws", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      artifactIntegrity: EXAMPLE_INTEGRITY,
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

  it("returns tooling-unavailable (not invalid) when the sigstore tool is absent", async () => {
    // A missing verification tool is an environment state, not a verdict on
    // the package — it must be distinguishable from a bundle that fails to
    // verify, so the policy layer can degrade it instead of blocking.
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
          throw new SigstoreToolingUnavailableError();
        }
      })
    });

    expect(result.status).toBe("tooling-unavailable");
    expect(result.status).not.toBe("invalid");
    expect(result.error).toContain("sigstore");
  });

  it("returns invalid when the SLSA statement has no repository URL", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
      artifactIntegrity: EXAMPLE_INTEGRITY,
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
      artifactIntegrity: EXAMPLE_INTEGRITY,
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

  it("rejects a cached attestation whose signed subject names another package", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const diskCache = new DiskCache({ cacheDir, ttlMs: 60_000 });
    await diskCache.setJson(
      "registry-attestations-v1",
      "https://registry.npmjs.org|axios@1.14.0",
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: makeBundleWithStatement({
              ...exampleStatement,
              subject: [{ name: "pkg:npm/lodash@4.17.21", digest: { sha512: "attacker" } }]
            })
          }
        ]
      }
    );

    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      registryUrl: "https://registry.npmjs.org",
      diskCache,
      artifactIntegrity: EXAMPLE_INTEGRITY,
      config: createConfig({ offlineBehavior: "allow-cached" }),
      deps: createDeps({
        fetchAttestations: async () => {
          throw new Error("network down");
        },
        verifyBundle: async () => {}
      })
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("subject does not match axios@1.14.0");
  });

  it("returns invalid with a clear message when verifyBundle throws because sigstore is missing", async () => {
    const cacheDir = await createTempDir("safeinstall-provenance-");
    const result = await verifyProvenance({
      packageName: "axios",
      version: "1.14.0",
      artifactIntegrity: EXAMPLE_INTEGRITY,
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

describe("encodeDerUtf8String", () => {
  it("uses the short length form below 128 bytes", () => {
    const url = "https://github.com/axios/axios";
    const der = encodeDerUtf8String(url);
    expect([...der.subarray(0, 2)]).toEqual([0x0c, url.length]);
    expect(der.subarray(2).toString("utf8")).toBe(url);
    expect(der.length).toBe(url.length + 2);
  });

  it("uses the 0x81 long length form for 128 to 255 bytes", () => {
    const url = "https://github.com/o/" + "r".repeat(200);
    const der = encodeDerUtf8String(url);
    expect([...der.subarray(0, 3)]).toEqual([0x0c, 0x81, url.length]);
    expect(der.subarray(3).toString("utf8")).toBe(url);
  });

  it("uses the 0x82 long length form above 255 bytes", () => {
    const url = "https://github.com/o/" + "r".repeat(300);
    const der = encodeDerUtf8String(url);
    expect([...der.subarray(0, 4)]).toEqual([0x0c, 0x82, url.length >> 8, url.length & 0xff]);
    expect(der.length).toBe(url.length + 4);
  });

  it("encodes exactly 127 and 128 byte values at the form boundary", () => {
    expect([...encodeDerUtf8String("a".repeat(127)).subarray(0, 2)]).toEqual([0x0c, 127]);
    expect([...encodeDerUtf8String("a".repeat(128)).subarray(0, 3)]).toEqual([0x0c, 0x81, 128]);
  });
});

describe("defaultVerifyBundle", () => {
  afterEach(() => {
    vi.doUnmock("sigstore");
    vi.resetModules();
  });

  async function callWithMockedSigstore(sourceRepositoryUrl: string) {
    const verify = vi.fn(async (..._args: unknown[]) => ({}));
    vi.resetModules();
    vi.doMock("sigstore", () => ({ verify }));
    const { defaultVerifyBundle } = await import("../src/provenance");
    const bundle = makeBundleWithStatement(exampleStatement);
    await defaultVerifyBundle(bundle, {
      certificateIssuer: "https://token.actions.githubusercontent.com",
      sourceRepositoryUrl
    });
    return { verify, bundle };
  }

  it("passes the options as the second argument with the DER source repository", async () => {
    const url = "https://github.com/axios/axios";
    const { verify, bundle } = await callWithMockedSigstore(url);

    expect(verify).toHaveBeenCalledTimes(1);
    const args = verify.mock.calls[0]!;
    expect(args).toHaveLength(2);
    expect(args[0]).toBe(bundle);
    const options = args[1] as {
      certificateIssuer: string;
      certificateOIDs: Record<string, string | Buffer>;
    };
    expect(options.certificateIssuer).toBe("https://token.actions.githubusercontent.com");
    expect(Object.keys(options.certificateOIDs)).toEqual(["1.3.6.1.4.1.57264.1.12"]);
    expect(Buffer.from(options.certificateOIDs["1.3.6.1.4.1.57264.1.12"]!)).toEqual(
      encodeDerUtf8String(url)
    );
    expect(options).not.toHaveProperty("certificateIdentityURI");
  });

  it("survives sigstore's Buffer.from byte for byte for a long repository URL", async () => {
    const url = "https://github.com/owner/" + "r".repeat(150);
    const { verify } = await callWithMockedSigstore(url);
    const value = (
      verify.mock.calls[0]![1] as { certificateOIDs: Record<string, string | Buffer> }
    ).certificateOIDs["1.3.6.1.4.1.57264.1.12"]!;
    // sigstore's createVerificationPolicy does Buffer.from(value).
    const received = Buffer.from(value);
    expect([...received.subarray(0, 3)]).toEqual([0x0c, 0x81, url.length]);
    expect(received).toEqual(encodeDerUtf8String(url));
  });

  it("reports missing tooling distinctly when sigstore cannot be imported", async () => {
    vi.resetModules();
    vi.doMock("sigstore", () => {
      throw new Error("Cannot find module 'sigstore'");
    });
    const mod = await import("../src/provenance");
    await expect(
      mod.defaultVerifyBundle(makeBundleWithStatement(exampleStatement), {
        certificateIssuer: "x",
        sourceRepositoryUrl: "https://github.com/a/b"
      })
    ).rejects.toBeInstanceOf(mod.SigstoreToolingUnavailableError);
  });
});
