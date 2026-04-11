import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultConfig, loadConfig } from "../src/config";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("config", () => {
  it("uses the npm registry by default", () => {
    expect(createDefaultConfig().registryUrl).toBe("https://registry.npmjs.org");
  });

  it("normalizes a configured registry URL", async () => {
    const cwd = await createTempDir("safeinstall-config-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify(
        {
          registryUrl: "https://registry.example.internal/npm/"
        },
        null,
        2
      )
    );

    const { config } = await loadConfig(cwd);

    expect(config.registryUrl).toBe("https://registry.example.internal/npm");
  });

  it("rejects invalid registry URLs", async () => {
    const cwd = await createTempDir("safeinstall-config-invalid-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify(
        {
          registryUrl: "ftp://registry.example.internal"
        },
        null,
        2
      )
    );

    await expect(loadConfig(cwd)).rejects.toThrow("Config error: registryUrl must use http or https.");
  });
});
