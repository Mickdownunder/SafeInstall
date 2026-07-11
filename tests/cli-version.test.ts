import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCheckFlow } from "../src/check-flow";
import { CLI_UPDATE_COMMAND, PACKAGE_VERSION, cliVersionWarning } from "../src/cli-version";
import { runInstallFlow } from "../src/install-flow";
import { cleanupTempDirs, createTempDir, projectRoot, writeJson } from "./cli-e2e-helpers";

afterAll(async () => {
  await cleanupTempDirs();
});

describe("cliVersionWarning", () => {
  it("warns when the running CLI is older than the project minimum", () => {
    const warning = cliVersionWarning("0.13.0", "0.12.0");
    expect(warning).toContain("safeinstall-cli >= 0.13.0");
    expect(warning).toContain("version 0.12.0 is running");
    expect(warning).toContain(CLI_UPDATE_COMMAND);
  });

  it("stays silent when the running CLI matches the minimum exactly", () => {
    expect(cliVersionWarning("0.12.0", "0.12.0")).toBeUndefined();
  });

  it("stays silent when the running CLI is newer than the minimum", () => {
    expect(cliVersionWarning("0.12.0", "0.13.0")).toBeUndefined();
  });

  it("stays silent when the project declares no minimum", () => {
    expect(cliVersionWarning(undefined, "0.0.1")).toBeUndefined();
  });

  it("reads the running version from the package manifest", async () => {
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });
});

describe("minimumCliVersion in the CLI flows", () => {
  async function projectRequiring(minimumCliVersion: string): Promise<string> {
    const cwd = await createTempDir("safeinstall-cli-version-flow-");
    await writeJson(path.join(cwd, "package.json"), { name: "fixture", version: "1.0.0" });
    await writeJson(path.join(cwd, "safeinstall.config.json"), { minimumCliVersion });
    return cwd;
  }

  it("surfaces the warning in check results when the CLI is too old", async () => {
    const cwd = await projectRequiring("999.0.0");
    const result = await runCheckFlow(cwd, ["check"]);
    expect(result.warnings.some((warning) => warning.includes("safeinstall-cli >= 999.0.0"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes(CLI_UPDATE_COMMAND))).toBe(true);
  });

  it("stays silent in check results when the CLI satisfies the minimum", async () => {
    const cwd = await projectRequiring("0.0.1");
    const result = await runCheckFlow(cwd, ["check"]);
    expect(result.warnings).toEqual([]);
  });

  it("surfaces the warning in install results when the CLI is too old", async () => {
    const cwd = await projectRequiring("999.0.0");
    // An empty project makes the flow return before any registry access; the
    // warning must be present even on that early exit.
    const result = await runInstallFlow(cwd, ["npm", "install"], { jsonMode: true });
    expect(result.warnings.some((warning) => warning.includes("safeinstall-cli >= 999.0.0"))).toBe(true);
  });
});
