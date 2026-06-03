import { describe, expect, it } from "vitest";

import {
  collectNpmTransitivePackages,
  collectPnpmTransitivePackages,
  evaluateTransitivePackages,
  parsePnpmPackageKey
} from "../src/transitive";
import type { TransitivePackage } from "../src/transitive";
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
    typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
    provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed" },
    transitive: { mode: "off", checks: ["install-script", "untrusted-source"] },
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
