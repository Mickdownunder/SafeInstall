import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPackageManagerCommand, runPackageManager } from "../src/package-managers";
import { ShutdownSignalError } from "../src/signals";
import type { SafeInstallConfig } from "../src/types";

const config: SafeInstallConfig = {
  minimumReleaseAgeHours: 72,
  registryUrl: "https://registry.npmjs.org",
  allowedScripts: {},
  allowedSources: ["registry"],
  allowedPackages: [],
  ciMode: false,
  packageManagerDefaults: {
    npm: { ignoreScripts: true },
    pnpm: { ignoreScripts: true },
    bun: { ignoreScripts: true }
  },
  typoSquat: {
    mode: "off",
    minNameLength: 4,
    ignore: []
  }
};

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
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

  it("forwards shutdown signals to the child process and rejects with an interrupt error", async () => {
    const stubDir = await createTempDir("safeinstall-signal-stub-");
    const logPath = path.join(stubDir, "pnpm.args.log");

    await writeFile(
      path.join(stubDir, "pnpm"),
      `#!/bin/sh
printf '%s\n' "$@" > "${logPath}"
trap 'exit 0' INT TERM
while true
do
  sleep 1
done
`,
      { mode: 0o755 }
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
        PATH: `${stubDir}:${process.env.PATH ?? ""}`
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
