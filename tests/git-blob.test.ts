import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { commitAll, commitRawPaths, createRepoFixture, git } from "./helpers/git-fixture";

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

  it.skipIf(process.platform === "win32")(
    "preserves paths that Git quotes or splits in line-delimited output",
    async () => {
      const { dir } = await createRepoFixture(tempDirs);
      const parentNames = ["unicode-雪", "tab-\t", "newline-\n", 'quote-"', "backslash-\\"];
      const repoPaths = parentNames.map((parent) => `workspace/${parent}/package-lock.json`).sort();

      for (const repoPath of repoPaths) {
        await mkdir(path.dirname(path.join(dir, repoPath)), { recursive: true });
        await writeFile(path.join(dir, repoPath), '{"lockfileVersion":3}\n');
      }
      const base = commitAll(dir, "base with unusually named workspaces");

      for (const repoPath of repoPaths) {
        await writeFile(path.join(dir, repoPath), '{"lockfileVersion":3,"packages":{"evil":{}}}\n');
      }
      const head = commitAll(dir, "change unusually named workspace lockfiles");
      const repo = (await resolveGitRepo(dir))!;

      expect(await changedPaths(repo, base, head)).toEqual(repoPaths);
      expect(await pathsAtRef(repo, head, "workspace")).toEqual(repoPaths);
    }
  );

  it("rejects repository paths that are not valid UTF-8", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const lockfilePath = Buffer.concat([
      Buffer.from("workspace/invalid-"),
      Buffer.from([0xff]),
      Buffer.from("/package-lock.json")
    ]);
    const base = commitRawPaths(dir, [[lockfilePath, '{"lockfileVersion":3}\n']], "base with non-UTF-8 path");
    const head = commitRawPaths(
      dir,
      [[lockfilePath, '{"lockfileVersion":3,"packages":{"evil":{}}}\n']],
      "change non-UTF-8 path"
    );
    const repo = (await resolveGitRepo(dir))!;

    await expect(changedPaths(repo, base, head)).rejects.toThrow("not valid UTF-8");
    await expect(pathsAtRef(repo, head, "workspace")).rejects.toThrow("not valid UTF-8");
    // A caller that names the final components it cares about still fails
    // closed for a lockfile under a non-UTF-8 directory.
    await expect(changedPaths(repo, base, head, new Set(["package-lock.json"]))).rejects.toThrow(
      "not valid UTF-8"
    );
  });

  it("skips unrelated non-UTF-8 paths when the caller names the relevant file names", async () => {
    const { dir } = await createRepoFixture(tempDirs);
    const oddFile = Buffer.concat([Buffer.from("legacy-"), Buffer.from([0xe9]), Buffer.from(".txt")]);
    const lockfile = Buffer.from("pnpm-lock.yaml");
    const base = commitRawPaths(dir, [[oddFile, "a\n"], [lockfile, "v: 1\n"]], "base");
    const head = commitRawPaths(dir, [[oddFile, "b\n"], [lockfile, "v: 2\n"]], "change");
    const repo = (await resolveGitRepo(dir))!;

    expect(await changedPaths(repo, base, head, new Set(["pnpm-lock.yaml"]))).toEqual(["pnpm-lock.yaml"]);
    await expect(changedPaths(repo, base, head)).rejects.toThrow("not valid UTF-8");
  });
});
