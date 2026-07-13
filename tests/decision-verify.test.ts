import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendDecisionRecord, decisionsDirForLockfile } from "../src/decision-store";
import { verifyDecisions } from "../src/decision-verify";
import { bindFileAsStaged, resolveGitRepo, type GitRepoContext } from "../src/git-blob";
import { createDecisionDraft } from "./helpers/decision-fixture";
import { commitAll, createRepoFixture } from "./helpers/git-fixture";
import { present } from "./helpers/present";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  dir: string;
  repo: GitRepoContext;
  base: string;
}

/** A repo with a committed v1 lockfile as the base state. */
async function createBaseFixture(): Promise<Fixture> {
  const { dir } = await createRepoFixture(tempDirs);
  await writeFile(path.join(dir, "package.json"), '{"name":"fixture","dependencies":{}}\n');
  await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages: {}\n");
  const base = commitAll(dir, "base");
  const repo = (await resolveGitRepo(dir))!;
  return { dir, repo, base };
}

/**
 * The honest path: bind the lockfile before the change, apply the change,
 * bind after, append the record — exactly what the install flow does.
 */
async function recordLockfileChange(fixture: Fixture, newContent: string): Promise<void> {
  const before = (await bindFileAsStaged(fixture.repo, "pnpm-lock.yaml")) ?? null;
  await writeFile(path.join(fixture.dir, "pnpm-lock.yaml"), newContent);
  const after = (await bindFileAsStaged(fixture.repo, "pnpm-lock.yaml")) ?? null;
  await appendDecisionRecord(fixture.dir, createDecisionDraft({ lockfilePath: "pnpm-lock.yaml", before, after }));
}

describe("verifyDecisions", () => {
  it("verifies a recorded lockfile change anchored at base and head", async () => {
    const fixture = await createBaseFixture();
    await recordLockfileChange(fixture, "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n");
    const head = commitAll(fixture.dir, "add left-pad with record");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verifiedPaths).toEqual(["pnpm-lock.yaml"]);
  });

  it("verifies a multi-step chain within one delta (intermediate states never committed)", async () => {
    const fixture = await createBaseFixture();
    await recordLockfileChange(fixture, "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n");
    await recordLockfileChange(
      fixture,
      "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n  is-odd@3.0.1: {}\n"
    );
    const head = commitAll(fixture.dir, "two installs, one commit");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails a lockfile change without any record, however it was produced", async () => {
    const fixture = await createBaseFixture();
    await writeFile(path.join(fixture.dir, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages:\n  evil@1.0.0: {}\n");
    const head = commitAll(fixture.dir, "raw lockfile edit");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-missing");
  });

  it("fails when a second workspace lockfile changes without its own chain (M4)", async () => {
    const fixture = await createBaseFixture();
    await mkdir(path.join(fixture.dir, "apps", "web"), { recursive: true });
    await writeFile(path.join(fixture.dir, "apps", "web", "package-lock.json"), '{"lockfileVersion":3}\n');
    const base = commitAll(fixture.dir, "base with two lockfiles");

    await recordLockfileChange(fixture, "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n");
    // The second lockfile rides along without a record.
    await writeFile(
      path.join(fixture.dir, "apps", "web", "package-lock.json"),
      '{"lockfileVersion":3,"packages":{"node_modules/evil":{}}}\n'
    );
    const head = commitAll(fixture.dir, "recorded change plus unrecorded rider");

    const result = await verifyDecisions(fixture.dir, { baseRef: base, headRef: head });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-missing");
    expect(result.findings.some((finding) => finding.message.includes("apps/web/package-lock.json"))).toBe(true);
  });

  it("fails a chain that does not connect to the base being merged onto", async () => {
    const fixture = await createBaseFixture();
    // Record built against a 'before' that is NOT the base state (fabricated
    // history): before=null claims the lockfile did not exist at base.
    await writeFile(path.join(fixture.dir, "pnpm-lock.yaml"), "lockfileVersion: 9\npackages:\n  x@1.0.0: {}\n");
    const after = (await bindFileAsStaged(fixture.repo, "pnpm-lock.yaml")) ?? null;
    await appendDecisionRecord(
      fixture.dir,
      createDecisionDraft({ lockfilePath: "pnpm-lock.yaml", before: null, after })
    );
    const head = commitAll(fixture.dir, "record with fabricated before-state");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-base-unanchored");
  });

  it("fails when the final recorded state does not match the committed head", async () => {
    const fixture = await createBaseFixture();
    await recordLockfileChange(fixture, "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n");
    // After recording, the lockfile is silently edited again with no record.
    await writeFile(
      path.join(fixture.dir, "pnpm-lock.yaml"),
      "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n  evil@9.9.9: {}\n"
    );
    const head = commitAll(fixture.dir, "post-record tamper");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-binding-mismatch");
  });

  it("fails a record whose committed bytes were tampered with", async () => {
    const fixture = await createBaseFixture();
    await recordLockfileChange(fixture, "lockfileVersion: 9\npackages:\n  left-pad@1.3.0: {}\n");

    const dir = decisionsDirForLockfile(fixture.dir, "pnpm-lock.yaml");
    const [fileName] = await readdir(dir);
    const filePath = path.join(dir, present(fileName));
    const tampered = (await readFile(filePath, "utf8")).replace('"decision":"allow"', '"decision":"block"');
    await writeFile(filePath, tampered);
    const head = commitAll(fixture.dir, "tampered record");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.code === "decisions-name-mismatch" || finding.code === "decisions-invalid-record"
      )
    ).toBe(true);
  });

  it("treats a non-default registryUrl as a hard finding unless allowlisted (D3)", async () => {
    const fixture = await createBaseFixture();
    await writeFile(
      path.join(fixture.dir, "safeinstall.config.json"),
      JSON.stringify({ registryUrl: "https://registry.attacker.example" }, null, 2)
    );
    const head = commitAll(fixture.dir, "redirect registry");

    const flagged = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });
    expect(flagged.ok).toBe(false);
    expect(flagged.findings.map((finding) => finding.code)).toContain("registry-not-default");

    const allowlisted = await verifyDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head,
      allowedRegistryUrls: ["https://registry.attacker.example"]
    });
    expect(allowlisted.findings.map((finding) => finding.code)).not.toContain("registry-not-default");
  });

  it("passes and reports when no lockfile changed", async () => {
    const fixture = await createBaseFixture();
    await writeFile(path.join(fixture.dir, "README.md"), "docs only\n");
    const head = commitAll(fixture.dir, "docs");

    const result = await verifyDecisions(fixture.dir, { baseRef: fixture.base, headRef: head });

    expect(result.ok).toBe(true);
    expect(result.verifiedPaths).toEqual([]);
    expect(result.infos.some((info) => info.includes("No lockfile changes"))).toBe(true);
  });

  it("errors on unresolvable refs and outside git repositories", async () => {
    const fixture = await createBaseFixture();
    const badRef = await verifyDecisions(fixture.dir, { baseRef: "no-such-ref" });
    expect(badRef.ok).toBe(false);
    expect(badRef.findings.map((finding) => finding.code)).toContain("decisions-bad-ref");
  });
});
