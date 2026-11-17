import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckFlow } from "../src/check-flow";
import type { CliResult } from "../src/types";
import { commitAll, createRepoFixture } from "./helpers/git-fixture";

/**
 * Project-level `safeinstall check` takes the prior source of each dependency
 * from the manifest at git HEAD, so editing package.json in the working tree
 * cannot erase a registry to git/url/tarball swap. Configured sourceBaselines
 * only apply when there is no HEAD manifest to compare against.
 */

const tempDirs: string[] = [];
const GIT_SPEC = "git+https://example.test/swap-me.git";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function configJson(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      minimumReleaseAgeHours: 0,
      allowedSources: ["registry", "git"],
      typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
      provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed" },
      transitive: { mode: "off", checks: ["install-script", "untrusted-source"] },
      continuity: { mode: "off", baselineSize: 5 },
      ...overrides
    }) + "\n"
  );
}

function manifestJson(spec: string): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "swap-me": spec } }) + "\n";
}

function lockfileJson(spec: string): string {
  const entry =
    spec === GIT_SPEC
      ? { version: spec, resolved: spec }
      : {
          version: spec,
          resolved: `https://registry.npmjs.org/swap-me/-/swap-me-${spec}.tgz`,
          integrity: INTEGRITY
        };
  return (
    JSON.stringify({
      name: "demo",
      lockfileVersion: 3,
      packages: {
        "": { name: "demo", dependencies: { "swap-me": spec } },
        "node_modules/swap-me": entry
      }
    }) + "\n"
  );
}

async function writeProject(dir: string, spec: string, config = configJson()): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), manifestJson(spec));
  await writeFile(path.join(dir, "package-lock.json"), lockfileJson(spec));
  await writeFile(path.join(dir, "safeinstall.config.json"), config);
}

async function gitProject(headSpec: string): Promise<string> {
  const { dir } = await createRepoFixture(tempDirs);
  await writeProject(dir, headSpec);
  commitAll(dir, "head");
  return dir;
}

const droppedTrust = (result: CliResult): number =>
  result.reasons.filter((reason) => reason.code === "trust-level-dropped").length;

describe("safeinstall check: source baseline from git HEAD", () => {
  it("blocks a working-tree registry to git swap even though git sources are allowed", async () => {
    const dir = await gitProject("1.0.0");
    await writeProject(dir, GIT_SPEC);

    const result = await runCheckFlow(dir, ["check"]);

    expect(result.decision).toBe("block");
    expect(droppedTrust(result)).toBeGreaterThan(0);
  });

  it("ignores a working-tree sourceBaselines entry when HEAD has the manifest", async () => {
    const dir = await gitProject("1.0.0");
    await writeProject(dir, GIT_SPEC, configJson({ sourceBaselines: { "swap-me": "git" } }));

    const result = await runCheckFlow(dir, ["check"]);

    expect(result.decision).toBe("block");
    expect(droppedTrust(result)).toBeGreaterThan(0);
  });

  it("blocks a swap in a workspace package manifest checked from that directory", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }) + "\n");
    await writeFile(path.join(dir, "safeinstall.config.json"), configJson());
    const nested = path.join(dir, "packages", "app");
    await writeProject(nested, "1.0.0", configJson());
    commitAll(dir, "head");
    await writeProject(nested, GIT_SPEC, configJson());

    const result = await runCheckFlow(nested, ["check"]);

    expect(result.decision).toBe("block");
    expect(droppedTrust(result)).toBeGreaterThan(0);
  });

  it("passes a git dependency that is already present at HEAD without sourceBaselines", async () => {
    const dir = await gitProject(GIT_SPEC);

    const result = await runCheckFlow(dir, ["check"]);

    expect(result.reasons).toEqual([]);
    expect(result.decision).toBe("allow");
  });

  it("fails closed outside git: an unavailable baseline blocks, and sourceBaselines lifts it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-check-nogit-"));
    tempDirs.push(dir);
    await writeProject(dir, GIT_SPEC);

    const blocked = await runCheckFlow(dir, ["check"]);
    expect(blocked.decision).toBe("block");
    expect(droppedTrust(blocked)).toBeGreaterThan(0);

    await writeFile(
      path.join(dir, "safeinstall.config.json"),
      configJson({ sourceBaselines: { "swap-me": "git" } })
    );
    const allowed = await runCheckFlow(dir, ["check"]);
    expect(allowed.reasons).toEqual([]);
    expect(allowed.decision).toBe("allow");
  });

  it("falls back to sourceBaselines when the manifest is untracked at HEAD", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFile(path.join(dir, "README.md"), "x\n");
    commitAll(dir, "unrelated first commit");
    await writeProject(dir, GIT_SPEC);

    const blocked = await runCheckFlow(dir, ["check"]);
    expect(droppedTrust(blocked)).toBeGreaterThan(0);

    await writeFile(
      path.join(dir, "safeinstall.config.json"),
      configJson({ sourceBaselines: { "swap-me": "git" } })
    );
    const allowed = await runCheckFlow(dir, ["check"]);
    expect(allowed.reasons).toEqual([]);
  });
});
