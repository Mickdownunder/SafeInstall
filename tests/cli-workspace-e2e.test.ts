import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createStubPackageManager,
  createTempDir,
  ensureBuiltCli,
  mkdirp,
  readLoggedArgs,
  runCli,
  startRegistryFixture,
  writeDefaultConfig,
  writeJson,
  type RegistryFixture
} from "./cli-e2e-helpers";

let registry: RegistryFixture;

beforeAll(async () => {
  await ensureBuiltCli();
  registry = await startRegistryFixture();
  process.env.SAFEINSTALL_TEST_REGISTRY = registry.url;
});

afterAll(async () => {
  delete process.env.SAFEINSTALL_TEST_REGISTRY;
  await registry?.close();
  await cleanupTempDirs();
});

describe("CLI workspace/root edge cases", () => {
  it("supports pnpm add from a package subdirectory with root config discovery", async () => {
    const cwd = await createTempDir("safeinstall-e2e-pnpm-add-subdir-");
    const packageDir = path.join(cwd, "packages", "app");
    const nestedDir = path.join(packageDir, "src");
    const stub = await createStubPackageManager("pnpm", {
      stdout: "pnpm-add-ok"
    });

    await mkdirp(nestedDir);
    await writeDefaultConfig(cwd);
    await writeJson(path.join(packageDir, "package.json"), {
      name: "@repo/app",
      version: "1.0.0"
    });

    const result = await runCli(["pnpm", "add", "axios@1.13.2", "-D"], {
      cwd: nestedDir,
      env: {
        ...process.env,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Allowed: policy checks passed.");
    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["add", "axios@1.13.2", "-D", "--ignore-scripts"]);
  });

  it("supports npm install with --prefix for one target package", async () => {
    const cwd = await createTempDir("safeinstall-e2e-npm-prefix-install-");
    const packageDir = path.join(cwd, "packages", "app");
    const stub = await createStubPackageManager("npm", {
      stdout: "npm-prefix-ok"
    });

    await mkdirp(packageDir);
    await writeDefaultConfig(cwd);
    await writeJson(path.join(packageDir, "package.json"), {
      name: "@repo/app",
      version: "1.0.0"
    });

    const result = await runCli(["npm", "--prefix", "packages/app", "install", "axios@1.13.2"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["--prefix", "packages/app", "install", "axios@1.13.2", "--ignore-scripts"]);
  });

  it("blocks pnpm install from a subpackage when the importer is missing from the lockfile", async () => {
    const cwd = await createTempDir("safeinstall-e2e-pnpm-missing-importer-");
    const packageDir = path.join(cwd, "packages", "app");
    await mkdirp(packageDir);
    await writeDefaultConfig(cwd, {});
    await writeJson(path.join(cwd, "package.json"), {
      name: "repo",
      version: "1.0.0",
      packageManager: "pnpm@10.28.2"
    });
    await writeJson(path.join(packageDir, "package.json"), {
      name: "@repo/app",
      version: "1.0.0",
      dependencies: {
        axios: "^1.14.0"
      }
    });
    await writeFile(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  .: {}
`
    );

    const result = await runCli(["--json", "pnpm", "install"], {
      cwd: packageDir
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.reasons[0].message).toContain("does not map to a pnpm importer");
  });

  it("blocks npm ci from a subpackage when the package entry is missing from the root lockfile", async () => {
    const cwd = await createTempDir("safeinstall-e2e-npm-missing-package-entry-");
    const packageDir = path.join(cwd, "packages", "app");
    await mkdirp(packageDir);
    await writeDefaultConfig(cwd, {});
    await writeJson(path.join(cwd, "package.json"), {
      name: "repo",
      version: "1.0.0",
      packageManager: "npm@10.8.0"
    });
    await writeJson(path.join(packageDir, "package.json"), {
      name: "@repo/app",
      version: "1.0.0",
      dependencies: {
        axios: "^1.14.0"
      }
    });
    await writeJson(path.join(cwd, "package-lock.json"), {
      name: "repo",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "repo",
          version: "1.0.0"
        }
      }
    });

    const result = await runCli(["--json", "npm", "ci"], {
      cwd: packageDir
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.reasons[0].message).toContain("does not map to a package entry");
  });

  it("blocks project installs from a workspace root with no root package.json", async () => {
    const cwd = await createTempDir("safeinstall-e2e-no-root-package-");
    const packageDir = path.join(cwd, "packages", "app");
    await mkdirp(packageDir);
    await writeDefaultConfig(cwd, {});
    await writeJson(path.join(packageDir, "package.json"), {
      name: "@repo/app",
      version: "1.0.0",
      dependencies: {
        axios: "^1.14.0"
      }
    });
    await writeFile(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  packages/app:
    dependencies:
      axios:
        specifier: ^1.14.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    );

    const result = await runCli(["--json", "pnpm", "install"], {
      cwd
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.reasons[0]).toMatchObject({
      code: "package-root-not-found"
    });
  });

  it("prefers a local package config over a root config when invoked inside that package", async () => {
    const cwd = await createTempDir("safeinstall-e2e-local-config-");
    const packageDir = path.join(cwd, "packages", "app");
    const stub = await createStubPackageManager("pnpm", {
      stdout: "local-config-ok"
    });

    await mkdirp(packageDir);
    await writeDefaultConfig(cwd);
    await writeDefaultConfig(packageDir, {
      minimumReleaseAgeHours: 999999
    });

    const result = await runCli(["pnpm", "add", "axios@1.13.2"], {
      cwd: packageDir,
      env: {
        ...process.env,
        PATH: `${stub.dir}:${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Using config:");
    expect(result.stderr).toContain("packages/app/safeinstall.config.json");
    expect(result.stderr).toContain("Blocked: release too new");
  });
});
