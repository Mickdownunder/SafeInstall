import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseDecisionRecord } from "../src/decision-record";
import { decisionsDirForLockfile, readDecisionChain } from "../src/decision-store";
import { verifyDecisions } from "../src/decision-verify";
import {
  cleanupTempDirs,
  createStubPackageManager,
  createTempDir,
  ensureBuiltCli,
  runCli,
  startRegistryFixture,
  writeDefaultConfig,
  writeJson,
  type RegistryFixture
} from "./cli-e2e-helpers";
import { commitAll, git } from "./helpers/git-fixture";

/**
 * End-to-end: a real CLI process installing through a stub package manager in
 * a real git repository must leave an L0 decision record that the
 * committed-state verifier then accepts — the full local half of the RFC-001
 * vertical slice, exercised from the outside.
 */

let registry: RegistryFixture;

beforeAll(async () => {
  await ensureBuiltCli();
  registry = await startRegistryFixture();
  process.env.SAFEINSTALL_TEST_REGISTRY = registry.url;
});

afterAll(async () => {
  delete process.env.SAFEINSTALL_TEST_REGISTRY;
  await registry.close();
});

afterEach(async () => {
  await cleanupTempDirs();
});

async function createGitProject(): Promise<string> {
  const dir = await createTempDir("safeinstall-emit-e2e-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@safeinstall.test");
  git(dir, "config", "user.name", "SafeInstall Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  await writeJson(path.join(dir, "package.json"), { name: "emit-fixture", version: "1.0.0" });
  await writeDefaultConfig(dir);
  return dir;
}

describe("decision record emission (e2e)", () => {
  it("writes an actor-tagged allow record for a stub-executed install and verifies it end to end", async () => {
    const project = await createGitProject();
    // The stub "installs" by writing the lockfile the real manager would.
    const lockfilePath = path.join(project, "package-lock.json");
    const stub = await createStubPackageManager("npm", {
      script: `require("node:fs").writeFileSync(${JSON.stringify(lockfilePath)}, JSON.stringify({ lockfileVersion: 3, packages: {} }) + "\\n");
process.exit(0);
`
    });
    commitAll(project, "base");

    const result = await runCli(["npm", "install", "left-pad@1.13.2", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAUDECODE: "1"
      }
    });

    expect(result.code).toBe(0);

    const chain = await readDecisionChain(project, "package-lock.json");
    expect(chain).toHaveLength(1);
    const record = chain[0].record;
    expect(record.recordType).toBe("install");
    expect(record.actor).toBe("agent");
    expect(record.verdict.decision).toBe("allow");
    expect(record.installed).toBe(true);
    expect(record.request.packageManager).toBe("npm");
    expect(record.lockfile.before).toBeNull();
    expect(record.lockfile.after).not.toBeNull();
    expect(record.observations[0]).toMatchObject({
      name: "left-pad",
      sourceType: "registry",
      publishTimeSource: "registry-time"
    });

    const parsed = JSON.parse(result.stdout) as { infos: string[] };
    expect(parsed.infos.some((info) => info.includes("Decision record written"))).toBe(true);

    // The committed record + lockfile must satisfy the committed-state
    // verifier — the local half of the L0->L1 slice, end to end.
    const base = git(project, "rev-parse", "HEAD");
    const head = commitAll(project, "install with record");
    // The fixture registry is a non-default URL, so it must be allowlisted
    // verifier-side (D3) — the same move a private-mirror deployment makes.
    const verified = await verifyDecisions(project, {
      baseRef: base,
      headRef: head,
      allowedRegistryUrls: [registry.url]
    });
    expect(verified.findings).toEqual([]);
    expect(verified.ok).toBe(true);
    expect(verified.verifiedPaths).toEqual(["package-lock.json"]);
  });

  it("records a block verdict without running the package manager", async () => {
    const project = await createGitProject();
    // A future publish date relative to the fixture's 2018 dates never
    // clears any positive age gate.
    await writeDefaultConfig(project, { minimumReleaseAgeHours: 24 * 365 * 100 });
    const stub = await createStubPackageManager("npm");
    commitAll(project, "base");

    const result = await runCli(["npm", "install", "left-pad@1.13.2", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(2);

    const chain = await readDecisionChain(project, "package-lock.json");
    expect(chain).toHaveLength(1);
    const record = chain[0].record;
    expect(record.verdict.decision).toBe("block");
    expect(record.verdict.reasons.map((reason) => reason.code)).toContain("release-too-new");
    expect(record.installed).toBeNull();
    expect(record.lockfile.before).toBeNull();
    expect(record.lockfile.after).toBeNull();
  });

  it("marks file: sources with explicit non-registry findings that never read clean (D4)", async () => {
    const project = await createGitProject();
    await writeDefaultConfig(project, { allowedSources: ["registry", "file", "directory"] });
    await writeFile(path.join(project, "vendored.tgz"), "not-a-real-tarball");
    const stub = await createStubPackageManager("npm");
    commitAll(project, "base");

    const result = await runCli(["npm", "install", "file:./vendored.tgz", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);

    const chain = await readDecisionChain(project, "package-lock.json");
    expect(chain).toHaveLength(1);
    const observation = chain[0].record.observations[0];
    expect(observation.findings.map((finding) => finding.code)).toContain("non-registry-source");
    expect(observation.notEvaluable.releaseAge).not.toBeNull();
    expect(observation.notEvaluable.provenance).not.toBeNull();
    expect(chain[0].record.verdict.notEvaluableCount).toBe(1);
  });

  it("chains a second install onto the first record", async () => {
    const project = await createGitProject();
    const lockfilePath = path.join(project, "package-lock.json");
    const stub = await createStubPackageManager("npm", {
      script: `require("node:fs").writeFileSync(${JSON.stringify(lockfilePath)}, JSON.stringify({ lockfileVersion: 3, seq: process.hrtime.bigint().toString() }) + "\\n");
process.exit(0);
`
    });
    commitAll(project, "base");
    const env = {
      ...process.env,
      PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    await runCli(["npm", "install", "left-pad@1.13.2", "--json"], { cwd: project, env });
    await runCli(["npm", "install", "left-pad@1.14.0", "--json"], { cwd: project, env });

    const chain = await readDecisionChain(project, "package-lock.json");
    expect(chain).toHaveLength(2);
    expect(chain[1].record.chain.prev).toBe(chain[0].digest);
    // Continuity across the two decisions: record 2 starts where record 1 ended.
    expect(chain[1].record.lockfile.before?.blobOid).toBe(chain[0].record.lockfile.after?.blobOid);
  });

  it("says so, loudly, when no record can be written (no git repository)", async () => {
    const project = await createTempDir("safeinstall-emit-nogit-");
    await writeJson(path.join(project, "package.json"), { name: "no-git", version: "1.0.0" });
    await writeDefaultConfig(project);
    const stub = await createStubPackageManager("npm");

    const result = await runCli(["npm", "install", "left-pad@1.13.2", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { infos: string[] };
    expect(parsed.infos.some((info) => info.includes("Decision record not written"))).toBe(true);
  });

  it("emits a check record only with --record, binding before == after", async () => {
    const project = await createGitProject();
    await writeJson(path.join(project, "package.json"), {
      name: "emit-fixture",
      version: "1.0.0",
      dependencies: { "left-pad": "1.13.2" }
    });
    await writeFile(
      path.join(project, "package-lock.json"),
      JSON.stringify({
        name: "emit-fixture",
        lockfileVersion: 3,
        packages: {
          "": { name: "emit-fixture", dependencies: { "left-pad": "1.13.2" } },
          "node_modules/left-pad": { version: "1.13.2", resolved: "", integrity: "" }
        }
      }) + "\n"
    );
    commitAll(project, "base");

    const withoutFlag = await runCli(["check", "--json"], { cwd: project, env: { ...process.env } });
    expect(withoutFlag.code).toBe(0);
    expect(await readDecisionChain(project, "package-lock.json")).toHaveLength(0);

    const withFlag = await runCli(["check", "--record", "--json"], { cwd: project, env: { ...process.env } });
    expect(withFlag.code).toBe(0);
    const chain = await readDecisionChain(project, "package-lock.json");
    expect(chain).toHaveLength(1);
    const record = chain[0].record;
    expect(record.recordType).toBe("check");
    expect(record.installed).toBeNull();
    expect(record.lockfile.before?.blobOid).toBe(record.lockfile.after?.blobOid);
  });
});

describe("decision record file hygiene (e2e)", () => {
  it("writes records as exactly the canonical bytes", async () => {
    const project = await createGitProject();
    const lockfilePath = path.join(project, "package-lock.json");
    const stub = await createStubPackageManager("npm", {
      script: `require("node:fs").writeFileSync(${JSON.stringify(lockfilePath)}, "{}\\n");
process.exit(0);
`
    });
    commitAll(project, "base");

    await runCli(["npm", "install", "left-pad@1.13.2", "--json"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    const dir = decisionsDirForLockfile(project, "package-lock.json");
    const [fileName] = await readdir(dir);
    const bytes = await readFile(path.join(dir, fileName));
    // parseDecisionRecord enforces canonical bytes; a pretty-printed or
    // newline-terminated file would throw here.
    expect(() => parseDecisionRecord(bytes)).not.toThrow();
  });
});
