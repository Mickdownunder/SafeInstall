import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config";
import { evaluatePackage } from "../src/policy";
import { evaluateTransitiveDependencies } from "../src/transitive";

// Regression guard for the attack replay fixtures in demo/replay/. These run
// the real policy engine against the recorded attack-time state and assert
// the verdicts the replay (and the README/blog claims) depend on. If a future
// engine change stops blocking a known historical attack, these fail.

const REPLAY_DIR = path.resolve(__dirname, "../demo/replay/attacks");

interface AttackFixture {
  now: string;
  directInstall: {
    name: string;
    version: string;
    publishedAt: string;
    lifecycleScripts: ("preinstall" | "install" | "postinstall")[];
    sourceType: "registry";
  };
  lockfile: string;
}

function loadAttack(name: string): { fixture: AttackFixture; dir: string } {
  const dir = path.join(REPLAY_DIR, name);
  const fixture = JSON.parse(readFileSync(path.join(dir, "attack.json"), "utf8")) as AttackFixture;
  return { fixture, dir };
}

describe("attack replay: mastra (2026-06-17)", () => {
  const { fixture, dir } = loadAttack("mastra");

  it("blocks the freshly republished @mastra package via release-age with default config", () => {
    const requested = {
      name: fixture.directInstall.name,
      raw: `${fixture.directInstall.name}@${fixture.directInstall.version}`,
      requested: fixture.directInstall.version,
      sourceType: fixture.directInstall.sourceType,
      registrySpecKind: "version" as const
    };

    const result = evaluatePackage({
      config: createDefaultConfig(),
      requested,
      now: new Date(fixture.now),
      resolvedRegistryPackage: {
        requested,
        resolvedVersion: fixture.directInstall.version,
        publishedAt: new Date(fixture.directInstall.publishedAt),
        lifecycleScripts: fixture.directInstall.lifecycleScripts
      }
    });

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("release-too-new");
  });

  it("blocks the easy-day-js postinstall dropper via transitive install-script (opt-in)", async () => {
    const config = createDefaultConfig();
    config.transitive = { mode: "block", checks: ["install-script", "untrusted-source"] };

    const result = await evaluateTransitiveDependencies({
      lockfilePath: path.join(dir, fixture.lockfile),
      directNames: new Set([fixture.directInstall.name]),
      config
    });

    expect(result.blockedReasons.map((reason) => reason.code)).toContain("transitive-install-script");
    expect(result.installScriptPackages.some((label) => label.startsWith("easy-day-js@"))).toBe(true);
  });

  it("does not block the transitive dropper when transitive mode is off (honest default)", async () => {
    const result = await evaluateTransitiveDependencies({
      lockfilePath: path.join(dir, fixture.lockfile),
      directNames: new Set([fixture.directInstall.name]),
      config: createDefaultConfig()
    });

    expect(result.blockedReasons).toHaveLength(0);
  });
});
