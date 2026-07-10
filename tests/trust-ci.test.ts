import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseCiProvider, scaffoldCiWorkflow } from "../src/trust-ci";
import { cleanupTempDirs, createTempDir, mkdirp, projectRoot } from "./cli-e2e-helpers";

const packageVersion = (
  JSON.parse(require("node:fs").readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

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
  it("writes a trust-only workflow that pins the CLI to an exact version", async () => {
    const root = await createTempDir("safeinstall-ci-");
    const result = await scaffoldCiWorkflow(root, "github");

    expect(result.status).toBe("created");
    expect(result.pinnedVersion).toBe(packageVersion);

    const content = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
    // Trust-only: the CLI's own trust command, not the full dependency check
    // (which would fail on a repo without package.json).
    expect(content).toContain("safeinstall trust status --require-lock");
    // Exact version pin — never @latest, which could predate the trust command
    // and turn the anchor into a silent no-op.
    expect(content).toContain(`safeinstall-cli@${packageVersion}`);
    expect(content).not.toContain("@latest");
    // Least privilege.
    expect(content).toContain("permissions:");
    expect(content).toContain("contents: read");
    // The verifier definition comes from the protected base branch. Candidate
    // files are checked out without credentials and are never executed.
    expect(content).toContain("pull_request_target:");
    expect(content).toContain("trust-base:");
    expect(content).toContain("persist-credentials: false");
    expect(content).toContain("working-directory: candidate");
    expect(content).not.toMatch(/^  pull_request:\s*$/m);
    // Every third-party action is immutable, not a moving major tag.
    expect(content).not.toContain("actions/checkout@v4");
    expect(content).not.toContain("actions/setup-node@v4");
  });

  it("emits a workflow pinned to the exact running version, never @latest (no silent no-op)", async () => {
    // Regression guard for the release-sequencing bug: the emitted workflow must
    // install the exact running CLI version (which by construction has `trust`),
    // never a floating pin that could resolve to a CLI predating the command.
    // Asserts on the workflow CONTENT — a revert of the pin to `@latest` fails here.
    const root = await createTempDir("safeinstall-ci-pin-");
    const result = await scaffoldCiWorkflow(root, "github");
    const content = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
    expect(content).toContain(`safeinstall-cli@${packageVersion}`);
    expect(content).not.toContain("@latest");
    expect(result.pinnedVersion).toBe(packageVersion);
    expect(packageVersion).not.toBe("0.9.0"); // 0.9.0 predates `trust`
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
