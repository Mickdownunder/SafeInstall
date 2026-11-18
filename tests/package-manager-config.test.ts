import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { packageManagerConfigReasons, parseNpmrc } from "../src/package-manager-config";

/**
 * The package manager reads `.npmrc`, `pnpm-workspace.yaml` and
 * `npm_config_*` variables by itself. Settings that move its reads and
 * writes, switch off its checks or make it load code must stop the install;
 * credentials and ordinary settings must not.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A repository (marked by `.git`) with a package in `packages/app`. */
async function repository(files: Record<string, string>): Promise<{ root: string; packageDir: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "safeinstall-pm-config-")));
  tempDirs.push(root);
  await mkdir(path.join(root, ".git"));
  const packageDir = path.join(root, "packages", "app");
  await mkdir(packageDir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { root, packageDir };
}

const keys = (reasons: Array<{ message: string }>): string[] =>
  reasons.map((reason) => /sets "([^"]+)"/.exec(reason.message)?.[1] ?? reason.message);

describe("parseNpmrc", () => {
  it("reads key=value lines and skips comments", () => {
    expect(parseNpmrc("# note\n; other\n\nstore-dir = ./s\nfoo[]=a\nflag\nquoted=\"x y\"\n")).toEqual([
      ["store-dir", "./s"],
      ["foo[]", "a"],
      ["flag", "true"],
      ["quoted", "x y"]
    ]);
  });
});

describe("packageManagerConfigReasons for pnpm", () => {
  it.each([
    "modules-dir=../outside/node_modules",
    "virtual-store-dir=../outside-vs",
    "store-dir=./repo-store",
    "lockfile-dir=../elsewhere",
    "global-dir=./g",
    "verify-store-integrity=false",
    "strict-store-pkg-content-check=false",
    "lockfile=false",
    "ignore-scripts=false",
    "ignore-pnpmfile=false",
    "pnpmfile=./hook.cjs",
    "use-node-version=22.0.0",
    "node-mirror:release=https://mirror.example/node/",
    "MODULES_DIR=../outside"
  ])("blocks a project .npmrc with %s", async (line) => {
    const { packageDir } = await repository({ "packages/app/.npmrc": `${line}\n` });

    const reasons = await packageManagerConfigReasons("pnpm", packageDir, {});

    expect(reasons.map((reason) => reason.code)).toEqual(["unsafe-package-manager-config"]);
    expect(reasons[0]?.message).toContain(".npmrc");
    expect(keys(reasons)).toEqual([line.split("=")[0]]);
  });

  it("leaves credentials, registry scopes and ordinary settings alone", async () => {
    const { packageDir } = await repository({
      "packages/app/.npmrc": [
        "# private registry",
        "//npm.example.com/:_authToken=${NPM_TOKEN}",
        "@acme:registry=https://npm.example.com/",
        "registry=https://registry.npmjs.org/",
        "auto-install-peers=true",
        "node-linker=hoisted",
        "verify-store-integrity=true",
        "ignore-scripts=true",
        ""
      ].join("\n")
    });

    expect(await packageManagerConfigReasons("pnpm", packageDir, {})).toEqual([]);
  });

  it("reads the settings of pnpm-workspace.yaml in their camelCase form", async () => {
    const { packageDir } = await repository({
      "pnpm-workspace.yaml": [
        "packages:",
        "  - 'packages/*'",
        "modulesDir: ../outside",
        "verifyStoreIntegrity: false",
        "autoInstallPeers: true",
        ""
      ].join("\n")
    });

    const reasons = await packageManagerConfigReasons("pnpm", packageDir, {});

    expect(keys(reasons)).toEqual(["modulesDir", "verifyStoreIntegrity"]);
    expect(reasons[0]?.message).toContain("pnpm-workspace.yaml");
  });

  it("covers the repository root above the package, and nothing above the repository", async () => {
    const { root, packageDir } = await repository({ ".npmrc": "store-dir=./repo-store\n" });
    // A file one level above the repository belongs to someone else.
    const outside = path.join(path.dirname(root), `.npmrc-${path.basename(root)}`);
    await writeFile(outside, "modules-dir=../x\n");
    tempDirs.push(outside);

    const reasons = await packageManagerConfigReasons("pnpm", packageDir, {});

    expect(keys(reasons)).toEqual(["store-dir"]);
  });

  it("blocks unsafe settings that arrive through the environment", async () => {
    const { packageDir } = await repository({});

    const reasons = await packageManagerConfigReasons("pnpm", packageDir, {
      npm_config_modules_dir: "/tmp/elsewhere",
      NPM_CONFIG_VERIFY_STORE_INTEGRITY: "false",
      pnpm_config_virtual_store_dir: "/tmp/vs",
      npm_config_registry: "https://registry.npmjs.org/",
      PATH: "/usr/bin"
    });

    expect(keys(reasons).sort()).toEqual(
      ["NPM_CONFIG_VERIFY_STORE_INTEGRITY", "npm_config_modules_dir", "pnpm_config_virtual_store_dir"].sort()
    );
    expect(reasons.every((reason) => reason.message.includes("the environment"))).toBe(true);
  });

  it("accepts a store directory the user or CI sets for itself", async () => {
    const { packageDir } = await repository({});

    expect(await packageManagerConfigReasons("pnpm", packageDir, { npm_config_store_dir: "/home/ci/.pnpm-store" })).toEqual([]);
  });

  it("treats a user configuration file inside the project as project content", async () => {
    const { root, packageDir } = await repository({ "ci/npmrc": "store-dir=./repo-store\n" });

    const reasons = await packageManagerConfigReasons("pnpm", packageDir, {
      npm_config_userconfig: path.join(root, "ci", "npmrc")
    });

    expect(keys(reasons)).toEqual(["store-dir"]);
  });
});

describe("packageManagerConfigReasons for npm", () => {
  it.each(["prefix=../outside", "git=./fake-git.sh", "script-shell=./sh", "node-options=--require ./x.js", "ignore-scripts=false"])(
    "blocks a project .npmrc with %s",
    async (line) => {
      const { packageDir } = await repository({ "packages/app/.npmrc": `${line}\n` });

      expect(keys(await packageManagerConfigReasons("npm", packageDir, {}))).toEqual([line.split("=")[0]]);
    }
  );

  it("leaves a cache directory and credentials alone", async () => {
    const { packageDir } = await repository({
      "packages/app/.npmrc": "cache=./.npm-cache\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nstore-dir=./pnpm-only\n"
    });

    expect(await packageManagerConfigReasons("npm", packageDir, {})).toEqual([]);
  });
});
