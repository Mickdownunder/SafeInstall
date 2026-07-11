import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalizeJson, isCanonicalJson } from "../src/canonical-json";
import { cleanupTempDirs, createTempDir, ensureBuiltCli, runCli } from "./cli-e2e-helpers";

/**
 * End-to-end for the L2 statement layer through the real CLI: build the
 * signable statement from an authorization artifact, then verify it binds
 * that artifact — and that it does NOT bind a different one. No signing here;
 * signing needs an OIDC identity and is the release/CI step.
 */

beforeAll(async () => {
  await ensureBuiltCli();
});

afterEach(async () => {
  await cleanupTempDirs();
});

async function writeAuthorization(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const artifactPath = path.join(dir, "authorization.json");
  await writeFile(
    artifactPath,
    Buffer.from(
      canonicalizeJson({
        schemaVersion: 1,
        evaluatedAt: "2026-07-11T12:00:00.000Z",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        lockfiles: [{ path: "package-lock.json", headBlobOid: "c".repeat(40) }],
        policyBlobOid: "d".repeat(40),
        verdict: "allow",
        reasons: [],
        warnings: [],
        ...overrides
      }),
      "utf8"
    )
  );
  return artifactPath;
}

describe("decisions attest / verify-attestation (e2e)", () => {
  it("builds a canonical statement and verifies it binds the artifact", async () => {
    const dir = await createTempDir("safeinstall-attest-e2e-");
    const artifactPath = await writeAuthorization(dir);
    const statementPath = path.join(dir, "statement.json");

    const attest = await runCli([
      "decisions",
      "attest",
      "--authorization",
      artifactPath,
      "--output",
      statementPath
    ]);
    expect(attest.code).toBe(0);
    expect(isCanonicalJson(await readFile(statementPath))).toBe(true);

    const verify = await runCli([
      "decisions",
      "verify-attestation",
      "--authorization",
      artifactPath,
      "--statement",
      statementPath,
      "--json"
    ]);
    expect(verify.code).toBe(0);
    const parsed = JSON.parse(verify.stdout) as { decision: string; summary: string };
    expect(parsed.decision).toBe("allow");
    expect(parsed.summary).toContain("binds the allow authorization");
  });

  it("fails verify-attestation when the statement is for a different artifact", async () => {
    const dir = await createTempDir("safeinstall-attest-mismatch-");
    const artifactPath = await writeAuthorization(dir, { headCommit: "b".repeat(40) });
    const otherPath = await writeAuthorization(
      await createTempDir("safeinstall-attest-other-"),
      { headCommit: "e".repeat(40) }
    );
    const statementPath = path.join(dir, "statement.json");

    await runCli(["decisions", "attest", "--authorization", otherPath, "--output", statementPath]);

    const verify = await runCli([
      "decisions",
      "verify-attestation",
      "--authorization",
      artifactPath,
      "--statement",
      statementPath
    ]);
    expect(verify.code).toBe(2);
    expect(verify.stderr).toContain("does not match");
  });

  it("requires --authorization", async () => {
    const result = await runCli(["decisions", "attest"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--authorization");
  });
});
