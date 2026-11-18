import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultContinuityDependencies,
  evaluateContinuity,
  selectBaseline
} from "../src/continuity";
import type { ContinuityDependencies, VersionRecord } from "../src/continuity";
import { DiskCache } from "../src/disk-cache";
import type { AttestationIdentity } from "../src/provenance";
import type { ContinuityConfig } from "../src/types";

const tempDirs: string[] = [];

async function createDiskCache(): Promise<DiskCache> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-continuity-"));
  tempDirs.push(dir);
  return new DiskCache({ cacheDir: dir, ttlMs: 60_000 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function config(overrides: Partial<ContinuityConfig> = {}): ContinuityConfig {
  return { mode: "block", baselineSize: 5, ...overrides };
}

function version(v: string, isoDate: string): VersionRecord {
  return { version: v, publishedAt: new Date(isoDate) };
}

/**
 * Build a dependencies stub from a version history and a map of
 * version -> identity. Versions absent from the map default to no provenance.
 */
function deps(
  history: VersionRecord[],
  identities: Record<string, AttestationIdentity>
): ContinuityDependencies {
  return {
    async fetchVersionHistory() {
      return history;
    },
    async fetchIdentity(_pkg, v) {
      return identities[v] ?? { hasProvenance: false };
    }
  };
}

const provFrom = (repo: string): AttestationIdentity => ({
  hasProvenance: true,
  sourceRepository: repo,
  workflowPath: ".github/workflows/publish.yml"
});
const noProv: AttestationIdentity = { hasProvenance: false };

describe("createDefaultContinuityDependencies", () => {
  it("fetches version history instead of trusting planted disk history", async () => {
    const diskCache = await createDiskCache();
    await diskCache.setJson(
      "registry-version-history-v2",
      "https://registry.npmjs.org|demo",
      [{ version: "9.9.9", publishedAt: "2020-01-01T00:00:00.000Z" }]
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: { "1.0.0": {} },
          time: { "1.0.0": "2026-01-01T00:00:00.000Z" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const records = await createDefaultContinuityDependencies(diskCache).fetchVersionHistory(
      "demo",
      "https://registry.npmjs.org"
    );

    expect(records).toEqual([version("1.0.0", "2026-01-01T00:00:00.000Z")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("notes which versions the registry lists with a provenance attestation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            versions: {
              "1.0.0": {
                dist: {
                  attestations: {
                    url: "https://registry.npmjs.org/-/npm/v1/attestations/demo@1.0.0",
                    provenance: { predicateType: "https://slsa.dev/provenance/v1" }
                  }
                }
              },
              "1.1.0": { dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/demo@1.1.0" } } },
              "1.2.0": { dist: {} }
            },
            time: {
              "1.0.0": "2026-01-01T00:00:00.000Z",
              "1.1.0": "2026-02-01T00:00:00.000Z",
              "1.2.0": "2026-03-01T00:00:00.000Z"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    const records = await createDefaultContinuityDependencies(await createDiskCache()).fetchVersionHistory(
      "demo",
      "https://registry.npmjs.org"
    );

    expect(records.map((record) => [record.version, record.claimsProvenance ?? false])).toEqual([
      ["1.0.0", true],
      ["1.1.0", false],
      ["1.2.0", false]
    ]);
  });
});

describe("selectBaseline", () => {
  const history = [
    version("1.0.0", "2026-01-01T00:00:00Z"),
    version("1.1.0", "2026-02-01T00:00:00Z"),
    version("1.2.0", "2026-03-01T00:00:00Z"),
    version("1.3.0", "2026-04-01T00:00:00Z")
  ];

  it("returns the most recent versions published before the target", () => {
    const baseline = selectBaseline(history, "1.3.0", 2);
    expect(baseline.map((r) => r.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  it("excludes the target version itself", () => {
    const baseline = selectBaseline(history, "1.2.0", 10);
    expect(baseline.map((r) => r.version)).not.toContain("1.2.0");
    expect(baseline.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("caps the baseline at baselineSize", () => {
    expect(selectBaseline(history, "1.3.0", 1)).toHaveLength(1);
  });

  it("falls back to most recent versions when target is not in history", () => {
    const baseline = selectBaseline(history, "9.9.9", 2);
    expect(baseline.map((r) => r.version)).toEqual(["1.3.0", "1.2.0"]);
  });
});

describe("evaluateContinuity", () => {
  const history = [
    version("1.0.0", "2026-01-01T00:00:00Z"),
    version("1.1.0", "2026-02-01T00:00:00Z"),
    version("1.2.0", "2026-03-01T00:00:00Z"),
    version("1.3.0", "2026-04-01T00:00:00Z")
  ];

  async function run(
    targetVersion: string,
    identities: Record<string, AttestationIdentity>,
    cfg: ContinuityConfig = config()
  ) {
    return evaluateContinuity({
      packageName: "demo",
      targetVersion,
      registryUrl: "https://registry.npmjs.org",
      config: cfg,
      diskCache: await createDiskCache(),
      deps: deps(history, identities)
    });
  }

  it("returns unevaluated when mode is off", async () => {
    const result = await run("1.3.0", {}, config({ mode: "off" }));
    expect(result.status).toBe("unevaluated");
  });

  it("flags a provenance downgrade when the baseline was provenance-bearing", async () => {
    // 1.0.0–1.2.0 attested from demo/demo, 1.3.0 has none
    const result = await run("1.3.0", {
      "1.0.0": provFrom("demo/demo"),
      "1.1.0": provFrom("demo/demo"),
      "1.2.0": provFrom("demo/demo"),
      "1.3.0": noProv
    });

    expect(result.status).toBe("provenance-downgrade");
    expect(result.baselineRepository).toBe("demo/demo");
    expect(result.targetHasProvenance).toBe(false);
  });

  it("flags identity discontinuity when the source repository changes", async () => {
    const result = await run("1.3.0", {
      "1.0.0": provFrom("demo/demo"),
      "1.1.0": provFrom("demo/demo"),
      "1.2.0": provFrom("demo/demo"),
      "1.3.0": provFrom("evil-fork/demo")
    });

    expect(result.status).toBe("identity-discontinuity");
    expect(result.baselineRepository).toBe("demo/demo");
    expect(result.targetRepository).toBe("evil-fork/demo");
  });

  it("returns consistent when provenance and repository match the baseline", async () => {
    const result = await run("1.3.0", {
      "1.0.0": provFrom("demo/demo"),
      "1.1.0": provFrom("demo/demo"),
      "1.2.0": provFrom("demo/demo"),
      "1.3.0": provFrom("demo/demo")
    });

    expect(result.status).toBe("consistent");
  });

  it("binds baseline and target identities to their artifact integrity", async () => {
    const boundIdentities: Array<{ version: string; artifactIntegrity: string | undefined }> = [];
    const integrityHistory: VersionRecord[] = history.map((record) => ({
      ...record,
      artifactIntegrity: `sha512-${record.version}`
    }));
    const bindingDeps: ContinuityDependencies = {
      async fetchVersionHistory() {
        return integrityHistory;
      },
      async fetchIdentity(_packageName, identityVersion, _registryUrl, _signal, artifactIntegrity) {
        boundIdentities.push({ version: identityVersion, artifactIntegrity });
        return provFrom("demo/demo");
      }
    };

    const result = await evaluateContinuity({
      packageName: "demo",
      targetVersion: "1.3.0",
      targetArtifactIntegrity: "sha512-resolved-target",
      registryUrl: "https://registry.npmjs.org",
      config: config(),
      diskCache: await createDiskCache(),
      deps: bindingDeps
    });

    expect(result.status).toBe("consistent");
    expect(boundIdentities).toEqual([
      { version: "1.2.0", artifactIntegrity: "sha512-1.2.0" },
      { version: "1.1.0", artifactIntegrity: "sha512-1.1.0" },
      { version: "1.0.0", artifactIntegrity: "sha512-1.0.0" },
      { version: "1.3.0", artifactIntegrity: "sha512-resolved-target" }
    ]);
  });

  it("returns no-baseline when the package was never reliably provenance-bearing", async () => {
    // Only one of three baseline versions had provenance -> rate < 0.5
    const result = await run("1.3.0", {
      "1.0.0": noProv,
      "1.1.0": noProv,
      "1.2.0": provFrom("demo/demo"),
      "1.3.0": noProv
    });

    expect(result.status).toBe("no-baseline");
  });

  it("returns no-baseline when there are no prior versions", async () => {
    const result = await evaluateContinuity({
      packageName: "demo",
      targetVersion: "1.0.0",
      registryUrl: "https://registry.npmjs.org",
      config: config(),
      diskCache: await createDiskCache(),
      deps: deps([version("1.0.0", "2026-01-01T00:00:00Z")], {})
    });

    expect(result.status).toBe("no-baseline");
  });

  it("returns unevaluated (does not block) when version history cannot be fetched", async () => {
    const failingDeps: ContinuityDependencies = {
      async fetchVersionHistory() {
        throw new Error("registry unreachable");
      },
      async fetchIdentity() {
        return noProv;
      }
    };

    const result = await evaluateContinuity({
      packageName: "demo",
      targetVersion: "1.3.0",
      registryUrl: "https://registry.npmjs.org",
      config: config(),
      diskCache: await createDiskCache(),
      deps: failingDeps
    });

    expect(result.status).toBe("unevaluated");
    expect(result.error).toContain("registry unreachable");
  });
});

describe("evaluateContinuity against releases that bury an attested history", () => {
  const month = (index: number): string => `2025-${String(index + 1).padStart(2, "0")}-01T00:00:00Z`;
  // 1.0.0 to 1.9.0: ten releases the registry lists with provenance.
  const attested = Array.from({ length: 10 }, (_, index) => ({
    ...version(`1.${index}.0`, month(index)),
    claimsProvenance: true
  }));
  const attestedIdentities = Object.fromEntries(attested.map((record) => [record.version, provFrom("demo/demo")]));
  const filler = (count: number): VersionRecord[] =>
    Array.from({ length: count }, (_, index) => version(`2.0.${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`));

  async function run(
    history: VersionRecord[],
    targetVersion: string,
    identities: Record<string, AttestationIdentity>
  ): Promise<{ result: Awaited<ReturnType<typeof evaluateContinuity>>; verified: string[] }> {
    const verified: string[] = [];
    const stub = deps(history, identities);
    const result = await evaluateContinuity({
      packageName: "demo",
      targetVersion,
      registryUrl: "https://registry.npmjs.org",
      config: config(),
      diskCache: await createDiskCache(),
      deps: {
        fetchVersionHistory: stub.fetchVersionHistory,
        async fetchIdentity(pkg, v, registryUrl) {
          verified.push(v);
          return stub.fetchIdentity(pkg, v, registryUrl);
        }
      }
    });
    return { result, verified };
  }

  it.each([3, 5, 9])("flags the downgrade behind %i releases without provenance", async (count) => {
    const fillers = filler(count);
    const target = version("2.1.0", "2026-02-01T00:00:00Z");

    const { result } = await run([...attested, ...fillers, target], "2.1.0", attestedIdentities);

    expect(result.status).toBe("provenance-downgrade");
    expect(result.baselineRepository).toBe("demo/demo");
    expect(result.skippedRecentVersions).toBe(Math.min(count, 5));
  });

  it("flags a change of repository behind releases without provenance", async () => {
    const target = { ...version("2.1.0", "2026-02-01T00:00:00Z"), claimsProvenance: true };

    const { result } = await run([...attested, ...filler(5), target], "2.1.0", {
      ...attestedIdentities,
      "2.1.0": provFrom("attacker/demo")
    });

    expect(result.status).toBe("identity-discontinuity");
    expect(result.baselineRepository).toBe("demo/demo");
  });

  it("verifies the earlier versions instead of trusting the registry's listing", async () => {
    // The listing claims provenance for the old releases; none verifies.
    const target = version("2.1.0", "2026-02-01T00:00:00Z");

    const { result } = await run([...attested, ...filler(5), target], "2.1.0", {});

    expect(result.status).toBe("no-baseline");
  });

  it("spends no extra request on a package that never listed provenance", async () => {
    const plain = Array.from({ length: 15 }, (_, index) => version(`1.${index}.0`, month(index % 12)));
    const history = plain.map((record, index) => ({ ...record, publishedAt: new Date(Date.UTC(2024, index, 1)) }));
    const target = version("2.0.0", "2026-02-01T00:00:00Z");

    const { result, verified } = await run([...history, target], "2.0.0", {});

    expect(result.status).toBe("no-baseline");
    // The five most recent versions and the target, nothing further back.
    expect(verified).toHaveLength(6);
  });

  it("looks back three baselines and no further", async () => {
    // 15 releases without provenance push the attested history out of reach.
    const target = version("2.1.0", "2026-03-01T00:00:00Z");

    const { result } = await run([...attested, ...filler(15), target], "2.1.0", attestedIdentities);

    expect(result.status).toBe("no-baseline");
  });
});

describe("evaluateContinuity with unsigned attestation payloads", () => {
  const DIGEST = Buffer.alloc(64, 9);
  const INTEGRITY = `sha512-${DIGEST.toString("base64")}`;

  // A bundle is "genuine" only when its signature field says so; the stub
  // verifier stands in for Sigstore, which rejects every forged payload.
  function bundleFor(packageName: string, v: string, repo: string, signature: string) {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: `pkg:npm/${packageName}@${v}`, digest: { sha512: DIGEST.toString("hex") } }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: `https://github.com/${repo}`,
              ref: "refs/tags/v1",
              path: ".github/workflows/publish.yml"
            }
          }
        }
      }
    };
    return {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              payloadType: "application/vnd.in-toto+json",
              signatures: [{ sig: signature }]
            }
          }
        }
      ]
    };
  }

  type StubBundle = { dsseEnvelope?: { signatures: Array<{ sig: string }> } };

  const history = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((v, index) => ({
    version: v,
    publishedAt: new Date(`2026-0${index + 1}-01T00:00:00.000Z`),
    artifactIntegrity: INTEGRITY
  }));

  async function run(
    attestationFor: (v: string) => ReturnType<typeof bundleFor> | null,
    verifyBundle: (bundle: StubBundle) => Promise<void>
  ) {
    const { fetchAttestationIdentity } = await import("../src/provenance");
    const dependencies: ContinuityDependencies = {
      async fetchVersionHistory() {
        return history;
      },
      async fetchIdentity(packageName, v, registryUrl, signal, artifactIntegrity) {
        return fetchAttestationIdentity({
          packageName,
          version: v,
          artifactIntegrity,
          registryUrl,
          signal,
          deps: {
            fetchAttestations: async () => attestationFor(v),
            verifyBundle: verifyBundle as never
          }
        });
      }
    };
    return evaluateContinuity({
      packageName: "demo",
      targetVersion: "1.3.0",
      targetArtifactIntegrity: INTEGRITY,
      registryUrl: "https://registry.npmjs.org",
      config: config(),
      diskCache: await createDiskCache(),
      deps: dependencies
    });
  }

  const sigstoreStub = async (bundle: StubBundle) => {
    if (bundle.dsseEnvelope?.signatures[0]?.sig !== "genuine") {
      throw new Error("signature verification failed");
    }
  };

  it("does not let a forged unsigned attestation make a malicious version look continuous", async () => {
    const result = await run(
      (v) =>
        v === "1.3.0"
          ? bundleFor("demo", v, "demo/demo", "forged") // names the legitimate repository
          : bundleFor("demo", v, "demo/demo", "genuine"),
      sigstoreStub
    );
    expect(result.status).toBe("provenance-downgrade");
  });

  it("does not let forged baseline attestations make a legitimate version look like a publisher change", async () => {
    const result = await run(
      (v) =>
        v === "1.3.0"
          ? bundleFor("demo", v, "demo/demo", "genuine")
          : v === "1.2.0"
            ? bundleFor("demo", v, "evil/demo", "forged")
            : bundleFor("demo", v, "demo/demo", "genuine"),
      sigstoreStub
    );
    expect(result.status).toBe("consistent");
    expect(result.baselineRepository).toBe("demo/demo");
  });

  it("does not let an entirely forged baseline create a publisher change for a legitimate version", async () => {
    const result = await run(
      (v) =>
        v === "1.3.0"
          ? bundleFor("demo", v, "demo/demo", "genuine")
          : bundleFor("demo", v, "evil/demo", "forged"),
      sigstoreStub
    );
    expect(result.status).toBe("no-baseline");
  });

  it("still detects a genuinely signed publisher change", async () => {
    const result = await run(
      (v) =>
        v === "1.3.0"
          ? bundleFor("demo", v, "other/demo", "genuine")
          : bundleFor("demo", v, "demo/demo", "genuine"),
      sigstoreStub
    );
    expect(result.status).toBe("identity-discontinuity");
  });

  it("is unevaluated, not a pass or a block, when verification tooling is unavailable", async () => {
    const { SigstoreToolingUnavailableError } = await import("../src/provenance");
    const result = await run(
      (v) => bundleFor("demo", v, "demo/demo", "genuine"),
      async () => {
        throw new SigstoreToolingUnavailableError();
      }
    );
    expect(result.status).toBe("unevaluated");
    expect(result.error).toContain("sigstore");
  });

  it("is unevaluated when the Sigstore trust root cannot be fetched (offline)", async () => {
    const result = await run(
      (v) => bundleFor("demo", v, "demo/demo", "genuine"),
      async () => {
        throw Object.assign(new Error("error refreshing TUF metadata"), { name: "TUFError" });
      }
    );
    expect(result.status).toBe("unevaluated");
  });
});
