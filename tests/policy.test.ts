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
    provenance: {
      mode: "off",
      requireFor: [],
      trustedPublishers: {},
      offlineBehavior: "fail-closed"
    },
    transitive: {
      mode: "off",
      checks: ["install-script", "untrusted-source"]
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

  it("skips release-age and install-script checks for allowlisted packages", () => {
    // Default input is a fresh release (release-too-new) — allowlisting
    // should suppress that block.
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"]
        }),
        resolvedRegistryPackage: {
          ...createInput().resolvedRegistryPackage!,
          lifecycleScripts: ["postinstall"]
        }
      })
    );

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings[0]).toMatch("allowlisted");
  });

  it("still blocks an untrusted source even when the package is allowlisted", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"],
          allowedSources: ["registry"]
        }),
        requested: {
          name: "axios",
          raw: "git+https://github.com/evil/axios.git",
          requested: "git+https://github.com/evil/axios.git",
          sourceType: "git"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("untrusted-source");
  });

  it("still blocks a registry-to-git trust downgrade even when allowlisted", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"]
        }),
        requested: {
          name: "axios",
          raw: "git+https://github.com/evil/axios.git",
          requested: "git+https://github.com/evil/axios.git",
          sourceType: "git"
        },
        priorState: {
          installedVersion: "1.13.2",
          declaredSpec: "^1.13.2",
          declaredSourceType: "registry"
        },
        resolvedRegistryPackage: undefined
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("trust-level-dropped");
  });

  it("still blocks newly-introduced lifecycle scripts even when allowlisted", () => {
    // This is the exact attack scenario from issue #1: an allowlisted
    // package that later adds a lifecycle script it did not have before.
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"]
        }),
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
    // ...but NOT the static install-script-present block, which is skipped
    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("install-script-present");
  });

  it("still blocks a publisher mismatch even when allowlisted", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["axios"],
          provenance: {
            mode: "require",
            requireFor: [],
            trustedPublishers: { axios: "axios/axios" },
            offlineBehavior: "fail-closed"
          }
        }),
        provenanceResult: {
          status: "verified",
          sourceRepository: "evil-org/axios"
        }
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("publisher-mismatch");
  });

  it("skips typo-squat detection for allowlisted packages", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          allowedPackages: ["lodahs"],
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

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain("typo-squat-suspected");
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

  it("catches typo-squat even when registry resolution failed", () => {
    // Regression test for a 0.2.0 bug: if a typo'd name does not exist on
    // the registry, the resolve error used to shadow the typo-squat check
    // and users saw "fetch failed" instead of "suspected typo-squat".
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "block", minNameLength: 4, ignore: [] }
        }),
        requested: {
          name: "raect",
          raw: "raect",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        resolvedRegistryPackage: undefined,
        resolutionError: new Error("404 Not Found")
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("typo-squat-suspected");
    // The typo-squat block wins; we do NOT also add package-resolution-failed
    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain(
      "package-resolution-failed"
    );
  });

  it("adds package-resolution-failed when registry resolution failed and nothing else caught it", () => {
    const result = evaluatePackage(
      createInput({
        config: createConfig({
          typoSquat: { mode: "block", minNameLength: 4, ignore: [] }
        }),
        requested: {
          name: "totally-unrelated-nonexistent-package",
          raw: "totally-unrelated-nonexistent-package",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        resolvedRegistryPackage: undefined,
        resolutionError: new Error("404 Not Found")
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("package-resolution-failed");
    const block = result.blockedReasons.find(
      (reason) => reason.code === "package-resolution-failed"
    );
    expect(block?.message).toContain("totally-unrelated-nonexistent-package");
    expect(block?.message).toContain("404 Not Found");
  });

  it("does not add package-resolution-failed for non-registry sources", () => {
    const result = evaluatePackage(
      createInput({
        requested: {
          name: "github:axios/axios",
          raw: "github:axios/axios",
          requested: "github:axios/axios",
          sourceType: "git"
        },
        resolvedRegistryPackage: undefined,
        resolutionError: new Error("should not happen")
      })
    );

    expect(result.blockedReasons.map((reason) => reason.code)).not.toContain(
      "package-resolution-failed"
    );
  });

  describe("provenance integration", () => {
    const provenanceBase = {
      minimumReleaseAgeHours: 0
    } as const;

    it("ignores provenance results when mode is off", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "off",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "missing" }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
    });

    it("blocks on missing attestation when mode is require", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "require",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "missing" }
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain("attestation-missing");
    });

    it("blocks on missing attestation when package matches requireFor in warn mode", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "warn",
              requireFor: ["axios"],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "missing" }
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain("attestation-missing");
    });

    it("warns on missing attestation in warn mode when package is not in requireFor", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "warn",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "missing" }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
      // Missing attestation is a real warning (something absent that could be there)
      expect(result.warnings.some((warning) => warning.includes("provenance"))).toBe(true);
    });

    it("blocks on invalid attestation regardless of mode", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "warn",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "invalid", error: "signature mismatch" }
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain("attestation-invalid");
    });

    it("blocks on unreachable when offlineBehavior is fail-closed", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "require",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: { status: "unreachable", error: "ETIMEDOUT" }
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain("attestation-unreachable");
    });

    it("warns on unreachable when offlineBehavior is allow-cached", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "require",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "allow-cached"
            }
          }),
          provenanceResult: { status: "unreachable", error: "ETIMEDOUT" }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
      expect(result.warnings.some((warning) => warning.includes("unreachable"))).toBe(true);
    });

    it("blocks on publisher mismatch even when mode is warn", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "warn",
              requireFor: [],
              trustedPublishers: { axios: "axios/axios" },
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: {
            status: "verified",
            sourceRepository: "evil-org/axios"
          }
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain("publisher-mismatch");
    });

    it("permits verified attestation when the publisher matches the pin", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "require",
              requireFor: [],
              trustedPublishers: { axios: "axios/axios" },
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: {
            status: "verified",
            sourceRepository: "axios/axios"
          }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
    });

    it("permits verified attestation without a publisher pin", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "require",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: {
            status: "verified",
            sourceRepository: "anyone/anything"
          }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
    });

    it("surfaces verification details as an info line in warn mode (not a warning)", () => {
      const result = evaluatePackage(
        createInput({
          config: createConfig({
            ...provenanceBase,
            provenance: {
              mode: "warn",
              requireFor: [],
              trustedPublishers: {},
              offlineBehavior: "fail-closed"
            }
          }),
          provenanceResult: {
            status: "verified",
            sourceRepository: "axios/axios",
            workflowPath: ".github/workflows/release.yml"
          }
        })
      );

      expect(result.blockedReasons).toHaveLength(0);
      // Verified-OK is informational, not a warning. This is the 0.2.1 fix
      // for the confusing "Warning: ... verified" output users saw in 0.2.0.
      expect(result.warnings).toHaveLength(0);
      expect(
        result.infos.some(
          (info) => info.includes("verified") && info.includes("axios/axios")
        )
      ).toBe(true);
    });
  });
});
