import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isCanonicalJson } from "../src/canonical-json";
import { authorizeDecisions } from "../src/decision-authorize";
import { runDecisionsFlow } from "../src/decision-flow";
import { appendDecisionRecord } from "../src/decision-store";
import { bindFileAsStaged, resolveGitRepo, type GitRepoContext } from "../src/git-blob";
import { createDecisionDraft } from "./helpers/decision-fixture";
import { commitAll, createRepoFixture, git } from "./helpers/git-fixture";

/**
 * The online half of L1: authorize = verify + fresh policy re-evaluation of
 * the committed head state. These tests run a loopback registry so the
 * re-evaluation's "registry metadata fetched now" is real and hermetic.
 */

const tempDirs: string[] = [];
let server: Server;
let registryUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const requestUrl = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (requestUrl.includes("/-/")) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT"
      });
      res.end();
      return;
    }
    const segments = requestUrl.split("/").filter(Boolean);
    const [name, version] = segments;
    if (name && version) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version, dist: {}, scripts: {} }));
      return;
    }
    if (name) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          "dist-tags": { latest: "1.13.2" },
          versions: { "1.13.2": { version: "1.13.2" } },
          time: { "1.13.2": "2018-01-01T00:00:00.000Z" }
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registryUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  dir: string;
  repo: GitRepoContext;
  base: string;
}

async function createAuthorizedFixture(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const { dir } = await createRepoFixture(tempDirs);
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "authorize-fixture", version: "1.0.0", dependencies: { "left-pad": "1.13.2" } }) +
      "\n"
  );
  await writeFile(
    path.join(dir, "safeinstall.config.json"),
    JSON.stringify(
      {
        minimumReleaseAgeHours: 0,
        registryUrl,
        allowedScripts: {},
        allowedSources: ["registry"],
        allowedPackages: [],
        packageManagerDefaults: {
          npm: { ignoreScripts: true },
          pnpm: { ignoreScripts: true },
          bun: { ignoreScripts: true }
        },
        typoSquat: { mode: "off", minNameLength: 4, ignore: [] },
        provenance: { mode: "off", requireFor: [], trustedPublishers: {}, offlineBehavior: "fail-closed" },
        transitive: { mode: "off", checks: ["install-script", "untrusted-source"] },
        continuity: { mode: "off", baselineSize: 5 },
        ...overrides
      },
      null,
      2
    ) + "\n"
  );
  const base = commitAll(dir, "base without lockfile");
  const repo = (await resolveGitRepo(dir))!;

  // A recorded lockfile change: before = absent, after = the new lockfile.
  await writeFile(
    path.join(dir, "package-lock.json"),
    JSON.stringify({
      name: "authorize-fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "authorize-fixture", dependencies: { "left-pad": "1.13.2" } },
        "node_modules/left-pad": { version: "1.13.2", resolved: "", integrity: "" }
      }
    }) + "\n"
  );
  const after = (await bindFileAsStaged(repo, "package-lock.json")) ?? null;
  await appendDecisionRecord(
    dir,
    createDecisionDraft({ lockfilePath: "package-lock.json", before: null, after, registryUrl })
  );
  return { dir, repo, base };
}

describe("authorizeDecisions", () => {
  it("authorizes a verified delta after a fresh evaluation reaches allow", async () => {
    const fixture = await createAuthorizedFixture();
    const head = commitAll(fixture.dir, "install with record");

    const result = await authorizeDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head,
      allowedRegistryUrls: [registryUrl]
    });

    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.authorization).toMatchObject({
      schemaVersion: 1,
      verdict: "allow",
      headCommit: head,
      lockfiles: [{ path: "package-lock.json" }]
    });
    expect(result.authorization?.policyBlobOid).not.toBeNull();
  });

  it("blocks when the fresh evaluation finds a policy violation, ignoring the recorded allow", async () => {
    // The RECORD claims allow; head policy forbids the package's source
    // signals: minimumReleaseAgeHours far above the fixture's 2018 publish
    // date is impossible, so use an enormous window via a fresh fixture.
    const fixture = await createAuthorizedFixture({ minimumReleaseAgeHours: 24 * 365 * 100 });
    const head = commitAll(fixture.dir, "install with record under absurd policy");

    const result = await authorizeDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head,
      allowedRegistryUrls: [registryUrl]
    });

    expect(result.ok).toBe(false);
    expect(result.authorization?.verdict).toBe("block");
    expect(result.findings.map((finding) => finding.code)).toContain("release-too-new");
  });

  it("fails on a broken chain before evaluating anything", async () => {
    const fixture = await createAuthorizedFixture();
    // A silent post-record lockfile edit invalidates the head anchor.
    await writeFile(path.join(fixture.dir, "package-lock.json"), '{"lockfileVersion":3,"tampered":true}\n');
    const head = commitAll(fixture.dir, "tampered after record");

    const result = await authorizeDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head,
      allowedRegistryUrls: [registryUrl]
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-binding-mismatch");
    expect(result.authorization).toBeUndefined();
  });

  it("refuses dirty working-tree state for the files it evaluates", async () => {
    const fixture = await createAuthorizedFixture();
    const head = commitAll(fixture.dir, "install with record");
    await writeFile(
      path.join(fixture.dir, "safeinstall.config.json"),
      (await readFile(path.join(fixture.dir, "safeinstall.config.json"), "utf8")).replace(
        '"minimumReleaseAgeHours": 0',
        '"minimumReleaseAgeHours": 1'
      )
    );

    const result = await authorizeDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head,
      allowedRegistryUrls: [registryUrl]
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("decisions-dirty-state");
  });

  it("fails a non-allowlisted registry via the verify precondition (D3)", async () => {
    const fixture = await createAuthorizedFixture();
    const head = commitAll(fixture.dir, "install with record");

    const result = await authorizeDecisions(fixture.dir, {
      baseRef: fixture.base,
      headRef: head
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("registry-not-default");
  });
});

describe("decisions authorize CLI", () => {
  it("writes the authorization artifact as canonical bytes with --output", async () => {
    const fixture = await createAuthorizedFixture();
    const head = commitAll(fixture.dir, "install with record");
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-authz-"));
    tempDirs.push(artifactDir);
    const artifactPath = path.join(artifactDir, "authorization.json");

    const result = await runDecisionsFlow(fixture.dir, [
      "decisions",
      "authorize",
      "--base",
      fixture.base,
      "--head",
      head,
      "--allow-registry",
      registryUrl,
      "--output",
      artifactPath
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("allow");
    const bytes = await readFile(artifactPath);
    expect(isCanonicalJson(bytes)).toBe(true);
    const artifact = JSON.parse(bytes.toString("utf8")) as { verdict: string; headCommit: string };
    expect(artifact.verdict).toBe("allow");
    expect(artifact.headCommit).toBe(head);
  });

  it("exits 2 with the policy reasons when authorization blocks", async () => {
    const fixture = await createAuthorizedFixture({ minimumReleaseAgeHours: 24 * 365 * 100 });
    const head = commitAll(fixture.dir, "blocked state");

    const result = await runDecisionsFlow(fixture.dir, [
      "decisions",
      "authorize",
      "--base",
      fixture.base,
      "--head",
      head,
      "--allow-registry",
      registryUrl
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.code)).toContain("release-too-new");
  });

  it("keeps requiring --base for authorize", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    git(dir, "commit", "--allow-empty", "-q", "-m", "empty");
    const result = await runDecisionsFlow(dir, ["decisions", "authorize"]);
    expect(result.exitCode).toBe(1);
    expect(result.reasons[0].code).toBe("decisions-invalid-arguments");
  });
});
