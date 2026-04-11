import { describe, expect, it } from "vitest";

import { evaluatePackage } from "../src/policy";
import type { EvaluatePackageInput } from "../src/policy";
import type { SafeInstallConfig } from "../src/types";

function createConfig(overrides: Partial<SafeInstallConfig> = {}): SafeInstallConfig {
  return {
    minimumReleaseAgeHours: 72,
    registryUrl: "https://registry.npmjs.org",
    allowedScripts: {},
    allowedSources: ["registry", "workspace", "file", "directory"],
    allowedPackages: [],
    ciMode: false,
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
    ...overrides
  };
}

function createInput(overrides: Partial<EvaluatePackageInput> = {}): EvaluatePackageInput {
  return {
    config: createConfig(),
    now: new Date("2026-03-31T12:00:00.000Z"),
    requested: {
      name: "axios",
      raw: "axios",
      requested: "latest",
      sourceType: "registry",
      registrySpecKind: "tag"
    },
    resolvedRegistryPackage: {
      requested: {
        name: "axios",
        raw: "axios",
        requested: "latest",
        sourceType: "registry",
        registrySpecKind: "tag"
      },
      resolvedVersion: "1.14.0",
      publishedAt: new Date("2026-03-31T10:00:00.000Z"),
      lifecycleScripts: []
    },
    priorLifecycleScripts: [],
    ...overrides
  };
}

describe("evaluatePackage", () => {
  it("blocks releases newer than the configured age threshold", () => {
    const result = evaluatePackage(createInput());
    expect(result.blockedReasons.map((reason) => reason.code)).toContain("release-too-new");
  });

  it("blocks lifecycle scripts when they are not allowlisted", () => {
    const result = evaluatePackage(
      createInput({
        resolvedRegistryPackage: {
          ...createInput().resolvedRegistryPackage!,
          lifecycleScripts: ["postinstall"]
        }
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("install-script-present");
  });

  it("allows configured lifecycle scripts for a package", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedScripts: {
            axios: ["postinstall"]
          }
        }),
        resolvedRegistryPackage: {
          ...createInput().resolvedRegistryPackage!,
          lifecycleScripts: ["postinstall"]
        }
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("install-script-present");
  });

  it("blocks non-registry sources by default", () => {
    const result = evaluatePackage(
      createInput({
        requested: {
          name: "axios",
          raw: "git+https://github.com/axios/axios.git",
          requested: "git+https://github.com/axios/axios.git",
          sourceType: "git"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("untrusted-source");
  });

  it("does not block local workspace sources by default", () => {
    const result = evaluatePackage(
      createInput({
        requested: {
          name: "@repo/shared",
          raw: "@repo/shared@workspace:*",
          requested: "workspace:*",
          sourceType: "workspace"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("untrusted-source");
  });

  it("does not treat registry to workspace changes as trust downgrades", () => {
    const result = evaluatePackage(
      createInput({
        requested: {
          name: "@repo/shared",
          raw: "@repo/shared@workspace:*",
          requested: "workspace:*",
          sourceType: "workspace"
        },
        priorState: {
          installedVersion: "1.0.0",
          declaredSpec: "^1.0.0",
          declaredSourceType: "registry"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("trust-level-dropped");
  });

  it("blocks trust downgrade when scripts are newly introduced", () => {
    const result = evaluatePackage(
      createInput({
        priorState: {
          installedVersion: "1.13.2",
          declaredSpec: "^1.13.2",
          declaredSourceType: "registry"
        },
        priorLifecycleScripts: [],
        resolvedRegistryPackage: {
          ...createInput().resolvedRegistryPackage!,
          lifecycleScripts: ["postinstall"]
        }
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("trust-level-dropped");
  });

  it("skips policy checks for allowlisted packages", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"]
        })
      })
    );

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings[0]).toMatch("allowlisted");
  });

  it("warns on suspected typo-squat when typoSquat.mode is warn", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "warn", minNameLength: 4, ignore: [] }
        }),
        requested: {
          name: "raect",
          raw: "raect",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("typo-squat-suspected");
    expect(result.warnings.some((warning) => warning.includes("typo-squat"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("react"))).toBe(true);
  });

  it("blocks on suspected typo-squat when typoSquat.mode is block", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "block", minNameLength: 4, ignore: [] }
        }),
        requested: {
          name: "lodahs",
          raw: "lodahs",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("typo-squat-suspected");
    const block = result.blockedReasons.find((reason) => reason.code === "typo-squat-suspected");
    expect(block?.message).toContain("lodash");
  });

  it("does not flag exact matches to popular packages even when typoSquat is on", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "block", minNameLength: 4, ignore: [] }
        })
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("typo-squat-suspected");
    expect(result.warnings.some((warning) => warning.includes("typo-squat"))).toBe(false);
  });

  it("does not check typo-squat when mode is off", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "off", minNameLength: 4, ignore: [] }
        }),
        requested: {
          name: "raect",
          raw: "raect",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("typo-squat-suspected");
    expect(result.warnings).toHaveLength(0);
  });
});
