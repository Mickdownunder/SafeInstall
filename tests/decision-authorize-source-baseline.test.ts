import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authorizeDecisions } from "../src/decision-authorize";
import { bindFileAsStaged, resolveGitRepo } from "../src/git-blob";
import { appendDecisionRecord } from "../src/decision-store";
import { createDecisionDraft } from "./helpers/decision-fixture";
import { commitAll, createRepoFixture } from "./helpers/git-fixture";

/**
 * `decisions authorize` derives each dependency's PRIOR source from the
 * manifest at the trusted base commit, for the root project and for every
 * importer, and never from the (attacker-committable) config sourceBaselines.
 */

const tempDirs: string[] = [];
const REGISTRY_URL = "https://registry.npmjs.org";
const GIT_SPEC = "git+https://example.test/swap-me.git";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function configJson(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      minimumReleaseAgeHours: 0,
      allowedScripts: {},
      allowedSources: ["registry", "git"],
      allowedPackages: [],
      typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
      provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed" },
      transitive: { mode: "off", checks: ["install-script", "untrusted-source"] },
      continuity: { mode: "off", baselineSize: 5 },
      ...overrides
    }) + "\n"
  );
}

function manifestJson(name: string, dependencies: Record<string, string>): string {
  return JSON.stringify({ name, version: "1.0.0", dependencies }) + "\n";
}

/** An npm lockfile for one package whose dependencies are all git sources. */
function gitLockfile(
  name: string,
  dependencies: Record<string, string>,
  workspaces: Record<string, { name: string; dependencies: Record<string, string> }> = {}
): string {
  const packages: Record<string, unknown> = { "": { name, dependencies } };
  for (const [dir, workspace] of Object.entries(workspaces)) {
    packages[dir] = { name: workspace.name, dependencies: workspace.dependencies };
  }
  for (const [depName, spec] of Object.entries(dependencies)) {
    packages[`node_modules/${depName}`] = { version: spec, resolved: spec };
  }
  for (const [dir, workspace] of Object.entries(workspaces)) {
    for (const [depName, spec] of Object.entries(workspace.dependencies)) {
      packages[`${dir}/node_modules/${depName}`] = { version: spec, resolved: spec };
    }
  }
  return JSON.stringify({ name, lockfileVersion: 3, packages }) + "\n";
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

interface Scenario {
  baseFiles: Record<string, string>;
  headFiles: Record<string, string>;
  /** Head-commit lockfiles that get a verified decision record. */
  lockfiles: string[];
  headConfig?: string;
  removeAtHead?: string[];
}

async function authorizeScenario(scenario: Scenario) {
  const { dir } = await createRepoFixture(tempDirs);
  await writeFiles(dir, { "safeinstall.config.json": configJson(), ...scenario.baseFiles });
  const base = commitAll(dir, "base");
  const repo = (await resolveGitRepo(dir))!;

  for (const removed of scenario.removeAtHead ?? []) {
    await rm(path.join(dir, removed), { force: true });
  }
  await writeFiles(dir, {
    ...(scenario.headConfig ? { "safeinstall.config.json": scenario.headConfig } : {}),
    ...scenario.headFiles
  });
  for (const lockfilePath of scenario.lockfiles) {
    const after = (await bindFileAsStaged(repo, lockfilePath)) ?? null;
    await appendDecisionRecord(
      dir,
      createDecisionDraft({ lockfilePath, before: null, after, registryUrl: REGISTRY_URL })
    );
  }
  const head = commitAll(dir, "head");
  return authorizeDecisions(dir, {
    baseRef: base,
    headRef: head,
    allowedRegistryUrls: [REGISTRY_URL]
  });
}

const ATTACKER_CONFIG = configJson({ sourceBaselines: { "swap-me": "git" } });
const droppedTrust = (result: Awaited<ReturnType<typeof authorizeScenario>>): string[] =>
  result.findings.filter((finding) => finding.code === "trust-level-dropped").map((f) => f.message);

describe("decisions authorize: source baseline from the base commit", () => {
  const rootBase = { "package.json": manifestJson("root", { "swap-me": "1.0.0" }) };

  it.each([
    ["root project with a verified root lockfile", {}],
    ["same, with an attacker-added sourceBaselines entry", { headConfig: ATTACKER_CONFIG }]
  ])("blocks a registry to git swap: %s", async (_label, extra) => {
    const result = await authorizeScenario({
      baseFiles: rootBase,
      headFiles: {
        "package.json": manifestJson("root", { "swap-me": GIT_SPEC }),
        "package-lock.json": gitLockfile("root", { "swap-me": GIT_SPEC })
      },
      lockfiles: ["package-lock.json"],
      ...extra
    });

    expect(result.ok).toBe(false);
    expect(droppedTrust(result).length).toBeGreaterThan(0);
  });

  it.each([
    ["root block (lockfile-less root, nested lockfile only)", {}],
    ["same, with an attacker-added sourceBaselines entry", { headConfig: ATTACKER_CONFIG }]
  ])("blocks a swap in a lockfile-less root project: %s", async (_label, extra) => {
    const result = await authorizeScenario({
      baseFiles: {
        ...rootBase,
        "tools/nested/package.json": manifestJson("nested", {})
      },
      headFiles: {
        "package.json": manifestJson("root", { "swap-me": GIT_SPEC }),
        "tools/nested/package-lock.json": gitLockfile("nested", {})
      },
      lockfiles: ["tools/nested/package-lock.json"],
      ...extra
    });

    expect(result.ok).toBe(false);
    expect(droppedTrust(result).length).toBeGreaterThan(0);
  });

  it.each([
    ["no config entry", {}],
    ["attacker-added sourceBaselines entry", { headConfig: ATTACKER_CONFIG }]
  ])("blocks a swap inside a nested project with its own lockfile (%s)", async (_label, extra) => {
    const result = await authorizeScenario({
      baseFiles: {
        "package.json": manifestJson("root", {}),
        "tools/nested/package.json": manifestJson("nested", { "swap-me": "1.0.0" })
      },
      headFiles: {
        "tools/nested/package.json": manifestJson("nested", { "swap-me": GIT_SPEC }),
        "tools/nested/package-lock.json": gitLockfile("nested", { "swap-me": GIT_SPEC })
      },
      lockfiles: ["tools/nested/package-lock.json"],
      ...extra
    });

    expect(result.ok).toBe(false);
    expect(droppedTrust(result).length).toBeGreaterThan(0);
  });

  it.each([
    ["no config entry", {}],
    ["attacker-added sourceBaselines entry", { headConfig: ATTACKER_CONFIG }]
  ])("blocks a swap in a workspace package of a root lockfile (%s)", async (_label, extra) => {
    const workspaceDeps = { "swap-me": GIT_SPEC };
    const result = await authorizeScenario({
      baseFiles: {
        "package.json": JSON.stringify({ name: "root", version: "1.0.0", workspaces: ["packages/*"] }) + "\n",
        "packages/app/package.json": manifestJson("app", { "swap-me": "1.0.0" })
      },
      headFiles: {
        "packages/app/package.json": manifestJson("app", workspaceDeps),
        "package-lock.json": gitLockfile("root", {}, {
          "packages/app": { name: "app", dependencies: workspaceDeps }
        })
      },
      lockfiles: ["package-lock.json"],
      ...extra
    });

    expect(result.ok).toBe(false);
    expect(droppedTrust(result).length).toBeGreaterThan(0);
  });

  it("allows a dependency that was already a git dependency at the base commit", async () => {
    const result = await authorizeScenario({
      baseFiles: {
        "package.json": manifestJson("root", { "swap-me": GIT_SPEC }),
        "tools/nested/package.json": manifestJson("nested", { "swap-me": GIT_SPEC })
      },
      headFiles: {
        "package-lock.json": gitLockfile("root", { "swap-me": GIT_SPEC }),
        "tools/nested/package-lock.json": gitLockfile("nested", { "swap-me": GIT_SPEC })
      },
      lockfiles: ["package-lock.json", "tools/nested/package-lock.json"]
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["no config entry", {}],
    ["attacker-added sourceBaselines entry", { headConfig: ATTACKER_CONFIG }]
  ])("blocks a swap in an importer directory moved in the head commit (%s)", async (_label, extra) => {
    const result = await authorizeScenario({
      baseFiles: {
        "package.json": manifestJson("root", {}),
        "tools/old/package.json": manifestJson("mover", { "swap-me": "1.0.0" })
      },
      removeAtHead: ["tools/old/package.json"],
      headFiles: {
        "tools/new/package.json": manifestJson("mover", { "swap-me": GIT_SPEC }),
        "tools/new/package-lock.json": gitLockfile("mover", { "swap-me": GIT_SPEC })
      },
      lockfiles: ["tools/new/package-lock.json"],
      ...extra
    });

    expect(result.ok).toBe(false);
    expect(droppedTrust(result).length).toBeGreaterThan(0);
  });

  it("applies ordinary source policy to a brand-new importer with a git dependency", async () => {
    const files = {
      headFiles: {
        "tools/fresh/package.json": manifestJson("fresh", { "swap-me": GIT_SPEC }),
        "tools/fresh/package-lock.json": gitLockfile("fresh", { "swap-me": GIT_SPEC })
      },
      baseFiles: { "package.json": manifestJson("root", {}) },
      lockfiles: ["tools/fresh/package-lock.json"]
    };

    const allowed = await authorizeScenario(files);
    expect(droppedTrust(allowed)).toEqual([]);
    expect(allowed.findings).toEqual([]);
    expect(allowed.ok).toBe(true);

    const denied = await authorizeScenario({
      ...files,
      headConfig: configJson({ allowedSources: ["registry"] })
    });
    expect(denied.ok).toBe(false);
    expect(denied.findings.map((finding) => finding.code)).toContain("untrusted-source");
    expect(droppedTrust(denied)).toEqual([]);
  });
});
