import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createStubPackageManager,
  createTempDir,
  ensureBuiltCli,
  mkdirp,
  projectRoot,
  readLoggedArgs,
  runCli,
  spawnCli,
  startRegistryFixture,
  waitForStderr,
  writeDefaultConfig,
  writeJson,
  type RegistryFixture
} from "./cli-e2e-helpers";

let registry: RegistryFixture;

beforeAll(async () => {
  await ensureBuiltCli();
  // Serve package metadata locally so install tests never touch the real npm
  // registry — a network dependency there is a flake source. writeDefaultConfig
  // picks this up via SAFEINSTALL_TEST_REGISTRY.
  registry = await startRegistryFixture();
  process.env.SAFEINSTALL_TEST_REGISTRY = registry.url;
});

afterAll(async () => {
  delete process.env.SAFEINSTALL_TEST_REGISTRY;
  await registry?.close();
  await cleanupTempDirs();
});

describe("CLI end-to-end", () => {
  it("prints top-level help text without entering the install flow", async () => {
    const result = await runCli(["--help"], {
      cwd: projectRoot
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("safeinstall check");
    expect(result.stderr).toBe("");
  });

  it("prints the current SafeInstall version", async () => {
    // The single source of truth for the version is package.json; the
    // release-metadata test pins the concrete release number.
    const { version } = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { version: string };

    const result = await runCli(["--version"], {
      cwd: projectRoot
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    expect(result.stderr).toBe("");
  });

  it("creates a starter config, keeps it on re-run, and overwrites with --force", async () => {
    const cwd = await createTempDir("safeinstall-e2e-init-");
    // --no-guard --no-lock keeps this a pure config e2e: without them init
    // would write a trust-lock mirror into the host's real state dir.
    const initArgs = ["init", "--no-guard", "--no-lock"];

    const firstRun = await runCli(initArgs, { cwd });
    expect(firstRun.code).toBe(0);
    expect(firstRun.stderr).toContain("config: created");

    const secondRun = await runCli(initArgs, { cwd });
    expect(secondRun.code).toBe(0);
    expect(secondRun.stderr).toContain("config: kept");

    const forcedRun = await runCli(["init", "--force", "--no-guard", "--no-lock"], { cwd });
    expect(forcedRun.code).toBe(0);
    expect(forcedRun.stderr).toContain("config: overwritten");
  });

  it("emits stable json for blocked installs", async () => {
    const result = await runCli(["--json", "npm", "install", "github:axios/axios"], {
      cwd: projectRoot
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      mode: "install",
      decision: "block",
      packageManager: "npm",
      exitCode: 2
    });
    expect(payload.reasons[0].suggestion).toContain("registry release");
  });

  it("runs an allowed install through the package manager and appends --ignore-scripts", async () => {
    const cwd = await createTempDir("safeinstall-e2e-allow-");
    const stub = await createStubPackageManager("pnpm", {
      stdout: "stub-ok"
    });

    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          packageManager: "pnpm@10.28.2",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        null,
        2
      )
    );

    await writeDefaultConfig(cwd);

    await writeFile(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^1.14.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    );

    const result = await runCli(["pnpm", "install"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Allowed: policy checks passed.");
    expect(result.stdout).toContain("stub-ok");

    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["install", "--ignore-scripts"]);
  });

  it("captures package manager output in json mode for allowed installs", async () => {
    const cwd = await createTempDir("safeinstall-e2e-json-");
    const stub = await createStubPackageManager("npm", {
      stdout: "json-stdout",
      stderr: "json-stderr"
    });

    await writeDefaultConfig(cwd, {});

    const result = await runCli(["--json", "npm", "install", "axios@1.14.0"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      mode: "install",
      decision: "allow",
      packageManager: "npm"
    });
    expect(payload.execution.stdout).toContain("json-stdout");
    expect(payload.execution.stderr).toContain("json-stderr");
    expect(result.stderr).toBe("");
  });

  it("reports a clear runtime error when the package manager binary is missing", async () => {
    const cwd = await createTempDir("safeinstall-e2e-missing-bin-");
    await writeDefaultConfig(cwd, {});

    const result = await runCli(["pnpm", "add", "axios@1.13.2"], {
      cwd,
      env: {
        ...process.env,
        PATH: ""
      }
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Package manager "pnpm" was not found in PATH.');
  });

  it("blocks project installs when the invoked package manager disagrees with package.json", async () => {
    const cwd = await createTempDir("safeinstall-e2e-manager-mismatch-");
    const stub = await createStubPackageManager("npm", {
      stdout: "should-not-run"
    });

    await writeDefaultConfig(cwd, {});
    await writeJson(path.join(cwd, "package.json"), {
      name: "demo",
      version: "1.0.0",
      packageManager: "pnpm@10.28.2",
      dependencies: {
        axios: "^1.14.0"
      }
    });
    await writeJson(path.join(cwd, "package-lock.json"), {
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "demo",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        "node_modules/axios": {
          version: "1.14.0",
          resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
          integrity: "sha512-test"
        }
      }
    });
    await writeFile(
      path.join(cwd, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      axios:
        specifier: ^1.14.0
        version: 1.14.0

packages:

  axios@1.14.0:
    resolution: {integrity: sha512-test}
`
    );

    const result = await runCli(["--json", "npm", "install"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.reasons[0]).toMatchObject({
      code: "package-manager-mismatch"
    });
    expect(payload.reasons[0].message).toContain("declares pnpm as packageManager");

    expect(payload.execution.ranPackageManager).toBe(false);
  });

  it("supports pnpm workspace installs from a nested package subdirectory", async () => {
    const cwd = await createTempDir("safeinstall-e2e-pnpm-workspace-");
    const packageDir = path.join(cwd, "packages", "app");
    const nestedDir = path.join(packageDir, "src");
    const stub = await createStubPackageManager("pnpm", {
      stdout: "pnpm-workspace-ok"
    });

    await mkdirp(nestedDir);
    await writeJson(path.join(cwd, "package.json"), {
      name: "repo",
      version: "1.0.0",
      packageManager: "pnpm@10.28.2"
    });
    await writeDefaultConfig(cwd);
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

    const result = await runCli(["pnpm", "install"], {
      cwd: nestedDir,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Using config:");
    expect(result.stderr).toContain("safeinstall.config.json");
    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["install", "--ignore-scripts"]);
  });

  it("supports npm ci from a workspace package subdirectory using the root lockfile", async () => {
    const cwd = await createTempDir("safeinstall-e2e-npm-workspace-");
    const packageDir = path.join(cwd, "packages", "app");
    const nestedDir = path.join(packageDir, "src");
    const stub = await createStubPackageManager("npm", {
      stdout: "npm-ci-ok"
    });

    await mkdirp(nestedDir);
    await writeJson(path.join(cwd, "package.json"), {
      name: "repo",
      version: "1.0.0",
      packageManager: "npm@10.8.0"
    });
    await writeDefaultConfig(cwd);
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
        },
        "packages/app": {
          name: "@repo/app",
          version: "1.0.0",
          dependencies: {
            axios: "^1.14.0"
          }
        },
        "node_modules/axios": {
          version: "1.14.0",
          resolved: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
          integrity: "sha512-test"
        }
      }
    });

    const result = await runCli(["npm", "ci"], {
      cwd: nestedDir,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["ci", "--ignore-scripts"]);
  });

  it("supports pre-command target-directory flags like pnpm -C packages/app install", async () => {
    const cwd = await createTempDir("safeinstall-e2e-pnpm-C-");
    const packageDir = path.join(cwd, "packages", "app");
    const stub = await createStubPackageManager("pnpm", {
      stdout: "pnpm-cwd-flag-ok"
    });

    await mkdirp(packageDir);
    await writeDefaultConfig(cwd);
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

    const result = await runCli(["pnpm", "-C", "packages/app", "install"], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    const loggedArgs = await readLoggedArgs(stub.logPath);
    expect(loggedArgs).toEqual(["-C", "packages/app", "install", "--ignore-scripts"]);
  });

  it("fails closed on ambiguous workspace-targeting flags", async () => {
    const cwd = await createTempDir("safeinstall-e2e-ambiguous-workspace-");
    await writeDefaultConfig(cwd, {});

    const result = await runCli(["--json", "pnpm", "add", "--filter", "app", "axios@1.14.0"], {
      cwd
    });

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.reasons[0]).toMatchObject({
      code: "ambiguous-workspace-target"
    });
  });

  // Windows has no way to deliver a catchable console interrupt to one child
  // process: `child.kill("SIGINT")` maps to TerminateProcess in libuv, so the
  // CLI's SIGINT handler never runs and "clean exit with code 130" is not
  // defined behavior there. The wrapper-level shutdown contract IS covered on
  // Windows by the package-managers.test.ts signal test, which exercises the
  // abort path without requiring the CLI process itself to receive a signal.
  it.skipIf(process.platform === "win32")(
    "exits cleanly on SIGINT while the wrapped package manager is running",
    async () => {
      const cwd = await createTempDir("safeinstall-e2e-sigint-");
      const stub = await createStubPackageManager("pnpm", {
        // Node equivalent of the previous sh stub (`trap 'exit 0' INT TERM` +
        // spin): exit 0 on SIGINT/SIGTERM, otherwise keep the event loop
        // alive. The deadman timer guarantees the stub cannot outlive the
        // test run as an orphan if the signal is ever lost.
        script: `process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(97), 15000);
`
      });

      await writeDefaultConfig(cwd, {
        allowedSources: ["registry", "workspace", "file", "directory"]
      });
      await mkdirp(path.join(cwd, "packages", "local"));

      const { child, result } = await spawnCli(["pnpm", "add", "./packages/local"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
        }
      });

      // Wait for evidence that the CLI has finished its startup phase and
      // registered its signal handlers, rather than sleeping a fixed amount.
      // `Allowed: policy checks passed.` is printed right before the package
      // manager is spawned — by this point the signal handler is definitely
      // active and we are mid-install, which is exactly the state under test.
      await waitForStderr(child, "Allowed: policy checks passed.", 5000);
      child.kill("SIGINT");

      const interrupted = await result;
      expect(interrupted.code).toBe(130);
      expect(interrupted.signal).toBeNull();
      expect(interrupted.stderr).toContain("Interrupted by SIGINT.");
    }
  );
});
