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

  it("leaves minimumCliVersion unset in the default config", () => {
    expect("minimumCliVersion" in createDefaultConfig()).toBe(false);
  });

  it("accepts a valid minimumCliVersion", async () => {
    const cwd = await createTempDir("safeinstall-config-cliversion-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "0.12.0" }, null, 2)
    );

    const { config } = await loadConfig(cwd);

    expect(config.minimumCliVersion).toBe("0.12.0");
  });

  it("rejects a minimumCliVersion that is not valid semver", async () => {
    const cwd = await createTempDir("safeinstall-config-cliversion-invalid-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "latest" }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      "Config error: minimumCliVersion must be an exact semver version"
    );
  });

  it("rejects a minimumCliVersion range: the field is a floor, not a constraint", async () => {
    const cwd = await createTempDir("safeinstall-config-cliversion-range-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "^0.12.0" }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow(
      "Config error: minimumCliVersion must be an exact semver version"
    );
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

  it("defaults provenance mode to off when not configured", () => {
    const defaults = createDefaultConfig();
    expect(defaults.provenance.mode).toBe("off");
    expect(defaults.provenance.requireFor).toEqual([]);
    expect(defaults.provenance.trustedPublishers).toEqual({});
    expect(defaults.provenance.offlineBehavior).toBe("fail-closed");
  });

  it("accepts a configured provenance block with trusted publishers", async () => {
    const cwd = await createTempDir("safeinstall-config-provenance-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify(
        {
          provenance: {
            mode: "require",
            requireFor: ["axios", "@sigstore/*"],
            trustedPublishers: {
              axios: "axios/axios",
              "@sigstore/*": "sigstore/*"
            },
            offlineBehavior: "allow-cached"
          }
        },
        null,
        2
      )
    );

    const { config } = await loadConfig(cwd);
    expect(config.provenance.mode).toBe("require");
    expect(config.provenance.requireFor).toEqual(["axios", "@sigstore/*"]);
    expect(config.provenance.trustedPublishers).toEqual({
      axios: "axios/axios",
      "@sigstore/*": "sigstore/*"
    });
    expect(config.provenance.offlineBehavior).toBe("allow-cached");
  });

  it("rejects invalid provenance mode values", async () => {
    const cwd = await createTempDir("safeinstall-config-provenance-invalid-mode-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ provenance: { mode: "strict" } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow('provenance.mode must be one of "off", "warn", "require"');
  });

  it("rejects invalid provenance offlineBehavior values", async () => {
    const cwd = await createTempDir("safeinstall-config-provenance-invalid-offline-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ provenance: { offlineBehavior: "retry" } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow('provenance.offlineBehavior must be "fail-closed" or "allow-cached"');
  });

  it("rejects unknown keys inside provenance", async () => {
    const cwd = await createTempDir("safeinstall-config-provenance-unknown-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ provenance: { mode: "warn", strict: true } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow("unknown key");
  });

  it("rejects non-object trustedPublishers values", async () => {
    const cwd = await createTempDir("safeinstall-config-provenance-trusted-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ provenance: { trustedPublishers: ["axios/axios"] } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow("trustedPublishers must be an object");
  });

  it("defaults transitive mode to off when not configured", () => {
    const defaults = createDefaultConfig();
    expect(defaults.transitive.mode).toBe("off");
    expect(defaults.transitive.checks).toEqual(["install-script", "untrusted-source"]);
  });

  it("accepts a configured transitive block", async () => {
    const cwd = await createTempDir("safeinstall-config-transitive-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ transitive: { mode: "block", checks: ["install-script"] } }, null, 2)
    );

    const { config } = await loadConfig(cwd);
    expect(config.transitive.mode).toBe("block");
    expect(config.transitive.checks).toEqual(["install-script"]);
  });

  it("rejects invalid transitive mode values", async () => {
    const cwd = await createTempDir("safeinstall-config-transitive-invalid-mode-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ transitive: { mode: "strict" } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow('transitive.mode must be one of "off", "warn", "block"');
  });

  it("rejects unsupported transitive checks", async () => {
    const cwd = await createTempDir("safeinstall-config-transitive-check-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ transitive: { mode: "warn", checks: ["release-age"] } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow("unsupported check");
  });

  it("rejects unknown keys inside transitive", async () => {
    const cwd = await createTempDir("safeinstall-config-transitive-unknown-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ transitive: { mode: "warn", depth: 5 } }, null, 2)
    );

    await expect(loadConfig(cwd)).rejects.toThrow("unknown key");
  });

  it("loads an explicit config path instead of discovering upward", async () => {
    const cwd = await createTempDir("safeinstall-config-explicit-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumReleaseAgeHours: 1 }, null, 2)
    );
    await writeFile(
      path.join(cwd, "strict.config.json"),
      JSON.stringify({ minimumReleaseAgeHours: 500 }, null, 2)
    );

    const { config, path: usedPath } = await loadConfig(cwd, "strict.config.json");

    expect(config.minimumReleaseAgeHours).toBe(500);
    expect(usedPath).toBe(path.join(cwd, "strict.config.json"));
  });

  it("resolves an explicit relative config path against the start directory", async () => {
    const cwd = await createTempDir("safeinstall-config-explicit-rel-");
    await writeFile(
      path.join(cwd, "policy.json"),
      JSON.stringify({ minimumReleaseAgeHours: 24 }, null, 2)
    );

    const { config } = await loadConfig(cwd, "./policy.json");

    expect(config.minimumReleaseAgeHours).toBe(24);
  });

  it("fails when an explicit config path does not exist instead of falling back to defaults", async () => {
    const cwd = await createTempDir("safeinstall-config-explicit-missing-");

    await expect(loadConfig(cwd, "missing.config.json")).rejects.toThrow(
      "Config error: cannot read config file"
    );
  });

  it("still validates the schema of an explicit config file", async () => {
    const cwd = await createTempDir("safeinstall-config-explicit-invalid-");
    await writeFile(
      path.join(cwd, "policy.json"),
      JSON.stringify({ nonsenseKey: true }, null, 2)
    );

    await expect(loadConfig(cwd, "policy.json")).rejects.toThrow("unknown key");
  });
});
