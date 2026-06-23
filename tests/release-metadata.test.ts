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
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.name).toBe("safeinstall-cli");
    expect(packageJson.version).toBe("0.7.0");
    expect(packageJson.license).toBe("MIT");
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
