import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPackageManagerCommand, runPackageManager } from "../src/package-managers";
import { ShutdownSignalError } from "../src/signals";
import type { SafeInstallConfig } from "../src/types";
import { writeStubExecutable } from "./cli-e2e-helpers";

const config: SafeInstallConfig = {
  minimumReleaseAgeHours: 72,
  registryUrl: "https://registry.npmjs.org",
  allowedScripts: {},
  allowedSources: ["registry"],
  allowedPackages: [],
  packageManagerDefaults: {
    npm: { ignoreScripts: true },
    pnpm: { ignoreScripts: true },
    bun: { ignoreScripts: true }
  },
  typoSquat: {
    mode: "off",
    minNameLength: 4,
    ignore: []
  },
  provenance: {
    mode: "off",
    requireFor: [],
    trustedPublishers: {},
    offlineBehavior: "fail-closed",
    toolingUnavailable: "warn"
  },
  transitive: {
    mode: "off",
    checks: ["install-script", "untrusted-source"]
  },
  continuity: {
    mode: "off",
    baselineSize: 5
  }
};

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  // On Windows the signal test's stub grandchild can briefly outlive the
  // aborted cmd.exe wrapper and hold handles inside the temp dir, so a
  // single rm attempt races into ENOTEMPTY. Retry until the handles close.
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 }))
  );
});

describe("buildPackageManagerCommand", () => {
  it("adds ignore-scripts for pnpm by default", () => {
    const built = buildPackageManagerCommand("pnpm", [], "add", ["axios"], config);
    expect(built).toEqual({
      command: "pnpm",
      args: ["add", "axios", "--ignore-scripts"]
    });
  });

  it("does not duplicate ignore-scripts when already present", () => {
    const built = buildPackageManagerCommand("npm", [], "install", ["axios", "--ignore-scripts"], config);
    expect(built.args).toEqual(["install", "axios", "--ignore-scripts"]);
  });

  it("respects per-manager script forwarding override", () => {
    const built = buildPackageManagerCommand(
      "bun",
      [],
      "add",
      ["elysia"],
      {
        ...config,
        packageManagerDefaults: {
          ...config.packageManagerDefaults,
          bun: { ignoreScripts: false }
        }
      }
    );

    expect(built.args).toEqual(["add", "elysia"]);
  });

  it("preserves manager args before the command", () => {
    const built = buildPackageManagerCommand("pnpm", ["-C", "packages/app"], "install", [], config);
    expect(built.args).toEqual(["-C", "packages/app", "install", "--ignore-scripts"]);
  });
});

describe("runPackageManager", () => {
  it("returns a clear error when the package manager binary is missing", async () => {
    await expect(
      runPackageManager({
        manager: "pnpm",
        managerArgs: [],
        command: "install",
        forwardedArgs: [],
        config,
        env: { PATH: "" },
        stdio: "pipe"
      })
    ).rejects.toThrow('Package manager "pnpm" was not found in PATH.');
  });

  // This test runs on Windows too, with a deliberate semantic difference:
  // on POSIX the abort handler forwards a real SIGINT that the stub traps and
  // exits from gracefully; on Windows `child.kill("SIGINT")` terminates the
  // spawned process forcefully (TerminateProcess — there is no catchable
  // per-child SIGINT). In BOTH cases the wrapper's contract is the same and
  // is what this test asserts: once the shutdown AbortSignal fires,
  // runPackageManager kills the child and rejects with the interrupt error
  // instead of reporting a normal exit.
  it("forwards shutdown signals to the child process and rejects with an interrupt error", async () => {
    const stubDir = await createTempDir("safeinstall-signal-stub-");
    const logPath = path.join(stubDir, "pnpm.args.log");

    // Node equivalent of the previous sh stub (arg logging + `trap 'exit 0'
    // INT TERM` + spin). The deadman timer guarantees the stub cannot outlive
    // the test run as an orphan — relevant on Windows, where terminating the
    // cmd.exe wrapper does not terminate this grandchild process. It fires
    // 2s after spawn: far beyond the 50ms abort below, but short enough that
    // the surviving Windows grandchild releases its temp-dir handles while
    // the afterEach cleanup is still retrying.
    await writeStubExecutable(
      stubDir,
      "pnpm",
      `require("node:fs").writeFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join("\\n") + "\\n");
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(97), 2000);
`
    );

    const controller = new AbortController();
    const execution = runPackageManager({
      manager: "pnpm",
      managerArgs: [],
      command: "install",
      forwardedArgs: [],
      config,
      env: {
        ...process.env,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`
      },
      signal: controller.signal,
      stdio: "pipe"
    });

    setTimeout(() => {
      controller.abort(new ShutdownSignalError("SIGINT"));
    }, 50);

    await expect(execution).rejects.toThrow("Interrupted by SIGINT.");
  });
});
