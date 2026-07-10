import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

describe("release metadata", () => {
  it("declares publish-safe package metadata", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as {
      name?: string;
      version?: string;
      private?: boolean;
      bin?: Record<string, string>;
      files?: string[];
      scripts?: Record<string, string>;
      license?: string;
      publishConfig?: Record<string, string>;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.name).toBe("safeinstall-cli");
    expect(packageJson.version).toBe("0.11.0");
    expect(packageJson.license).toBe("MIT");

    // The heavy, capability-rich deps (sigstore, MCP SDK) must NOT be installed
    // for consumers by default. optionalDependencies ARE installed by default
    // (they only skip on failure), which would pull ~125 extra packages and
    // contradict the "3 runtime dependencies, loads on demand" promise. They
    // belong in peerDependencies marked optional, so a default install stays
    // lean and the code lazy-loads them when the feature is used.
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([
      "npm-package-arg",
      "semver",
      "yaml"
    ]);
    expect(packageJson.optionalDependencies ?? {}).toEqual({});
    expect(packageJson.peerDependencies).toMatchObject({
      "@modelcontextprotocol/sdk": expect.any(String),
      sigstore: expect.any(String)
    });
    expect(packageJson.peerDependenciesMeta?.["@modelcontextprotocol/sdk"]?.optional).toBe(true);
    expect(packageJson.peerDependenciesMeta?.sigstore?.optional).toBe(true);
    expect(packageJson.bin).toMatchObject({
      safeinstall: "dist/cli.js"
    });
    expect(packageJson.files).toEqual([
      "dist",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
      "SUPPORT.md",
      "safeinstall.config.example.json"
    ]);
    expect(packageJson.scripts).toMatchObject({
      prepack: "pnpm build",
      "pack:smoke": "node scripts/pack-smoke.mjs",
      "release:check": "pnpm typecheck && pnpm test && pnpm build && pnpm pack:smoke"
    });
    expect(packageJson.publishConfig).toMatchObject({
      access: "public"
    });
  });
});
