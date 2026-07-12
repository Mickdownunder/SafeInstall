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
    expect(packageJson.version).toBe("0.13.1");
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
      // Build before test: the e2e suites run dist/cli.js via ensureBuiltCli,
      // which skips rebuilding an existing (possibly stale) dist.
      "release:check": "pnpm typecheck && pnpm build && pnpm test && pnpm pack:smoke"
    });
    expect(packageJson.publishConfig).toMatchObject({
      access: "public"
    });
  });

  // Release-PR checklist enforcement: the SECURITY.md supported-versions table
  // is the one release item that slipped in v0.12.0 (PR #40, fixed in PR #43)
  // because nothing asserted it. This test fails the moment package.json is
  // bumped without updating the table to match.
  it("keeps the SECURITY.md supported-versions table in sync with package.json", async () => {
    const { version } = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8")
    ) as { version: string };
    const versionMatch = /^(\d+)\.(\d+)\.\d+/.exec(version);
    expect(versionMatch).not.toBeNull();
    const majorMinor = `${versionMatch![1]}.${versionMatch![2]}`;

    const securityMd = await readFile(path.join(projectRoot, "SECURITY.md"), "utf8");
    const sectionMatch = /^## Supported versions\n([\s\S]*?)(?=^## )/m.exec(securityMd);
    expect(sectionMatch, "SECURITY.md must have a '## Supported versions' section").not.toBeNull();

    const rows = sectionMatch![1]
      .split("\n")
      .filter((line) => line.trim().startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim())
      );
    // Header, separator, and exactly one supported + one unsupported row.
    expect(rows[0]).toEqual(["Version", "Supported"]);
    const dataRows = rows.slice(2);
    expect(dataRows).toHaveLength(2);

    const [supportedRow, unsupportedRow] = dataRows;
    expect(supportedRow[0]).toBe(`${majorMinor}.x`);
    expect(supportedRow[1]).toBe("Yes");
    expect(unsupportedRow[0]).toBe(`< ${majorMinor}`);
    expect(unsupportedRow[1]).toBe(`No (upgrade to the latest ${majorMinor}.x release)`);
  });
});
