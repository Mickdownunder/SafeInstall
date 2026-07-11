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
