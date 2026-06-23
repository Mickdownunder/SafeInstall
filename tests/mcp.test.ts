import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHECK_PACKAGE_TOOL, evaluationToVerdict, resolveMcpConfig } from "../src/mcp";
import type { PackageEvaluation, PolicyBlockReason, ResolvedRegistryPackage } from "../src/types";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

const NOW = new Date("2026-06-23T12:00:00.000Z");

function resolvedPackage(overrides: Partial<ResolvedRegistryPackage> = {}): ResolvedRegistryPackage {
  const requested = {
    name: "axios",
    raw: "axios@latest",
    requested: "latest",
    sourceType: "registry" as const,
    registrySpecKind: "tag" as const
  };
  return {
    requested,
    resolvedVersion: "1.7.9",
    // 120 hours before NOW
    publishedAt: new Date("2026-06-18T12:00:00.000Z"),
    lifecycleScripts: [],
    ...overrides
  };
}

function evaluation(overrides: Partial<PackageEvaluation> = {}): PackageEvaluation {
  return {
    requested: {
      name: "axios",
      raw: "axios@latest",
      requested: "latest",
      sourceType: "registry",
      registrySpecKind: "tag"
    },
    resolvedRegistryPackage: resolvedPackage(),
    blockedReasons: [],
    warnings: [],
    infos: [],
    ...overrides
  };
}

describe("evaluationToVerdict", () => {
  it("maps blocked reasons to a block verdict and carries codes, messages, and suggestions", () => {
    const reasons: PolicyBlockReason[] = [
      {
        code: "typo-squat-suspected",
        message: 'Blocked: Suspected typo-squat: "raect" is 2 edit(s) away from "react".',
        suggestion: 'Verify you meant to install "react".'
      },
      {
        code: "release-too-new",
        message: "Blocked: release too new."
      }
    ];

    const verdict = evaluationToVerdict(
      evaluation({
        requested: {
          name: "raect",
          raw: "raect@latest",
          requested: "latest",
          sourceType: "registry",
          registrySpecKind: "tag"
        },
        blockedReasons: reasons
      }),
      NOW
    );

    expect(verdict.verdict).toBe("block");
    expect(verdict.name).toBe("raect");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual([
      "typo-squat-suspected",
      "release-too-new"
    ]);
    expect(verdict.reasons[0]).toEqual({
      code: "typo-squat-suspected",
      message: 'Blocked: Suspected typo-squat: "raect" is 2 edit(s) away from "react".',
      suggestion: 'Verify you meant to install "react".'
    });
    // A reason without a suggestion must not invent one.
    expect(verdict.reasons[1]).toEqual({
      code: "release-too-new",
      message: "Blocked: release too new."
    });
    expect(verdict.reasons[1]).not.toHaveProperty("suggestion");
  });

  it("maps a clean evaluation to an allow verdict with the resolved version", () => {
    const verdict = evaluationToVerdict(evaluation(), NOW);

    expect(verdict.verdict).toBe("allow");
    expect(verdict.name).toBe("axios");
    expect(verdict.version).toBe("1.7.9");
    expect(verdict.reasons).toEqual([]);
  });

  it("carries warnings and infos through to the verdict", () => {
    const verdict = evaluationToVerdict(
      evaluation({
        warnings: ["axios has no provenance attestation."],
        infos: ["axios: provenance consistent with baseline (axios/axios)."]
      }),
      NOW
    );

    expect(verdict.warnings).toEqual(["axios has no provenance attestation."]);
    expect(verdict.infos).toEqual(["axios: provenance consistent with baseline (axios/axios)."]);
  });

  it("surfaces the source repository and computes age in hours from the publish date", () => {
    const verdict = evaluationToVerdict(
      evaluation({ sourceRepository: "axios/axios" }),
      NOW
    );

    expect(verdict.sourceRepository).toBe("axios/axios");
    // publishedAt is 2026-06-18T12:00 and NOW is 2026-06-23T12:00 → 120 hours.
    expect(verdict.ageHours).toBe(120);
  });

  it("returns null source repository, version, and age when the package never resolved", () => {
    const verdict = evaluationToVerdict(
      evaluation({
        resolvedRegistryPackage: undefined,
        blockedReasons: [
          {
            code: "package-resolution-failed",
            message: "Blocked: could not resolve raect from the registry.",
            suggestion: "Check the package name spelling."
          }
        ]
      }),
      NOW
    );

    expect(verdict.verdict).toBe("block");
    expect(verdict.version).toBeNull();
    expect(verdict.ageHours).toBeNull();
    expect(verdict.sourceRepository).toBeNull();
  });

  it("does not share array references with the source evaluation", () => {
    const source = evaluation({ warnings: ["w"], infos: ["i"] });
    const verdict = evaluationToVerdict(source, NOW);

    expect(verdict.warnings).not.toBe(source.warnings);
    expect(verdict.infos).not.toBe(source.infos);
  });
});

describe("resolveMcpConfig", () => {
  it("uses the secure preset (typo-squat + continuity block) when no config file is found", async () => {
    const cwd = await createTempDir("safeinstall-mcp-preset-");
    const resolved = await resolveMcpConfig(cwd);

    expect(resolved.usedSecurePreset).toBe(true);
    expect(resolved.configPath).toBeUndefined();
    expect(resolved.config.typoSquat.mode).toBe("block");
    expect(resolved.config.continuity.mode).toBe("block");
  });

  it("respects a project config file exactly when one is present", async () => {
    const cwd = await createTempDir("safeinstall-mcp-config-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({
        minimumReleaseAgeHours: 24,
        typoSquat: { mode: "warn" },
        continuity: { mode: "off" }
      }),
      "utf8"
    );

    const resolved = await resolveMcpConfig(cwd);

    expect(resolved.usedSecurePreset).toBe(false);
    expect(resolved.configPath).toBe(path.join(cwd, "safeinstall.config.json"));
    expect(resolved.config.minimumReleaseAgeHours).toBe(24);
    expect(resolved.config.typoSquat.mode).toBe("warn");
    expect(resolved.config.continuity.mode).toBe("off");
  });
});

describe("check_package tool definition", () => {
  it("declares the agent-facing contract: required name, optional version, manager enum", () => {
    expect(CHECK_PACKAGE_TOOL.name).toBe("check_package");
    expect(CHECK_PACKAGE_TOOL.inputSchema.required).toEqual(["name"]);
    expect(CHECK_PACKAGE_TOOL.inputSchema.properties.name.type).toBe("string");
    expect(CHECK_PACKAGE_TOOL.inputSchema.properties.version.type).toBe("string");
    expect(CHECK_PACKAGE_TOOL.inputSchema.properties.manager.enum).toEqual(["npm", "pnpm", "bun"]);
    expect(CHECK_PACKAGE_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(CHECK_PACKAGE_TOOL.description).toContain("BEFORE");
  });
});
