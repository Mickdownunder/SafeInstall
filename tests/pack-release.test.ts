import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { buildRuntimeLockfile, releaseManifest } from "../scripts/pack-release.mjs";
import { projectRoot } from "./cli-e2e-helpers";

/**
 * The release tarball bundles its runtime dependencies, installed with
 * `npm ci` from a lockfile written from pnpm-lock.yaml. Whatever the lockfile
 * does not pin to a registry version with a SHA-512 digest stops the release.
 */

const SEMVER_INTEGRITY = "sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==";

function manifest(dependencies: Record<string, string> = { semver: "^7.0.0" }) {
  return { name: "safeinstall-cli", version: "1.0.0", dependencies, devDependencies: { vitest: "4.0.0" } };
}

function lockfile(overrides: { packages?: Record<string, unknown>; snapshots?: Record<string, unknown> } = {}) {
  return {
    lockfileVersion: "9.0",
    importers: { ".": { dependencies: { semver: { specifier: "^7.0.0", version: "7.8.5" } } } },
    packages: { "semver@7.8.5": { resolution: { integrity: SEMVER_INTEGRITY } }, ...overrides.packages },
    snapshots: { "semver@7.8.5": {}, ...overrides.snapshots }
  };
}

describe("release lockfile from pnpm-lock.yaml", () => {
  it("pins the whole runtime closure of this repository to the digests of pnpm-lock.yaml", async () => {
    const repositoryManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const pnpmLock = parse(await readFile(path.join(projectRoot, "pnpm-lock.yaml"), "utf8"));
    const result = buildRuntimeLockfile(repositoryManifest, pnpmLock);

    expect(result.packages[""]).toEqual({
      name: "safeinstall-cli",
      version: repositoryManifest.version,
      dependencies: repositoryManifest.dependencies
    });
    const pinned = Object.entries(result.packages).filter(([key]) => key !== "");
    expect(pinned.map(([key]) => key)).toEqual(expect.arrayContaining(
      Object.keys(repositoryManifest.dependencies).map((name) => `node_modules/${name}`)
    ));
    for (const [key, entry] of pinned) {
      const { version, integrity, resolved } = entry as { version: string; integrity: string; resolved: string };
      const name = key.slice("node_modules/".length);
      expect(pnpmLock.packages[`${name}@${version}`].resolution.integrity, key).toBe(integrity);
      expect(resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });

  it("follows transitive dependencies and strips peer suffixes", () => {
    const result = buildRuntimeLockfile(manifest(), lockfile({
      packages: { "lru-cache@10.4.3": { resolution: { integrity: SEMVER_INTEGRITY } } },
      snapshots: { "semver@7.8.5": { dependencies: { "lru-cache": "10.4.3(typescript@5.9.3)" } }, "lru-cache@10.4.3(typescript@5.9.3)": {} }
    }));
    expect(result.packages["node_modules/semver"]).toMatchObject({ version: "7.8.5", dependencies: { "lru-cache": "10.4.3" } });
    expect(result.packages["node_modules/lru-cache"]).toMatchObject({
      version: "10.4.3",
      resolved: "https://registry.npmjs.org/lru-cache/-/lru-cache-10.4.3.tgz"
    });
  });

  it.each([
    ["a tarball from another host", { packages: { "semver@7.8.5": { resolution: { tarball: "https://evil.example/semver.tgz", integrity: SEMVER_INTEGRITY } } } }],
    ["a git resolution", { packages: { "semver@7.8.5": { resolution: { type: "git", repo: "https://evil.example/semver", commit: "abc" } } } }],
    ["a SHA-1 digest", { packages: { "semver@7.8.5": { resolution: { integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" } } } }],
    ["a missing snapshot", { snapshots: { "semver@7.8.5": undefined } }],
    ["a transitive link", { snapshots: { "semver@7.8.5": { dependencies: { evil: "link:../evil" } } } }],
    ["optional dependencies", { snapshots: { "semver@7.8.5": { optionalDependencies: { fsevents: "2.3.3" } } } }]
  ])("refuses %s", (_label, overrides) => {
    expect(() => buildRuntimeLockfile(manifest(), lockfile(overrides))).toThrow(/pack-release:/);
  });

  it("refuses two versions of one package, a stale specifier and another lockfile version", () => {
    const twoVersions = lockfile({
      packages: {
        "a@1.0.0": { resolution: { integrity: SEMVER_INTEGRITY } },
        "semver@6.3.1": { resolution: { integrity: SEMVER_INTEGRITY } }
      },
      snapshots: { "semver@7.8.5": { dependencies: { a: "1.0.0" } }, "a@1.0.0": { dependencies: { semver: "6.3.1" } }, "semver@6.3.1": {} }
    });
    expect(() => buildRuntimeLockfile(manifest(), twoVersions)).toThrow("semver is locked at 7.8.5 and 6.3.1");
    expect(() => buildRuntimeLockfile(manifest({ semver: "^7.9.0" }), lockfile())).toThrow("package.json asks for ^7.9.0");
    expect(() => buildRuntimeLockfile(manifest({ semver: "^7.0.0", yaml: "^2.0.0" }), lockfile())).toThrow("differ");
    expect(() => buildRuntimeLockfile(manifest(), { ...lockfile(), lockfileVersion: "6.0" })).toThrow("version 9.0");
  });

  it("publishes the manifest with every runtime dependency bundled and no devDependencies", () => {
    const published = releaseManifest(manifest({ yaml: "^2.0.0", semver: "^7.0.0" }));
    expect(published.bundleDependencies).toEqual(["semver", "yaml"]);
    expect(published).not.toHaveProperty("devDependencies");
    expect(published.dependencies).toEqual({ yaml: "^2.0.0", semver: "^7.0.0" });
  });
});
