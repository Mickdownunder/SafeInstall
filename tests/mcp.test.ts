import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHECK_PACKAGE_TOOL, checkPackage, evaluationToVerdict, resolveMcpConfig } from "../src/mcp";
import type { RegistryClient } from "../src/registry";
import type {
  PackageEvaluation,
  PolicyBlockReason,
  RequestedPackage,
  ResolvedRegistryPackage
} from "../src/types";

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

// Minimal stubbed-fetch Response shapes used by the deterministic E2E tests.
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

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

describe("check_package continuity verdict (E2E through the MCP layer)", () => {
  const TARGET_VERSION = "2.0.0";
  const BASELINE_REPO = "acme/shapes";

  // A registry packument whose time/versions give the continuity check a
  // baseline of three releases published before the target version.
  const packument = {
    "dist-tags": { latest: TARGET_VERSION },
    versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "2.0.0": {} },
    time: {
      created: "2025-01-01T00:00:00.000Z",
      modified: "2025-06-01T00:00:00.000Z",
      "1.0.0": "2025-01-01T00:00:00.000Z",
      "1.1.0": "2025-02-01T00:00:00.000Z",
      "1.2.0": "2025-03-01T00:00:00.000Z",
      "2.0.0": "2025-06-01T00:00:00.000Z"
    }
  };

  // An npm attestation response carrying a SLSA provenance statement that names
  // the publishing GitHub repository — the exact shape src/provenance.ts parses.
  function attestationResponse(repo: string) {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: "acme-shapes", digest: { sha512: "deadbeef" } }],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: "refs/tags/v1.0.0",
              repository: `https://github.com/${repo}`,
              path: ".github/workflows/publish.yml"
            }
          }
        },
        runDetails: { builder: { id: "https://github.com/actions/runner" } }
      }
    };
    return {
      attestations: [
        {
          predicateType: "https://slsa.dev/provenance/v1",
          bundle: {
            mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              payloadType: "application/vnd.in-toto+json",
              signatures: [{ sig: "MEUCIQ-stub-signature" }]
            }
          }
        }
      ]
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reports a provenance-downgrade block with the actionable why to the agent", async () => {
    const cwd = await createTempDir("safeinstall-mcp-continuity-");
    const cacheDir = await createTempDir("safeinstall-mcp-cache-");
    vi.stubEnv("SAFEINSTALL_CACHE_DIR", cacheDir);

    // Stub only the network the continuity check uses: version history and
    // per-version attestations. The baseline (1.0.0–1.2.0) is attested from
    // acme/shapes; the checked version 2.0.0 carries NO attestation — the
    // signature of a compromised-account publish.
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/-/npm/v1/attestations/")) {
        const version = decodeURIComponent(url.split("@").pop() ?? "");
        return Promise.resolve(
          version === TARGET_VERSION ? notFound() : jsonResponse(attestationResponse(BASELINE_REPO))
        );
      }
      if (url.endsWith("/acme-shapes")) {
        return Promise.resolve(jsonResponse(packument));
      }
      return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    });

    // Resolution is injected so the test pins continuity behaviour, not the
    // registry client (covered in registry.test.ts). publishedAt is old enough
    // that release-age never fires, isolating the continuity verdict.
    const registryClient = {
      async resolvePackage(requested: RequestedPackage) {
        return {
          requested,
          resolvedVersion: TARGET_VERSION,
          publishedAt: new Date("2025-06-01T00:00:00.000Z"),
          lifecycleScripts: []
        };
      },
      async getLifecycleScripts() {
        return [];
      }
    } as unknown as RegistryClient;

    const verdict = await checkPackage(
      cwd,
      { name: "acme-shapes", version: TARGET_VERSION, manager: "pnpm" },
      { registryClient }
    );

    // The continuity engine actually ran (history + target attestation fetched).
    expect(calls.some((u) => u.endsWith("/acme-shapes"))).toBe(true);
    expect(calls.some((u) => u.includes(`attestations/acme-shapes@${TARGET_VERSION}`))).toBe(true);

    // The continuity verdict reaches the MCP layer cleanly — block, and the
    // only reason is the downgrade (no release-age/typo-squat noise).
    expect(verdict.verdict).toBe("block");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["provenance-downgrade"]);

    // The actionable WHY is readable for the agent: expected repo + "this
    // version has no attestation", plus a remediation suggestion — not "blocked".
    const downgrade = verdict.reasons.find((reason) => reason.code === "provenance-downgrade");
    expect(downgrade?.message).toContain(BASELINE_REPO);
    expect(downgrade?.message).toContain("no attestation");
    expect(downgrade?.suggestion).toBeTruthy();
    expect(verdict.sourceRepository).toBe(BASELINE_REPO);

    // The JSON the tool hands the agent round-trips with the verdict intact.
    const agentPayload = JSON.parse(JSON.stringify(verdict, null, 2));
    expect(agentPayload.verdict).toBe("block");
    expect(agentPayload.reasons[0].code).toBe("provenance-downgrade");
    expect(agentPayload.reasons[0].message).toContain(BASELINE_REPO);
  });
});

describe("check_package native-build (binding.gyp) coverage", () => {
  // The sleep pattern: a package ships a binding.gyp but its author declared no
  // install script. npm normalizes that into install: "node-gyp rebuild" at
  // publish time, so it lands in the registry metadata SafeInstall already
  // reads — no tarball download. This pins that the injected script is caught
  // as install-script-present, enforcing the coverage rather than asserting it.
  //
  // Old publish dates keep release-age silent; attestations 404 so the secure
  // preset's continuity check finds no baseline and stays silent. The only
  // variable across the two cases is whether the manifest carries the script.
  function registryStub(name: string, scripts: Record<string, string>) {
    const version = "1.4.0";
    const packument = {
      "dist-tags": { latest: version },
      versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {}, "1.4.0": {} },
      time: {
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-06-01T00:00:00.000Z",
        "1.0.0": "2024-01-01T00:00:00.000Z",
        "1.1.0": "2024-02-01T00:00:00.000Z",
        "1.2.0": "2024-03-01T00:00:00.000Z",
        "1.4.0": "2024-06-01T00:00:00.000Z"
      }
    };
    const manifest = { version, scripts };
    return (input: unknown) => {
      const url = String(input);
      if (url.includes("/-/npm/v1/attestations/")) return Promise.resolve(notFound());
      if (url.endsWith(`/${name}/${version}`)) return Promise.resolve(jsonResponse(manifest));
      if (url.endsWith(`/${name}`)) return Promise.resolve(jsonResponse(packument));
      return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("blocks a binding.gyp package via the npm-injected node-gyp install script", async () => {
    const cwd = await createTempDir("safeinstall-mcp-gyp-");
    vi.stubEnv("SAFEINSTALL_CACHE_DIR", await createTempDir("safeinstall-mcp-gyp-cache-"));
    // Author declared no script; the registry metadata carries the injected one.
    vi.stubGlobal("fetch", registryStub("acme-native-addon", { install: "node-gyp rebuild" }));

    const verdict = await checkPackage(cwd, { name: "acme-native-addon" });

    expect(verdict.verdict).toBe("block");
    expect(verdict.reasons.map((reason) => reason.code)).toEqual(["install-script-present"]);
    const reason = verdict.reasons.find((r) => r.code === "install-script-present");
    expect(reason?.message).toContain("install script present");
    expect(reason?.suggestion).toBeTruthy();
  });

  it("does not block a pure-JS package that declares no install script", async () => {
    const cwd = await createTempDir("safeinstall-mcp-purejs-");
    vi.stubEnv("SAFEINSTALL_CACHE_DIR", await createTempDir("safeinstall-mcp-purejs-cache-"));
    vi.stubGlobal("fetch", registryStub("acme-plain-utils", {}));

    const verdict = await checkPackage(cwd, { name: "acme-plain-utils" });

    expect(verdict.verdict).toBe("allow");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.reasons.map((reason) => reason.code)).not.toContain("install-script-present");
  });
});
