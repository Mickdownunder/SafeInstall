import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Minimal git driver for repo fixtures — argument arrays only, no shell. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** A fresh repository with deterministic config, isolated from the host. */
export async function createRepoFixture(tracked: string[]): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-git-fixture-"));
  tracked.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "fixture@safeinstall.test");
  git(dir, "config", "user.name", "SafeInstall Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Commit files whose paths are raw bytes, without touching the working tree.
 * Some filesystems (APFS, NTFS) cannot store a name that is not valid UTF-8,
 * but a repository can still contain one, so such paths are written straight
 * into the index.
 */
export function commitRawPaths(dir: string, files: Array<[Buffer, string]>, message: string): string {
  const run = (args: string[], input?: Buffer | string): string =>
    execFileSync("git", args, { cwd: dir, input, encoding: "utf8", windowsHide: true }).trim();

  const records = files.map(([rawPath, content]) => {
    const oid = run(["hash-object", "-w", "--stdin"], content);
    return Buffer.concat([Buffer.from(`100644 ${oid}\t`), rawPath, Buffer.from([0])]);
  });
  run(["update-index", "-z", "--index-info"], Buffer.concat(records));
  const tree = run(["write-tree"]);
  let parent: string | undefined;
  try {
    parent = run(["rev-parse", "-q", "--verify", "HEAD"]);
  } catch {
    parent = undefined;
  }
  const commit = run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
  run(["update-ref", "HEAD", commit]);
  return commit;
}
