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
      "node_modules/linked": { link: true, resolved: "" }
    }
  };

  it("collects transitive packages excluding root, direct deps, and links", () => {
    const packages = collectNpmTransitivePackages(lockfile, new Set(["axios"]));
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["from-git", "sketchy"]);
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
});

describe("collectPnpmTransitivePackages", () => {
  const lockfile = {
    packages: {
      "axios@1.14.0": { resolution: { integrity: "sha512-x" } },
      "lodash@4.17.21": { resolution: { integrity: "sha512-y" } },
      "from-tarball@1.0.0": {
        resolution: { tarball: "https://evil.example.com/pkg-1.0.0.tgz" }
      }
    }
  };

  it("collects transitive packages excluding direct deps", () => {
    const packages = collectPnpmTransitivePackages(lockfile, new Set(["axios"]));
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["from-tarball", "lodash"]);
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

  it("returns empty when transitive mode is off", () => {
    const result = evaluateTransitivePackages([withScript, gitDep], createConfig());
    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
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

  it("does not flag workspace/file/directory sources as untrusted", () => {
    const localDep: TransitivePackage = {
      name: "local",
      version: "1.0.0",
      sourceType: "workspace",
      hasInstallScript: false
    };
    const result = evaluateTransitivePackages(
      [localDep],
      createConfig({
        transitive: { mode: "block", checks: ["untrusted-source"] },
        allowedSources: ["registry"]
      })
    );
    expect(result.blockedReasons).toHaveLength(0);
  });
});

describe("evaluateTransitiveDependencies evidence failures", () => {
  const blockConfig = createConfig({
    transitive: { mode: "block", checks: ["install-script", "untrusted-source"] }
  });

  async function evaluate(lockfilePath: string | undefined, config = blockConfig) {
    return evaluateTransitiveDependencies({ lockfilePath, directNames: new Set(), config });
  }

  it("blocks when no supported lockfile was discovered", async () => {
    const result = await evaluate(undefined);

    expect(result.blockedReasons.map((reason) => reason.code)).toContain(
      "transitive-evaluation-unavailable"
    );
    expect(result.blockedReasons[0]?.message).toContain("no supported npm or pnpm lockfile");
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
    expect(result.warnings[0]).toContain("no supported npm or pnpm lockfile");
  });

  it("keeps transitive mode off silent without a lockfile", async () => {
    const result = await evaluate(undefined, createConfig());

    expect(result.blockedReasons).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
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
