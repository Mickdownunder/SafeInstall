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

  it("defaults typoSquat mode to off when not configured", () => {
    const defaults = createDefaultConfig();
    expect(defaults.typoSquat.mode).toBe("off");
    expect(defaults.typoSquat.minNameLength).toBe(4);
    expect(defaults.typoSquat.ignore).toEqual([]);
  });

  it("accepts a configured typoSquat block with ignore list", async () => {
    const cwd = await createTempDir("safeinstall-config-typosquat-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify(
        {
          typoSquat: {
            mode: "block",
            minNameLength: 5,
            ignore: ["PreactLookalike"]
          }
        },
        null,
        2
      )
    );

    const { config } = await loadConfig(cwd);
    expect(config.typoSquat.mode).toBe("block");
    expect(config.typoSquat.minNameLength).toBe(5);
    // ignore entries are normalized to lowercase
    expect(config.typoSquat.ignore).toEqual(["preactlookalike"]);
  });

  it("rejects invalid typoSquat mode values", async () => {
    const cwd = await createTempDir("safeinstall-config-typosquat-invalid-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ typoSquat: { mode: "strict" } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow('typoSquat.mode must be one of "off", "warn", "block"');
  });

  it("rejects unknown keys inside typoSquat", async () => {
    const cwd = await createTempDir("safeinstall-config-typosquat-unknown-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ typoSquat: { mode: "warn", strictness: 9 } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow("unknown key");
  });
});
