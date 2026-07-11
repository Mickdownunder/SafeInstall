import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindFileAsStaged,
  blobOidAtRef,
  changedPaths,
  pathsAtRef,
  readBlob,
  resolveGitRepo
} from "../src/git-blob";
import { commitAll, createRepoFixture, git } from "./helpers/git-fixture";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("resolveGitRepo", () => {
  it("returns the repo root and object format inside a repository", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const repo = await resolveGitRepo(dir);
    expect(repo).toBeDefined();
    expect(await import("node:fs/promises").then((fs) => fs.realpath(repo!.root))).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(dir))
    );
    expect(["sha1", "sha256"]).toContain(repo!.objectFormat);
  });

  it("returns undefined outside any repository", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-nogit-"));
    tempDirs.push(dir);
    expect(await resolveGitRepo(dir)).toBeUndefined();
  });
});

describe("bindFileAsStaged", () => {
  it("matches git's own hash for plain content and hashes the raw bytes", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const content = Buffer.from('{"name":"fixture"}\n', "utf8");
    await writeFile(path.join(dir, "package.json"), content);

    const repo = (await resolveGitRepo(dir))!;
    const binding = (await bindFileAsStaged(repo, "package.json"))!;

    expect(binding.blobOid).toBe(git(dir, "hash-object", "package.json"));
    expect(binding.sha256).toBe(sha256Hex(content));
  });

  it("returns undefined for a missing file (explicit absence)", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const repo = (await resolveGitRepo(dir))!;
    expect(await bindFileAsStaged(repo, "does-not-exist.json")).toBeUndefined();
  });

  it("binds post-clean bytes when eol attributes apply, agreeing with the committed blob", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFile(path.join(dir, ".gitattributes"), "*.lock text eol=lf\n");
    const crlfContent = Buffer.from("a: 1\r\nb: 2\r\n", "utf8");
    const lfContent = Buffer.from("a: 1\nb: 2\n", "utf8");
    await writeFile(path.join(dir, "test.lock"), crlfContent);

    const repo = (await resolveGitRepo(dir))!;
    const binding = (await bindFileAsStaged(repo, "test.lock"))!;

    // The record-time binding is over the STAGED (LF) bytes...
    expect(binding.sha256).toBe(sha256Hex(lfContent));

    // ...and equals the blob identity git actually commits — the D2 property
    // that makes record-time and merge-time verification agree.
    const head = commitAll(dir, "add lockfile");
    expect(await blobOidAtRef(repo, head, "test.lock")).toBe(binding.blobOid);
    expect(sha256Hex(await readBlob(repo, binding.blobOid))).toBe(binding.sha256);
  });
});

describe("tree helpers", () => {
  it("lists changed paths between commits and paths under a prefix", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "v: 1\n");
    await writeFile(path.join(dir, "README.md"), "hi\n");
    const base = commitAll(dir, "base");

    await writeFile(path.join(dir, "pnpm-lock.yaml"), "v: 2\n");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, ".safeinstall", "decisions", "slug"), { recursive: true });
    await writeFile(path.join(dir, ".safeinstall", "decisions", "slug", "000001-abc.json"), "{}");
    const head = commitAll(dir, "change");

    const repo = (await resolveGitRepo(dir))!;
    expect(await changedPaths(repo, base, head)).toEqual([
      ".safeinstall/decisions/slug/000001-abc.json",
      "pnpm-lock.yaml"
    ]);
    expect(await pathsAtRef(repo, head, ".safeinstall/decisions")).toEqual([
      ".safeinstall/decisions/slug/000001-abc.json"
    ]);
    expect(await blobOidAtRef(repo, base, "missing.txt")).toBeUndefined();
  });
});
