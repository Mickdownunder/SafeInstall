import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateRequestedPackages } from "../src/evaluations";
import type { RequestedPackage, SafeInstallConfig } from "../src/types";

const tempDirs: string[] = [];

function createConfig(overrides: Partial<SafeInstallConfig> = {}): SafeInstallConfig {
  return {
    minimumReleaseAgeHours: 0,
    registryUrl: "https://registry.npmjs.org",
    allowedScripts: {},
    allowedSources: ["registry", "workspace", "file", "directory"],
    allowedPackages: [],
    packageManagerDefaults: {
      npm: { ignoreScripts: true },
      pnpm: { ignoreScripts: true },
      bun: { ignoreScripts: true }
    },
    typoSquat: {
      mode: "off",
      minNameLength: 4,
      ignore: []
    },
    provenance: {
      mode: "off",
      requireFor: [],
      trustedPublishers: {},
      offlineBehavior: "fail-closed",
      toolingUnavailable: "warn"
    },
    transitive: {
      mode: "off",
      checks: ["install-script", "untrusted-source"]
    },
    continuity: {
      mode: "off",
      baselineSize: 5
    },
    ...overrides
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createRequestedPackage(index: number): RequestedPackage {
  return {
    name: `pkg-${index}`,
    raw: `pkg-${index}@1.0.${index}`,
    requested: `1.0.${index}`,
    sourceType: "registry",
    registrySpecKind: "version"
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("evaluateRequestedPackages", () => {
  it("bounds concurrent registry evaluations for larger install sets", async () => {
    const projectDir = await createTempDir("safeinstall-evaluations-");
    const requestedPackages = Array.from({ length: 16 }, (_, index) => createRequestedPackage(index));

    let active = 0;
    let maxActive = 0;

    type RegistryClientLike = {
      resolvePackage(requested: RequestedPackage): Promise<{
        requested: RequestedPackage;
        resolvedVersion: string;
        publishedAt: Date;
        lifecycleScripts: [];
      }>;
      getLifecycleScripts(): Promise<[]>;
    };

    const registryClient = {
      async resolvePackage(requested: RequestedPackage) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;

        return {
          requested,
          resolvedVersion: requested.requested,
          publishedAt: new Date("2026-03-01T00:00:00.000Z"),
          lifecycleScripts: []
        };
      },
      async getLifecycleScripts() {
        return [];
      }
    } satisfies RegistryClientLike;

    const evaluations = await evaluateRequestedPackages(
      projectDir,
      requestedPackages,
      registryClient as unknown as Parameters<typeof evaluateRequestedPackages>[2],
      createConfig()
    );

    expect(evaluations).toHaveLength(16);
    expect(maxActive).toBeLessThanOrEqual(8);
  });

  it("does not accept the current manifest as source-transition evidence", async () => {
    const projectDir = await createTempDir("safeinstall-evaluations-source-baseline-");
    const gitSpec = "git+https://github.com/attacker/axios.git";
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { axios: gitSpec } }),
      "utf8"
    );
    const requested: RequestedPackage = {
      name: "axios",
      raw: `axios@${gitSpec}`,
      requested: gitSpec,
      sourceType: "git"
    };

    const [evaluation] = await evaluateRequestedPackages(
      projectDir,
      [requested],
      {} as Parameters<typeof evaluateRequestedPackages>[2],
      createConfig({ allowedSources: ["registry", "git"] })
    );

    expect(evaluation?.priorState?.declaredSourceType).toBe("git");
    expect(evaluation?.blockedReasons).toContainEqual(
      expect.objectContaining({
        code: "trust-level-dropped",
        message: expect.stringContaining("no independent source baseline")
      })
    );
  });

  it("compares complete base evidence while preserving reviewed git sources", async () => {
    const projectDir = await createTempDir("safeinstall-evaluations-complete-baseline-");
    const gitSpec = "git+https://github.com/axios/axios.git";
    const requested: RequestedPackage = {
      name: "axios",
      raw: `axios@${gitSpec}`,
      requested: gitSpec,
      sourceType: "git"
    };
    const config = createConfig({
      allowedSources: ["registry", "git"],
      sourceBaselines: { axios: "git" }
    });
    const registryClient = {} as Parameters<typeof evaluateRequestedPackages>[2];

    const [downgrade] = await evaluateRequestedPackages(
      projectDir,
      [requested],
      registryClient,
      config,
      undefined,
      { complete: true, sourceTypes: { axios: "registry" } }
    );
    const [established] = await evaluateRequestedPackages(
      projectDir,
      [requested],
      registryClient,
      config
    );
    const [newDependency] = await evaluateRequestedPackages(
      projectDir,
      [requested],
      registryClient,
      config,
      undefined,
      { complete: true, sourceTypes: {} }
    );

    expect(downgrade?.blockedReasons.map((reason) => reason.code)).toContain("trust-level-dropped");
    expect(established?.blockedReasons.map((reason) => reason.code)).not.toContain(
      "trust-level-dropped"
    );
    expect(newDependency?.blockedReasons.map((reason) => reason.code)).not.toContain(
      "trust-level-dropped"
    );
  });
});
