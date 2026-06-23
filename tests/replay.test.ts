import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config";
import { evaluateContinuity } from "../src/continuity";
import type { ContinuityDependencies } from "../src/continuity";
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
  continuity?: {
    baseline: { version: string; publishedAt: string; repository: string }[];
    target: { version: string; publishedAt: string; hasProvenance: boolean; repository?: string };
  };
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

  it("flags the provenance downgrade via continuity (the npm-defaults-can't-see-this catch)", async () => {
    expect(fixture.continuity).toBeDefined();
    const cont = fixture.continuity!;

    const history = [...cont.baseline, cont.target].map((entry) => ({
      version: entry.version,
      publishedAt: new Date(entry.publishedAt)
    }));
    const identities = new Map<string, { hasProvenance: boolean; sourceRepository?: string }>();
    for (const entry of cont.baseline) {
      identities.set(entry.version, { hasProvenance: true, sourceRepository: entry.repository });
    }
    identities.set(cont.target.version, {
      hasProvenance: cont.target.hasProvenance,
      sourceRepository: cont.target.repository
    });

    const deps: ContinuityDependencies = {
      async fetchVersionHistory() {
        return history;
      },
      async fetchIdentity(_pkg, version) {
        return identities.get(version) ?? { hasProvenance: false };
      }
    };

    const result = await evaluateContinuity({
      packageName: fixture.directInstall.name,
      targetVersion: cont.target.version,
      registryUrl: "https://registry.npmjs.org",
      config: { mode: "block", baselineSize: 5 },
      diskCache: undefined as never,
      deps
    });

    expect(result.status).toBe("provenance-downgrade");
    expect(result.baselineRepository).toBe("mastra-ai/mastra");
  });
});
