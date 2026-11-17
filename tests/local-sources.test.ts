import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckFlow } from "../src/check-flow";
import { authorizeDecisions } from "../src/decision-authorize";
import { appendDecisionRecord } from "../src/decision-store";
import { bindFileAsStaged, resolveGitRepo } from "../src/git-blob";
import { LocalSourceClassifier } from "../src/local-source";
import type { CliResult, RequestedPackage } from "../src/types";
import { createDecisionDraft } from "./helpers/decision-fixture";
import { commitAll, createRepoFixture } from "./helpers/git-fixture";

/**
 * Local sources (`workspace:`, `file:`, `link:`, directory paths, local
 * tarballs) used to bypass allowedSources and the registry -> non-registry
 * trust downgrade entirely. These tests run real monorepo trees.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

function configJson(overrides: Record<string, unknown> = {}): string {
  return json({
    minimumReleaseAgeHours: 0,
    typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
    provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed" },
    continuity: { mode: "off", baselineSize: 5 },
    ...overrides
  });
}

function requested(name: string, spec: string, sourceType: RequestedPackage["sourceType"]): RequestedPackage {
  return { name, raw: `${name}@${spec}`, requested: spec, sourceType };
}

describe("LocalSourceClassifier on real trees", () => {
  async function monorepo(kind: "npm" | "pnpm"): Promise<string> {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFiles(dir, {
      "package.json": json(
        kind === "npm"
          ? { name: "root", private: true, workspaces: ["packages/*", "!packages/ignored"] }
          : { name: "root", private: true }
      ),
      ...(kind === "pnpm" ? { "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/ignored'\n" } : {}),
      "packages/app/package.json": json({ name: "@repo/app" }),
      "packages/shared/package.json": json({ name: "@repo/shared" }),
      "packages/ignored/package.json": json({ name: "@repo/ignored" }),
      "vendor/evil/package.json": json({ name: "evil" }),
      "vendor/evil.tgz": "not really a tarball"
    });
    return dir;
  }

  it.each(["npm", "pnpm"] as const)("keeps first-party workspace members allowed (%s workspaces)", async (kind) => {
    const dir = await monorepo(kind);
    const classify = (spec: string, type: RequestedPackage["sourceType"] = "directory") =>
      new LocalSourceClassifier(path.join(dir, "packages", "app")).classify(requested("@repo/shared", spec, type));

    expect(await classify("workspace:*", "workspace")).toMatchObject({ kind: "member" });
    expect(await classify("workspace:^1.0.0", "workspace")).toMatchObject({ kind: "member" });
    expect(await classify("file:../shared")).toMatchObject({ kind: "member", outsideRepository: false });
    expect(await classify("link:../shared")).toMatchObject({ kind: "member" });
    expect(await classify("../shared")).toMatchObject({ kind: "member" });
    expect(await classify("workspace:../shared", "workspace")).toMatchObject({ kind: "member" });
  });

  it.each(["npm", "pnpm"] as const)("restricts everything else (%s workspaces)", async (kind) => {
    const dir = await monorepo(kind);
    const classify = (spec: string, type: RequestedPackage["sourceType"] = "directory") =>
      new LocalSourceClassifier(path.join(dir, "packages", "app")).classify(requested("evil", spec, type));

    // In the repository, but not a workspace member (or explicitly excluded).
    expect(await classify("file:../../vendor/evil")).toEqual({ kind: "directory", outsideRepository: false });
    expect(await classify("link:../ignored")).toEqual({ kind: "directory", outsideRepository: false });
    // A tarball inside the repository is an unverifiable artifact.
    expect(await classify("file:../../vendor/evil.tgz", "file")).toEqual({ kind: "file", outsideRepository: false });
    // Outside the repository.
    expect(await classify("file:../../../elsewhere")).toEqual({ kind: "directory", outsideRepository: true });
    expect(await classify("link:/tmp/x")).toEqual({ kind: "directory", outsideRepository: true });
    expect(await classify("/opt/evil", "directory")).toEqual({ kind: "directory", outsideRepository: true });
    expect(await classify("~/evil")).toEqual({ kind: "directory", outsideRepository: true });
    expect(await classify("C:\\evil")).toEqual({ kind: "directory", outsideRepository: true });
    expect(await classify("file:/srv/evil.tgz", "file")).toEqual({ kind: "file", outsideRepository: true });
  });

  it("applies brace, class and single-character workspace globs, for inclusion and exclusion", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFiles(dir, {
      "package.json": json({
        name: "root",
        private: true,
        workspaces: ["packages/*", "!packages/{vendor,untrusted}", "libs/lib-?", "tools/[ab]*", "apps/+(x|y)"]
      }),
      "packages/app/package.json": json({ name: "@repo/app" }),
      "packages/shared/package.json": json({ name: "@repo/shared" }),
      "packages/vendor/package.json": json({ name: "vendor" }),
      "packages/untrusted/package.json": json({ name: "untrusted" }),
      "libs/lib-a/package.json": json({ name: "lib-a" }),
      "libs/lib-ab/package.json": json({ name: "lib-ab" }),
      "tools/alpha/package.json": json({ name: "alpha" }),
      "tools/gamma/package.json": json({ name: "gamma" }),
      "apps/x/package.json": json({ name: "x" })
    });
    const classifier = new LocalSourceClassifier(path.join(dir, "packages", "app"));
    const kind = async (spec: string) => (await classifier.classify(requested("dep", spec, "directory")))?.kind;

    expect(await kind("file:../shared")).toBe("member");
    // Excluded with a brace pattern: not a member, so allowedSources applies.
    expect(await kind("file:../vendor")).toBe("directory");
    expect(await kind("file:../untrusted")).toBe("directory");
    expect(await kind("file:../../libs/lib-a")).toBe("member");
    expect(await kind("file:../../libs/lib-ab")).toBe("directory");
    expect(await kind("file:../../tools/alpha")).toBe("member");
    expect(await kind("file:../../tools/gamma")).toBe("directory");
    // An extended glob is not modelled and never grants membership.
    expect(await kind("file:../../apps/x")).toBe("directory");
  });

  it("an exclusion written as an extended glob excludes everything rather than nothing", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFiles(dir, {
      "package.json": json({ name: "root", private: true, workspaces: ["packages/*", "!packages/@(vendor)"] }),
      "packages/app/package.json": json({ name: "@repo/app" }),
      "packages/vendor/package.json": json({ name: "vendor" })
    });
    const classifier = new LocalSourceClassifier(path.join(dir, "packages", "app"));

    expect(await classifier.classify(requested("vendor", "file:../vendor", "directory"))).toMatchObject({
      kind: "directory"
    });
  });

  it("does not let an in-repository symlink to the outside pass as a member", async () => {
    const dir = await monorepo("pnpm");
    const outside = await mkdtemp(path.join(os.tmpdir(), "safeinstall-outside-"));
    tempDirs.push(outside);
    await symlink(outside, path.join(dir, "packages", "sneaky"));

    const result = await new LocalSourceClassifier(path.join(dir, "packages", "app")).classify(
      requested("sneaky", "file:../sneaky", "directory")
    );

    expect(result).toEqual({ kind: "directory", outsideRepository: true });
  });

  it("does not classify registry sources", async () => {
    const dir = await monorepo("npm");
    expect(
      await new LocalSourceClassifier(dir).classify(requested("left-pad", "1.3.0", "registry"))
    ).toBeUndefined();
  });
});

describe("check on real workspace monorepos", () => {
  const PNPM_LOCK_APP = (specifier: string, version: string): string => `lockfileVersion: '9.0'

importers:

  .: {}

  packages/app:
    dependencies:
      '@repo/shared':
        specifier: ${specifier}
        version: ${version}

  packages/shared: {}
`;

  async function pnpmMonorepo(
    spec: string,
    lockVersion: string,
    config: string,
    extra: Record<string, string> = {}
  ): Promise<string> {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFiles(dir, {
      "package.json": json({ name: "root", private: true, packageManager: "pnpm@10.17.0" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "safeinstall.config.json": config,
      "packages/shared/package.json": json({ name: "@repo/shared", version: "1.0.0" }),
      "packages/app/package.json": json({ name: "@repo/app", dependencies: { "@repo/shared": spec } }),
      "pnpm-lock.yaml": PNPM_LOCK_APP(spec, lockVersion),
      ...extra
    });
    return dir;
  }

  const droppedTrust = (result: CliResult): number =>
    result.reasons.filter((reason) => reason.code === "trust-level-dropped").length;
  const untrusted = (result: CliResult): string[] =>
    result.reasons.filter((reason) => reason.code === "untrusted-source").map((reason) => reason.message);

  it.each([
    ["workspace:*", "link:../shared"],
    ["link:../shared", "link:../shared"]
  ])("stays green with the default config and with allowedSources restricted to registry (%s)", async (spec, lockVersion) => {
    for (const config of [configJson(), configJson({ allowedSources: ["registry"] })]) {
      const dir = await pnpmMonorepo(spec, lockVersion, config);
      commitAll(dir, "head");

      const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

      expect(result.reasons).toEqual([]);
      expect(result.decision).toBe("allow");
    }
  });

  it("does not flag workspace-member links as transitive untrusted sources", async () => {
    const config = configJson({
      allowedSources: ["registry"],
      transitive: { mode: "block", checks: ["install-script", "untrusted-source"] }
    });
    const dir = await pnpmMonorepo("workspace:*", "link:../shared", config);
    commitAll(dir, "head");

    const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

    expect(result.reasons).toEqual([]);
    expect(result.decision).toBe("allow");
  });

  it("stays green when a workspace member was already local at HEAD", async () => {
    const dir = await pnpmMonorepo("workspace:*", "link:../shared", configJson());
    commitAll(dir, "head");
    await writeFiles(dir, { "packages/shared/extra.js": "module.exports = 1;\n" });

    const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

    expect(result.decision).toBe("allow");
  });

  it("stays green for a brand new workspace dependency with no registry history", async () => {
    const dir = await pnpmMonorepo("workspace:*", "link:../shared", configJson());
    // HEAD has the app manifest without the dependency at all.
    commitAll(dir, "head");
    await writeFiles(dir, {
      "packages/app/package.json": json({ name: "@repo/app" })
    });
    commitAll(dir, "drop dependency");
    await writeFiles(dir, {
      "packages/app/package.json": json({ name: "@repo/app", dependencies: { "@repo/shared": "workspace:*" } })
    });

    const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

    expect(result.decision).toBe("allow");
  });

  it.each([
    ["workspace:*", "link:../shared", "a workspace member"],
    ["link:../shared", "link:../shared", "a link: to a workspace member"],
    ["file:../../vendor/evil", "file:../../vendor/evil", "a file: directory in the repository"],
    ["link:../../vendor/evil", "link:../../vendor/evil", "a link: directory in the repository"],
    ["file:../../vendor/evil.tgz", "file:../../vendor/evil.tgz", "a local tarball"],
    ["link:../../../elsewhere", "link:../../../elsewhere", "a directory outside the repository"]
  ])("reports a registry to local swap as a trust drop: %s (%s)", async (spec, lockVersion) => {
    const dir = await pnpmMonorepo("^1.0.0", "1.0.0", configJson(), {
      "vendor/evil/package.json": json({ name: "@repo/shared", version: "9.9.9" })
    });
    commitAll(dir, "head with a registry dependency");
    await writeFiles(dir, {
      "packages/app/package.json": json({ name: "@repo/app", dependencies: { "@repo/shared": spec } }),
      "pnpm-lock.yaml": PNPM_LOCK_APP(spec, lockVersion)
    });

    const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

    expect(result.decision).toBe("block");
    expect(droppedTrust(result)).toBeGreaterThan(0);
  });

  it("reports a local source only when allowedSources omits it, using the name of what it is", async () => {
    const restricted = configJson({ allowedSources: ["registry", "workspace"] });
    const cases: Array<[string, string, string]> = [
      ["file:../../vendor/evil", "directory", "directory"],
      ["file:../../vendor/evil.tgz", "file", "file"],
      ["link:../../../elsewhere", "directory", "directory outside"]
    ];
    for (const [spec, , expectedName] of cases) {
      const dir = await pnpmMonorepo(spec, spec, restricted);
      commitAll(dir, "head");

      const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

      expect(result.decision, spec).toBe("block");
      expect(untrusted(result).join(" "), spec).toContain(`(${expectedName.split(" ")[0]}`);
    }
  });

  it("allows an in-repository directory and tarball by default (named in allowedSources)", async () => {
    for (const spec of ["file:../../vendor/evil", "file:../../vendor/evil.tgz"]) {
      const dir = await pnpmMonorepo(spec, spec, configJson());
      commitAll(dir, "head");

      const result = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);

      expect(untrusted(result), spec).toEqual([]);
    }
  });

  it("covers npm workspaces: a local file: dependency checked from the package", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const lock = (spec: string): string =>
      json({
        name: "root",
        lockfileVersion: 3,
        packages: {
          "": { name: "root", workspaces: ["packages/*"] },
          "node_modules/@repo/shared": { resolved: "packages/shared", link: true },
          "packages/shared": { name: "@repo/shared", version: "1.0.0" },
          "packages/app": { name: "@repo/app", dependencies: { "@repo/shared": spec } }
        }
      });
    const files = (spec: string): Record<string, string> => ({
      "package.json": json({ name: "root", private: true, workspaces: ["packages/*"], packageManager: "npm@10.8.0" }),
      "safeinstall.config.json": configJson({ allowedSources: ["registry"] }),
      "packages/shared/package.json": json({ name: "@repo/shared", version: "1.0.0" }),
      "packages/app/package.json": json({ name: "@repo/app", dependencies: { "@repo/shared": spec } }),
      "package-lock.json": lock(spec)
    });
    await writeFiles(dir, files("file:../shared"));
    commitAll(dir, "head");

    const green = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);
    expect(green.reasons.filter((reason) => reason.code === "untrusted-source")).toEqual([]);

    await writeFiles(dir, files("file:../../vendor/evil"));
    const outsideWorkspace = await runCheckFlow(path.join(dir, "packages", "app"), ["check"]);
    expect(outsideWorkspace.reasons.map((reason) => reason.code)).toContain("untrusted-source");
  });
});

describe("decisions authorize on a pnpm monorepo", () => {
  const REGISTRY_URL = "https://registry.npmjs.org";

  const lockfile = (specifier: string, version: string): string => `lockfileVersion: '9.0'

importers:

  .: {}

  packages/app:
    dependencies:
      '@repo/shared':
        specifier: ${specifier}
        version: ${version}

  packages/shared: {}
`;

  async function authorize(baseSpec: string, headSpec: string, headVersion: string) {
    const { dir } = await createRepoFixture(tempDirs);
    const files = (spec: string, version: string): Record<string, string> => ({
      "package.json": json({ name: "root", private: true, packageManager: "pnpm@10.17.0" }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "safeinstall.config.json": configJson(),
      "packages/shared/package.json": json({ name: "@repo/shared", version: "1.0.0" }),
      "packages/app/package.json": json({ name: "@repo/app", dependencies: { "@repo/shared": spec } }),
      "vendor/evil/package.json": json({ name: "@repo/shared", version: "9.9.9" }),
      "pnpm-lock.yaml": lockfile(spec, version)
    });
    // The base commit carries manifests only, so the head lockfile record starts from null.
    await writeFiles(dir, files(baseSpec, ""));
    await rm(path.join(dir, "pnpm-lock.yaml"));
    const base = commitAll(dir, "base");
    const repo = (await resolveGitRepo(dir))!;
    await writeFiles(dir, files(headSpec, headVersion));
    const after = (await bindFileAsStaged(repo, "pnpm-lock.yaml")) ?? null;
    await appendDecisionRecord(
      dir,
      createDecisionDraft({ lockfilePath: "pnpm-lock.yaml", before: null, after, registryUrl: REGISTRY_URL })
    );
    const head = commitAll(dir, "head");
    return authorizeDecisions(dir, { baseRef: base, headRef: head, allowedRegistryUrls: [REGISTRY_URL] });
  }

  const droppedTrust = (result: Awaited<ReturnType<typeof authorize>>): string[] =>
    result.findings.filter((finding) => finding.code === "trust-level-dropped").map((f) => f.message);

  it.each([
    ["workspace:*", "link:../shared"],
    ["file:../../vendor/evil", "file:../../vendor/evil"],
    ["link:../../vendor/evil", "link:../../vendor/evil"]
  ])("blocks a registry to local swap against the base commit: %s", async (headSpec, headVersion) => {
    const result = await authorize("^1.0.0", headSpec, headVersion);

    expect(result.ok, JSON.stringify(result.findings)).toBe(false);
    expect(droppedTrust(result).length, JSON.stringify(result.findings)).toBeGreaterThan(0);
  });

  it("does not flag a workspace member that was already local at the base commit", async () => {
    const result = await authorize("workspace:*", "workspace:*", "link:../shared");

    expect(droppedTrust(result)).toEqual([]);
  });
});
