import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectNpmTransitivePackages,
  collectPnpmTransitivePackages,
  evaluateTransitiveDependencies,
  evaluateTransitivePackages,
  parsePnpmPackageKey
} from "../src/transitive";
import type { TransitivePackage } from "../src/transitive";
import type { SafeInstallConfig } from "../src/types";

const tempDirs: string[] = [];

async function createLockfile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-transitive-unit-"));
  tempDirs.push(dir);
  const lockfilePath = path.join(dir, name);
  await writeFile(lockfilePath, content, "utf8");
  return lockfilePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createConfig(overrides: Partial<SafeInstallConfig> = {}): SafeInstallConfig {
  return {
    minimumReleaseAgeHours: 72,
    registryUrl: "https://registry.npmjs.org",
    allowedScripts: {},
    allowedSources: ["registry", "workspace", "file", "directory"],
    allowedPackages: [],
    packageManagerDefaults: {
      npm: { ignoreScripts: true },
      pnpm: { ignoreScripts: true },
      bun: { ignoreScripts: true }
    },
    typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
    provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed", toolingUnavailable: "warn" },
    transitive: { mode: "off", checks: ["install-script", "untrusted-source"] },
    continuity: { mode: "off", baselineSize: 5 },
    ...overrides
  };
}

describe("parsePnpmPackageKey", () => {
  it("parses a modern name@version key", () => {
    expect(parsePnpmPackageKey("axios@1.14.0")).toEqual({ name: "axios", version: "1.14.0" });
  });

  it("parses a scoped name@version key", () => {
    expect(parsePnpmPackageKey("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  });

  it("strips a peer-dependency suffix", () => {
    expect(parsePnpmPackageKey("foo@1.0.0(react@18.0.0)")).toEqual({ name: "foo", version: "1.0.0" });
  });

  it("parses a legacy /name/version key", () => {
    expect(parsePnpmPackageKey("/axios/1.14.0")).toEqual({ name: "axios", version: "1.14.0" });
  });

  it("parses a legacy scoped /@scope/name/version key", () => {
    expect(parsePnpmPackageKey("/@scope/pkg/1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  });

  it("returns undefined for malformed keys", () => {
    expect(parsePnpmPackageKey("@scope")).toBeUndefined();
    expect(parsePnpmPackageKey("")).toBeUndefined();
  });
});

describe("collectNpmTransitivePackages", () => {
  const lockfile = {
    packages: {
      "": { name: "root", version: "1.0.0" },
      "node_modules/axios": {
        version: "1.14.0",
        resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
        integrity: "sha512-x"
      },
      "node_modules/parent/node_modules/axios": {
        version: "0.9.0",
        resolved: "git+ssh://git@github.com/evil/axios.git#abc",
        hasInstallScript: true
      },
      "node_modules/sketchy": {
        version: "0.0.1",
        resolved: "https://registry.npmjs.org/sketchy/-/sketchy-0.0.1.tgz",
        integrity: "sha512-y",
        hasInstallScript: true
      },
      "node_modules/from-git": {
        version: "2.0.0",
        resolved: "git+ssh://git@github.com/evil/from-git.git#abc"
      },
      "node_modules/integrity-pinned-tarball": {
        version: "1.0.0",
        resolved: "HTTPS://attacker.example/pkg-1.0.0.tgz",
        integrity: "sha512-attacker-controlled"
      },
      "node_modules/linked": { link: true, resolved: "" }
    }
  };

  it("excludes only the exact direct key and keeps a nested same-name package", () => {
    const packages = collectNpmTransitivePackages(lockfile, new Set(["node_modules/axios"]));
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["axios", "from-git", "integrity-pinned-tarball", "sketchy"]);
    expect(packages.some((p) => p.name === "axios" && p.version === "1.14.0")).toBe(false);
    expect(packages.find((p) => p.name === "axios")).toMatchObject({
      version: "0.9.0",
      sourceType: "git",
      hasInstallScript: true
    });
    const result = evaluateTransitivePackages(
      packages,
      createConfig({
        transitive: { mode: "block", checks: ["install-script", "untrusted-source"] },
        allowedSources: ["registry"]
      })
    );
    expect(result.blockedReasons.map((reason) => reason.code)).toEqual([
      "transitive-install-script",
      "transitive-untrusted-source"
    ]);
  });

  it("reads hasInstallScript from the lockfile entry", () => {
    const packages = collectNpmTransitivePackages(lockfile, new Set());
    const sketchy = packages.find((p) => p.name === "sketchy");
    expect(sketchy?.hasInstallScript).toBe(true);
    const axios = packages.find((p) => p.name === "axios");
    expect(axios?.hasInstallScript).toBe(false);
  });

  it("classifies a git-resolved dependency as a git source", () => {
    const packages = collectNpmTransitivePackages(lockfile, new Set());
    const fromGit = packages.find((p) => p.name === "from-git");
    expect(fromGit?.sourceType).toBe("git");
  });

  it("does not treat attacker-supplied integrity as registry provenance", () => {
    const packages = collectNpmTransitivePackages(lockfile, new Set());
    const pinnedTarball = packages.find((p) => p.name === "integrity-pinned-tarball");
    expect(pinnedTarball?.sourceType).toBe("tarball");
  });

  const registryRecord = {
    version: "4.0.0",
    resolved: "https://registry.npmjs.org/is-number/-/is-number-4.0.0.tgz",
    integrity: "sha512-x"
  };

  it.each([
    ["after", ["node_modules/is-number", "node_modules/parent/node_modules/is-number"]],
    ["before", ["node_modules/parent/node_modules/is-number", "node_modules/is-number"]]
  ])("keeps a same-name, same-version record from another source listed %s the registry record", (_label, order) => {
    const records: Record<string, object> = {
      "node_modules/is-number": registryRecord,
      "node_modules/parent/node_modules/is-number": {
        version: "4.0.0",
        resolved: "https://evil.example.com/is-number-4.0.0.tgz",
        integrity: "sha512-attacker-controlled"
      }
    };
    const packages = collectNpmTransitivePackages(
      { packages: { "": { version: "1.0.0" }, ...Object.fromEntries(order.map((key) => [key, records[key]])) } },
      new Set()
    );

    expect(packages.map((p) => p.sourceType).sort()).toEqual(["registry", "tarball"]);
    const result = evaluateTransitivePackages(packages, createConfig({ allowedSources: ["registry"] }));
    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-untrusted-source"]);
  });

  it("keeps a same-name, same-version record that differs only in its install script flag", () => {
    const packages = collectNpmTransitivePackages(
      {
        packages: {
          "": { version: "1.0.0" },
          "node_modules/is-number": registryRecord,
          "node_modules/parent/node_modules/is-number": { ...registryRecord, hasInstallScript: true }
        }
      },
      new Set()
    );

    const result = evaluateTransitivePackages(
      packages,
      createConfig({ transitive: { mode: "block", checks: ["install-script"] } })
    );
    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-install-script"]);
  });

  it("reports records that agree in name, version, source and install script flag once", () => {
    const packages = collectNpmTransitivePackages(
      {
        packages: {
          "": { version: "1.0.0" },
          "node_modules/is-number": registryRecord,
          "node_modules/parent/node_modules/is-number": registryRecord
        }
      },
      new Set()
    );

    expect(packages).toHaveLength(1);
  });
});

describe("collectPnpmTransitivePackages", () => {
  const lockfile = {
    packages: {
      "axios@1.14.0": { resolution: { integrity: "sha512-x" } },
      "axios@0.9.0": {
        resolution: { tarball: "https://evil.example.com/axios-0.9.0.tgz" }
      },
      "lodash@4.17.21": { resolution: { integrity: "sha512-y" } },
      "from-tarball@1.0.0": {
        resolution: {
          tarball: "https://evil.example.com/pkg-1.0.0.tgz",
          integrity: "sha512-attacker-controlled"
        }
      }
    }
  };

  it("excludes only the exact direct key and keeps an alternate same-name version", () => {
    const packages = collectPnpmTransitivePackages(lockfile, new Set(["axios@1.14.0"]));
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["axios", "from-tarball", "lodash"]);
    expect(packages.some((p) => p.name === "axios" && p.version === "1.14.0")).toBe(false);
    expect(packages.find((p) => p.name === "axios")).toMatchObject({
      version: "0.9.0",
      sourceType: "tarball"
    });
    const result = evaluateTransitivePackages(
      packages,
      createConfig({
        transitive: { mode: "block", checks: ["untrusted-source"] },
        allowedSources: ["registry"]
      })
    );
    expect(result.blockedReasons.map((reason) => reason.code)).toEqual([
      "transitive-untrusted-source"
    ]);
  });

  it("exempts every peer-context variant of the direct record but not other versions", () => {
    const peered = {
      packages: {
        "react-dom@18.2.0(react@18.2.0)": { resolution: { integrity: "sha512-a" } },
        "react-dom@18.2.0(react@18.3.0)": { resolution: { integrity: "sha512-b" } },
        "/legacy/1.0.0_peer@1.0.0": { resolution: { integrity: "sha512-c" } },
        "react-dom@17.0.0": { resolution: { tarball: "https://evil.example.com/r.tgz" } }
      }
    };
    const packages = collectPnpmTransitivePackages(
      peered,
      new Set(["react-dom@18.2.0(react@18.2.0)", "/legacy/1.0.0_peer@1.0.0"])
    );
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["react-dom@17.0.0"]);
  });

  it("classifies a tarball-resolved dependency as a tarball source", () => {
    const packages = collectPnpmTransitivePackages(lockfile, new Set());
    const fromTarball = packages.find((p) => p.name === "from-tarball");
    expect(fromTarball?.sourceType).toBe("tarball");
  });

  it("leaves hasInstallScript unknown (pnpm lockfiles do not record it)", () => {
    const packages = collectPnpmTransitivePackages(lockfile, new Set());
    expect(packages.every((p) => p.hasInstallScript === undefined)).toBe(true);
  });

  it("keeps a same-name, same-version record that resolves from another source", () => {
    const packages = collectPnpmTransitivePackages(
      {
        packages: {
          "is-number@4.0.0": { resolution: { integrity: "sha512-x" } },
          "is-number@https://evil.example.com/is-number-4.0.0.tgz": {
            version: "4.0.0",
            resolution: { tarball: "https://evil.example.com/is-number-4.0.0.tgz", integrity: "sha512-attacker-controlled" }
          }
        }
      },
      new Set()
    );

    expect(packages.map((p) => `${p.name}@${p.version} ${p.sourceType}`).sort()).toEqual([
      "is-number@4.0.0 registry",
      "is-number@4.0.0 tarball"
    ]);
    const result = evaluateTransitivePackages(packages, createConfig({ allowedSources: ["registry"] }));
    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-untrusted-source"]);
  });
});

describe("evaluateTransitivePackages", () => {
  const withScript: TransitivePackage = {
    name: "sketchy",
    version: "0.0.1",
    sourceType: "registry",
    hasInstallScript: true
  };
  const gitDep: TransitivePackage = {
    name: "from-git",
    version: "2.0.0",
    sourceType: "git",
    hasInstallScript: false
  };
  const clean: TransitivePackage = {
    name: "axios",
    version: "1.14.0",
    sourceType: "registry",
    hasInstallScript: false
  };

  it("ignores install scripts when transitive mode is off", () => {
    const result = evaluateTransitivePackages([withScript, clean], createConfig());
    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it.each(["off", "warn", "block"] as const)(
    "blocks a lockfile entry from a source outside allowedSources in mode %s",
    (mode) => {
      // The source of an entry decides what gets downloaded; it is not an
      // opt-in check and it never degrades to a warning.
      const result = evaluateTransitivePackages(
        [gitDep, clean],
        createConfig({ transitive: { mode, checks: ["install-script"] } })
      );
      expect(result.blockedReasons.map((r) => r.code)).toEqual(["transitive-untrusted-source"]);
      expect(result.untrustedSourcePackages).toEqual(["from-git@2.0.0 (git)"]);
    }
  );

  it("allows that entry once its source type is in allowedSources", () => {
    const result = evaluateTransitivePackages(
      [gitDep],
      createConfig({ allowedSources: ["registry", "git"] })
    );
    expect(result.blockedReasons).toHaveLength(0);
  });

  it("blocks transitive install scripts in block mode", () => {
    const result = evaluateTransitivePackages(
      [withScript, clean],
      createConfig({ transitive: { mode: "block", checks: ["install-script"] } })
    );
    expect(result.blockedReasons.map((r) => r.code)).toContain("transitive-install-script");
    expect(result.installScriptPackages).toContain("sketchy@0.0.1");
  });

  it("warns on transitive install scripts in warn mode", () => {
    const result = evaluateTransitivePackages(
      [withScript],
      createConfig({ transitive: { mode: "warn", checks: ["install-script"] } })
    );
    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("install script"))).toBe(true);
  });

  it("blocks transitive untrusted sources in block mode", () => {
    const result = evaluateTransitivePackages(
      [gitDep, clean],
      createConfig({
        transitive: { mode: "block", checks: ["untrusted-source"] },
        allowedSources: ["registry"]
      })
    );
    expect(result.blockedReasons.map((r) => r.code)).toContain("transitive-untrusted-source");
    expect(result.untrustedSourcePackages.some((p) => p.includes("from-git"))).toBe(true);
  });

  it("only runs the checks listed in config.transitive.checks", () => {
    const result = evaluateTransitivePackages(
      [withScript, gitDep],
      createConfig({
        transitive: { mode: "block", checks: ["untrusted-source"] },
        allowedSources: ["registry"]
      })
    );
    const codes = result.blockedReasons.map((r) => r.code);
    expect(codes).toContain("transitive-untrusted-source");
    expect(codes).not.toContain("transitive-install-script");
  });

  it("does not flag a clean dependency tree", () => {
    const result = evaluateTransitivePackages(
      [clean],
      createConfig({ transitive: { mode: "block", checks: ["install-script", "untrusted-source"] } })
    );
    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it.each(["workspace", "directory"] as const)(
    "does not flag a transitive %s link (first-party workspace member) even when omitted from allowedSources",
    (sourceType) => {
      const localDep: TransitivePackage = {
        name: "local",
        version: "1.0.0",
        sourceType,
        hasInstallScript: false
      };
      const result = evaluateTransitivePackages(
        [localDep],
        createConfig({
          transitive: { mode: "block", checks: ["untrusted-source"] },
          allowedSources: ["registry"]
        })
      );

      expect(result.blockedReasons).toEqual([]);
      expect(result.untrustedSourcePackages).toEqual([]);
    }
  );

  it.each(["file"] as const)(
    "blocks a transitive local %s tarball omitted from allowedSources",
    (sourceType) => {
      const localDep: TransitivePackage = {
        name: "local",
        version: "1.0.0",
        sourceType,
        hasInstallScript: false
      };
      const result = evaluateTransitivePackages(
        [localDep],
        createConfig({
          transitive: { mode: "block", checks: ["untrusted-source"] },
          allowedSources: ["registry"]
        })
      );

      expect(result.blockedReasons.map((reason) => reason.code)).toContain(
        "transitive-untrusted-source"
      );
      expect(result.untrustedSourcePackages).toContain(`local@1.0.0 (${sourceType})`);
    }
  );

  it.each(["workspace", "file", "directory"] as const)(
    "allows a transitive %s source when configured",
    (sourceType) => {
      const localDep: TransitivePackage = {
        name: "local",
        version: "1.0.0",
        sourceType,
        hasInstallScript: false
      };
      const result = evaluateTransitivePackages(
        [localDep],
        createConfig({
          transitive: { mode: "block", checks: ["untrusted-source"] }
        })
      );
      expect(result.blockedReasons).toHaveLength(0);
    }
  );
});

describe("evaluateTransitiveDependencies evidence failures", () => {
  const blockConfig = createConfig({
    transitive: { mode: "block", checks: ["install-script", "untrusted-source"] }
  });

  async function evaluate(lockfilePath: string | undefined, config = blockConfig) {
    return evaluateTransitiveDependencies({ lockfilePath, directLockfileKeys: new Set(), config });
  }

  it("blocks when no supported lockfile was discovered", async () => {
    const result = await evaluate(undefined);

    expect(result.blockedReasons.map((reason) => reason.code)).toContain(
      "transitive-evaluation-unavailable"
    );
    expect(result.blockedReasons[0]?.message).toContain("no npm or pnpm lockfile was found");
  });

  it("blocks when the selected lockfile cannot be read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-transitive-unit-"));
    tempDirs.push(dir);

    const result = await evaluate(path.join(dir, "package-lock.json"));

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("could not be read");
  });

  it("blocks unsupported lockfile formats before parsing", async () => {
    const lockfilePath = await createLockfile("bun.lock", "{\"lockfileVersion\": 1}");

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("not a supported lockfile");
  });

  it("blocks syntactically invalid supported lockfiles", async () => {
    const lockfilePath = await createLockfile("package-lock.json", "{not-json");

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("invalid or unsupported");
  });

  it("blocks syntactically invalid pnpm lockfiles", async () => {
    const lockfilePath = await createLockfile("pnpm-lock.yaml", "lockfileVersion: [");

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("invalid or unsupported");
  });

  it("blocks a pnpm lockfile major it does not know how to read", async () => {
    const lockfilePath = await createLockfile("pnpm-lock.yaml", "lockfileVersion: '99.0'\npackages: {}\n");

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("invalid or unsupported");
  });

  it.each(["5.4", "'6.0'", "'9.0'", "9"])("accepts pnpm lockfileVersion %s", async (version) => {
    const lockfilePath = await createLockfile("pnpm-lock.yaml", `lockfileVersion: ${version}\npackages: {}\n`);

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons).toEqual([]);
  });

  it("blocks structurally unsupported npm lockfiles", async () => {
    const lockfilePath = await createLockfile(
      "package-lock.json",
      JSON.stringify({ lockfileVersion: 1, dependencies: {} })
    );

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons[0]?.code).toBe("transitive-evaluation-unavailable");
    expect(result.blockedReasons[0]?.message).toContain("invalid or unsupported");
  });

  it("warns explicitly when lockfile evidence is unavailable in warn mode", async () => {
    const result = await evaluate(
      undefined,
      createConfig({ transitive: { mode: "warn", checks: ["untrusted-source"] } })
    );

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings[0]).toContain("no npm or pnpm lockfile was found");
  });

  it("keeps transitive mode off silent without a lockfile", async () => {
    const result = await evaluate(undefined, createConfig());

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it.each([
    ["an unsupported lockfile", "bun.lock", "{\"lockfileVersion\": 1}"],
    ["an unparsable lockfile", "package-lock.json", "{not-json"]
  ])("keeps transitive mode off silent for %s", async (_label, name, content) => {
    const result = await evaluate(await createLockfile(name, content), createConfig());

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it.each([
    ["another host", "https://evil.example/is-number-4.0.0.tgz"],
    ["a git repository", "git+ssh://git@github.com/attacker/is-number.git#0123456789abcdef0123456789abcdef01234567"]
  ])("blocks a transitive npm lockfile entry resolved from %s with the default config", async (_label, resolved) => {
    const lockfilePath = await createLockfile(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "demo", version: "1.0.0" },
          "node_modules/is-number": { version: "4.0.0", resolved }
        }
      })
    );

    const result = await evaluate(lockfilePath, createConfig());

    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-untrusted-source"]);
    expect(result.blockedReasons[0]?.message).toContain("is-number@4.0.0");
  });

  it("blocks a nested npm lockfile record from another host that shares name and version with a registry record", async () => {
    const lockfilePath = await createLockfile(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "demo", version: "1.0.0" },
          "node_modules/is-number": {
            version: "4.0.0",
            resolved: "https://registry.npmjs.org/is-number/-/is-number-4.0.0.tgz"
          },
          "node_modules/parent/node_modules/is-number": {
            version: "4.0.0",
            resolved: "https://evil.example/is-number-4.0.0.tgz"
          }
        }
      })
    );

    const result = await evaluate(lockfilePath, createConfig());

    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-untrusted-source"]);
    expect(result.blockedReasons[0]?.message).toContain("is-number@4.0.0");
  });

  it("blocks a transitive pnpm lockfile entry resolved from another host with the default config", async () => {
    const lockfilePath = await createLockfile(
      "pnpm-lock.yaml",
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  is-number@4.0.0:",
        "    resolution: {integrity: sha512-x, tarball: https://evil.example/is-number-4.0.0.tgz}",
        ""
      ].join("\n")
    );

    const result = await evaluate(lockfilePath, createConfig());

    expect(result.blockedReasons.map((reason) => reason.code)).toEqual(["transitive-untrusted-source"]);
  });

  it("accepts entries from the public registry and from the configured registry", async () => {
    const lockfilePath = await createLockfile(
      "package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "demo", version: "1.0.0" },
          "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
          "node_modules/b": { version: "1.0.0", resolved: "https://mirror.example/npm/b/-/b-1.0.0.tgz" }
        }
      })
    );

    const result = await evaluate(lockfilePath, createConfig({ registryUrl: "https://mirror.example/npm/" }));

    expect(result.blockedReasons).toHaveLength(0);
  });

  it("preserves clean evaluation for a supported valid lockfile", async () => {
    const lockfilePath = await createLockfile(
      "package-lock.json",
      JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "demo", version: "1.0.0" } } })
    );

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("preserves clean evaluation for a supported pnpm lockfile", async () => {
    const lockfilePath = await createLockfile(
      "pnpm-lock.yaml",
      "lockfileVersion: '9.0'\npackages: {}\n"
    );

    const result = await evaluate(lockfilePath);

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
