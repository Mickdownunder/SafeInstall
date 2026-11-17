import { describe, expect, it } from "vitest";

import { createDefaultConfig } from "../src/config";
import {
  installOptionReasons,
  lockfileArtifactBindingReasons,
  pinPackageArguments,
  sha512Integrity
} from "../src/install-binding";
import { buildInstallPlan } from "../src/specs";
import type { ProjectInstallTargetsResult } from "../src/project-installs";
import type { PackageEvaluation } from "../src/types";

const defaultConfig = createDefaultConfig();

describe("artifact-bound installation controls", () => {
  it("requires exactly one canonical SHA-512 digest, not alternate acceptable bytes", () => {
    const valid = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    expect(sha512Integrity(valid)).toBe(valid);
    for (const invalid of [undefined, "", "sha512-test", valid + " " + valid,
      valid.replace("sha512", "sha256"), valid.slice(0, -1), "sha512-" + Buffer.alloc(63).toString("base64")]) {
      expect(sha512Integrity(invalid)).toBeUndefined();
    }
  });

  it("binds check and authorization targets to the checked registry artifact", () => {
    const expectedIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
    const attackerIntegrity = `sha512-${Buffer.alloc(64, 8).toString("base64")}`;
    const expectedTarballUrl = "https://cdn.registry.example/axios-1.14.0.tgz";
    const requested = {
      name: "axios",
      raw: "axios@1.14.0",
      requested: "1.14.0",
      sourceType: "registry" as const,
      registrySpecKind: "version" as const
    };
    const evaluation = {
      requested,
      resolvedRegistryPackage: {
        requested,
        resolvedVersion: "1.14.0",
        publishedAt: new Date("2020-01-01T00:00:00.000Z"),
        publishTimeSource: "registry-time",
        lifecycleScripts: [],
        artifact: { tarballUrl: expectedTarballUrl, integrity: expectedIntegrity }
      },
      blockedReasons: [],
      warnings: [],
      infos: []
    } satisfies PackageEvaluation;
    const targets = {
      lockfilePath: "/project/package-lock.json",
      issues: [],
      targets: [{
        requested,
        manifestSpec: "1.14.0",
        integrity: expectedIntegrity,
        tarballUrl: expectedTarballUrl
      }]
    } satisfies ProjectInstallTargetsResult;

    expect(lockfileArtifactBindingReasons(targets, [evaluation])).toEqual([]);
    expect(lockfileArtifactBindingReasons({
      ...targets,
      targets: [{
        ...targets.targets[0],
        tarballUrl: "https://attacker.example/axios-1.14.0.tgz"
      }]
    }, [evaluation])[0]?.message).toContain("differs from the checked registry artifact");
    expect(lockfileArtifactBindingReasons({
      ...targets,
      targets: [{ ...targets.targets[0], integrity: attackerIntegrity }]
    }, [evaluation])[0]?.message).toContain("checked registry SHA-512");
  });

  it.each(["--ignore-scripts=false", "--no-ignore-scripts", "--global", "--force", "--offline",
    "--lockfile-dir=/other", "--config.ignore-scripts=false", "--package-lock=false", "--frozen-lockfile=false"])(
    "rejects unchecked install semantics: %s", (flag) => {
      const plan = buildInstallPlan(["npm", "install", "axios@latest", flag]);
      expect(installOptionReasons(plan, defaultConfig)).toHaveLength(1);
    });

  it("does not confuse a flag value with an evaluated package", () => {
    const plan = buildInstallPlan(["npm", "install", "--cache", "axios", "--", "axios@latest"]);
    const evaluation = { requested: plan.packages[0],
      resolvedRegistryPackage: { resolvedVersion: "1.14.0" } } as PackageEvaluation;
    expect(pinPackageArguments(plan, [evaluation])).toEqual(["--cache", "axios", "axios@1.14.0"]);
  });

  it("rejects a registry override but accepts the reviewed registry", () => {
    expect(installOptionReasons(buildInstallPlan(["npm", "install", "axios", "--registry", "https://other.example"]), defaultConfig)[0]?.code).toBe("registry-mismatch");
    expect(installOptionReasons(buildInstallPlan(["npm", "install", "axios", `--registry=${defaultConfig.registryUrl}/`]), defaultConfig)).toEqual([]);
  });

  it("accepts the documented frozen-lockfile option without allowing it to be disabled", () => {
    expect(installOptionReasons(buildInstallPlan(["pnpm", "install", "--frozen-lockfile"]), defaultConfig)).toEqual([]);
  });
});
