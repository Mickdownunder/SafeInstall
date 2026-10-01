import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createThirdPartyNotices, type LicenseRecord } from "../scripts/plugin-licenses.mjs";
import { cleanupTempDirs, createTempDir, projectRoot } from "./cli-e2e-helpers";

afterAll(cleanupTempDirs);

async function missingLicense(overrides: Partial<LicenseRecord> = {}): Promise<LicenseRecord> {
  return { name: "@npmcli/agent", version: "5.0.2", license: "ISC", source: await createTempDir("safeinstall-license-package-"), ...overrides };
}

describe("plugin redistribution license supplements", () => {
  it("refuses an unknown unlicensed distribution rather than treating SPDX metadata as text", async () => {
    await expect(createThirdPartyNotices([await missingLicense({ name: "unreviewed-fixture" })])).rejects.toThrow("Missing reviewed license text");
  });

  it("does not reuse reviewed terms across changed versions or license identifiers", async () => {
    for (const changes of [{ version: "5.0.3" }, { license: "MIT" }]) {
      await expect(createThirdPartyNotices([await missingLicense(changes)])).rejects.toThrow("Missing reviewed license text");
    }
  });

  it("rejects truncated supplements instead of distributing incomplete license terms", async () => {
    const assets = await createTempDir("safeinstall-license-assets-");
    const sourceAssets = path.join(projectRoot, "scripts", "plugin-licenses");
    const manifest = await readFile(path.join(sourceAssets, "sources.json"), "utf8");
    await writeFile(path.join(assets, "sources.json"), manifest);
    const entries = JSON.parse(manifest) as Array<{ name: string; file: string }>;
    const entry = entries.find(item => item.name === "@npmcli/agent")!;
    await writeFile(path.join(assets, entry.file), "Permission is hereby granted\n");
    await expect(createThirdPartyNotices([await missingLicense()], { assetsDirectory: assets })).rejects.toThrow("integrity mismatch");
  });

  it("retains existing licensing and refuses an empty license file", async () => {
    const record = await missingLicense({ name: "already-licensed-fixture" });
    const file = path.join(record.source, "LiCeNsE.md");
    await writeFile(file, "Existing complete fixture license terms.\n");
    await mkdir(path.join(record.source, "lib"));
    const notices = await createThirdPartyNotices([record]);
    expect(notices).not.toContain(record.name);
    expect(await readFile(file, "utf8")).toBe("Existing complete fixture license terms.\n");
    await writeFile(file, "\n");
    await expect(createThirdPartyNotices([record])).rejects.toThrow("Empty dependency license file");
  });
});
