import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckFlow } from "../src/check-flow";

const tempDirs: string[] = [];

async function createProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-transitive-"));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(path.join(dir, name), content, "utf8"))
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// These integration tests use a file: direct dependency so the direct-dep
// evaluation never touches the registry. That keeps the test fully offline
// while still exercising the transitive lockfile walk end-to-end through
// runCheckFlow.

const PACKAGE_JSON = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  packageManager: "npm@10.8.0",
  dependencies: { "local-lib": "file:./local-lib" }
});

const BUN_PACKAGE_JSON = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  packageManager: "bun@1.3.0",
  dependencies: { "local-lib": "file:./local-lib" }
});

function lockfileWith(transitive: Record<string, unknown>): string {
  return JSON.stringify({
    name: "demo",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "demo", version: "1.0.0", dependencies: { "local-lib": "file:./local-lib" } },
      "node_modules/local-lib": { resolved: "local-lib", link: true },
      ...transitive
    }
  });
}

describe("transitive evaluation through runCheckFlow", () => {
  it("blocks a transitive lockfile entry from another host with the default transitive mode", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/is-number": {
          version: "4.0.0",
          resolved: "https://evil.example/is-number-4.0.0.tgz",
          integrity: "sha512-x"
        }
      }),
      // No `transitive` key: the lockfile source check does not depend on it.
      "safeinstall.config.json": JSON.stringify({ minimumReleaseAgeHours: 0 })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain("transitive-untrusted-source");
    expect(result.reasons.some((reason) => reason.message.includes("is-number@4.0.0"))).toBe(true);
  });

  it("blocks a nested package that shares a direct dependency name", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/parent/node_modules/local-lib": {
          version: "0.0.1",
          resolved: "https://registry.npmjs.org/local-lib/-/local-lib-0.0.1.tgz",
          integrity: "sha512-x",
          hasInstallScript: true
        }
      }),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "block", checks: ["install-script"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.reasons.some((r) => r.message.includes("local-lib@0.0.1"))).toBe(true);
  });

  it("blocks a direct local source omitted from allowedSources", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({}),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        allowedSources: ["registry"]
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.exitCode).toBe(2);
    expect(result.reasons.map((reason) => reason.code)).toContain("untrusted-source");
    expect(result.affectedPackages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "local-lib", sourceType: "directory" })
      ])
    );
  });

  it("blocks a transitive dependency with an install script when configured", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/sketchy": {
          version: "0.0.1",
          resolved: "https://registry.npmjs.org/sketchy/-/sketchy-0.0.1.tgz",
          integrity: "sha512-x",
          hasInstallScript: true
        }
      }),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "block", checks: ["install-script"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.exitCode).toBe(2);
    expect(result.reasons.map((r) => r.code)).toContain("transitive-install-script");
    expect(result.reasons.some((r) => r.message.includes("sketchy@0.0.1"))).toBe(true);
  });

  it("blocks a transitive dependency from an untrusted source when configured", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/from-git": {
          version: "2.0.0",
          resolved: "git+ssh://git@github.com/evil/from-git.git#abc"
        }
      }),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        allowedSources: ["registry", "workspace", "file", "directory"],
        transitive: { mode: "block", checks: ["untrusted-source"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.reasons.map((r) => r.code)).toContain("transitive-untrusted-source");
    expect(result.reasons.some((r) => r.message.includes("from-git"))).toBe(true);
  });

  it("warns instead of blocking in warn mode", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/sketchy": {
          version: "0.0.1",
          resolved: "https://registry.npmjs.org/sketchy/-/sketchy-0.0.1.tgz",
          integrity: "sha512-x",
          hasInstallScript: true
        }
      }),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "warn", checks: ["install-script"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("allow");
    expect(result.warnings.some((w) => w.includes("install script"))).toBe(true);
  });

  it("blocks check mode when transitive policy has no lockfile evidence", async () => {
    const cwd = await createProject({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.0.0",
        dependencies: { "local-lib": "file:./local-lib" }
      }),
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "block", checks: ["untrusted-source"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain(
      "transitive-evaluation-unavailable"
    );
  });

  it("blocks Bun check mode when its transitive lockfile is unsupported", async () => {
    const cwd = await createProject({
      "package.json": BUN_PACKAGE_JSON,
      "bun.lock": "lockfileVersion = 1",
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "block", checks: ["untrusted-source"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain(
      "transitive-evaluation-unavailable"
    );
  });

  it("warns in check mode when transitive lockfile evidence is unavailable", async () => {
    const cwd = await createProject({
      "package.json": BUN_PACKAGE_JSON,
      "safeinstall.config.json": JSON.stringify({
        minimumReleaseAgeHours: 0,
        transitive: { mode: "warn", checks: ["untrusted-source"] }
      })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("allow");
    expect(result.warnings.some((warning) => warning.includes("no npm or pnpm lockfile was found"))).toBe(true);
  });

  it("does not evaluate transitive deps when mode is off (default)", async () => {
    const cwd = await createProject({
      "package.json": PACKAGE_JSON,
      "package-lock.json": lockfileWith({
        "node_modules/sketchy": {
          version: "0.0.1",
          resolved: "https://registry.npmjs.org/sketchy/-/sketchy-0.0.1.tgz",
          integrity: "sha512-x",
          hasInstallScript: true
        }
      }),
      "safeinstall.config.json": JSON.stringify({ minimumReleaseAgeHours: 0 })
    });

    const result = await runCheckFlow(cwd, ["check"]);

    expect(result.decision).toBe("allow");
    expect(result.reasons).toHaveLength(0);
  });
});
