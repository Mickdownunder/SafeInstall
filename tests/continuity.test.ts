import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateContinuity, selectBaseline } from "../src/continuity";
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
