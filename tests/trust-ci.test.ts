import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseCiProvider, scaffoldCiWorkflow } from "../src/trust-ci";
import { cleanupTempDirs, createTempDir, mkdirp } from "./cli-e2e-helpers";

afterAll(async () => {
  await cleanupTempDirs();
});

const WORKFLOW_PATH = path.join(".github", "workflows", "safeinstall-trust.yml");

describe("parseCiProvider", () => {
  it("parses --ci github in both forms", () => {
    expect(parseCiProvider(["--ci", "github"])).toBe("github");
    expect(parseCiProvider(["--ci=github"])).toBe("github");
  });

  it("returns undefined when absent", () => {
    expect(parseCiProvider(["--mode", "strict"])).toBeUndefined();
  });

  it("rejects unsupported providers", () => {
    expect(parseCiProvider(["--ci", "gitlab"])).toBeInstanceOf(Error);
    expect(parseCiProvider(["--ci"])).toBeInstanceOf(Error);
  });
});

describe("scaffoldCiWorkflow", () => {
  it("writes a workflow that runs the action with verify-trust", async () => {
    const root = await createTempDir("safeinstall-ci-");
    const result = await scaffoldCiWorkflow(root, "github");

    expect(result.status).toBe("created");
    const content = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
    expect(content).toContain("Mickdownunder/SafeInstall@v1");
    expect(content).toContain('verify-trust: "true"');
  });

  it("never overwrites an existing workflow", async () => {
    const root = await createTempDir("safeinstall-ci-exists-");
    await mkdirp(path.join(root, ".github", "workflows"));
    await writeFile(path.join(root, WORKFLOW_PATH), "name: my custom workflow\n");

    const result = await scaffoldCiWorkflow(root, "github");
    expect(result.status).toBe("exists");
    expect(await readFile(path.join(root, WORKFLOW_PATH), "utf8")).toBe("name: my custom workflow\n");
  });
});
