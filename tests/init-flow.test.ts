import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runInitFlow } from "../src/init-flow";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-init-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("runInitFlow", () => {
  it("creates a starter config when none exists", async () => {
    const cwd = await createTempDir();

    const result = await runInitFlow(cwd, ["init"], { force: false });

    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);

    const configText = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    expect(JSON.parse(configText)).toMatchObject({
      minimumReleaseAgeHours: 72,
      registryUrl: "https://registry.npmjs.org",
      allowedSources: ["registry", "workspace", "file", "directory"]
    });
  });

  it("fails safely when config already exists without --force", async () => {
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, "safeinstall.config.json"), "{\"minimumReleaseAgeHours\":1}\n", "utf8");

    const result = await runInitFlow(cwd, ["init"], { force: false });

    expect(result.decision).toBe("error");
    expect(result.reasons[0]).toMatchObject({
      code: "config-exists"
    });
  });

  it("overwrites an existing config when --force is provided", async () => {
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, "safeinstall.config.json"), "{\"minimumReleaseAgeHours\":1}\n", "utf8");

    const result = await runInitFlow(cwd, ["init", "--force"], { force: true });

    expect(result.decision).toBe("allow");
    expect(result.details?.overwritten).toBe(true);

    const configText = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    expect(JSON.parse(configText).minimumReleaseAgeHours).toBe(72);
  });
});
