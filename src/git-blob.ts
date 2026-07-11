import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Git blob bindings for decision records (RFC-001 §5.2, decision D2).
 *
 * Records bind repository files by the blob OID git itself would stage
 * (`git hash-object --path`), paired with an independent sha256 over the same
 * staged bytes. Binding as-staged makes record-time identity and commit-time
 * identity agree by construction, and makes every working-tree
 * materialization knob (core.autocrlf, smudge/clean filters, uncommitted
 * .git/info/attributes) irrelevant to what the binding means: any staged-byte
 * manipulation surfaces as a plain OID mismatch in CI.
 *
 * All git invocations are argument-array spawns (never a shell), and paths
 * are passed behind `--` where git accepts it.
 */

export type GitObjectFormat = "sha1" | "sha256";

export interface GitRepoContext {
  /** Absolute path of the repository's working-tree root. */
  root: string;
  objectFormat: GitObjectFormat;
}

/** One file bound to repository content (RFC-001 §5.2). */
export interface GitFileBinding {
  /** Repository-relative path, forward slashes. */
  path: string;
  /** Blob OID exactly as git would stage the content. */
  blobOid: string;
  objectFormat: GitObjectFormat;
  /** sha256 over the same staged bytes — the collision hedge for sha1 repos. */
  sha256: string;
}

const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export class GitError extends Error {
  constructor(message: string, readonly gitArgs: string[]) {
    super(message);
    this.name = "GitError";
  }
}

function runGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: "buffer",
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.toString("utf8").trim();
          reject(new GitError(`git ${args[0]} failed${detail ? `: ${detail}` : `: ${error.message}`}`, args));
          return;
        }
        resolve(stdout);
      }
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

async function runGitText(cwd: string, args: string[], input?: Buffer): Promise<string> {
  return (await runGit(cwd, args, input)).toString("utf8").replace(/\r?\n$/, "");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalize a repo-relative path to forward slashes. */
export function toRepoRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

/**
 * The enclosing git repository, or undefined when `cwd` is not inside one
 * (or git itself is unavailable). Decision records require a repository —
 * callers turn undefined into their own explicit, non-silent handling.
 */
export async function resolveGitRepo(cwd: string): Promise<GitRepoContext | undefined> {
  let root: string;
  try {
    root = await runGitText(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
  if (!root) {
    return undefined;
  }

  let objectFormat: GitObjectFormat = "sha1";
  try {
    const reported = await runGitText(cwd, ["rev-parse", "--show-object-format"]);
    if (reported === "sha256") {
      objectFormat = "sha256";
    }
  } catch {
    // Older git without --show-object-format only supports sha1.
  }

  return { root: path.resolve(root), objectFormat };
}

/**
 * Bind a file's current content exactly as git would stage it, or undefined
 * when the file does not exist (an explicit "absent" state for the record).
 *
 * The sha256 must cover the STAGED bytes, which differ from the on-disk bytes
 * when a clean filter or eol attribute applies. Hashing twice — once through
 * the attribute pipeline, once raw — detects that case cheaply; only then is
 * the object written to the odb to read the filtered bytes back (loose,
 * unreferenced, gc-collected).
 */
export async function bindFileAsStaged(
  repo: GitRepoContext,
  repoRelativePath: string
): Promise<GitFileBinding | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path.join(repo.root, repoRelativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const [filteredOid, rawOid] = await Promise.all([
    runGitText(repo.root, ["hash-object", "--stdin", `--path=${repoRelativePath}`], raw),
    runGitText(repo.root, ["hash-object", "--stdin", "--no-filters"], raw)
  ]);

  let stagedBytes = raw;
  if (filteredOid !== rawOid) {
    const writtenOid = await runGitText(
      repo.root,
      ["hash-object", "-w", "--stdin", `--path=${repoRelativePath}`],
      raw
    );
    stagedBytes = await runGit(repo.root, ["cat-file", "blob", writtenOid]);
  }

  return {
    path: repoRelativePath,
    blobOid: filteredOid,
    objectFormat: repo.objectFormat,
    sha256: sha256Hex(stagedBytes)
  };
}

/** Blob OID of `path` at `ref`, or undefined when absent there. */
export async function blobOidAtRef(
  repo: GitRepoContext,
  ref: string,
  repoRelativePath: string
): Promise<string | undefined> {
  try {
    return await runGitText(repo.root, ["rev-parse", `${ref}:${repoRelativePath}`]);
  } catch {
    return undefined;
  }
}

/** Raw content of a blob by OID. */
export async function readBlob(repo: GitRepoContext, oid: string): Promise<Buffer> {
  return runGit(repo.root, ["cat-file", "blob", oid]);
}

/** Repo-relative paths that differ between two committed revisions. */
export async function changedPaths(repo: GitRepoContext, baseRef: string, headRef: string): Promise<string[]> {
  const output = await runGitText(repo.root, [
    "diff",
    "--name-only",
    "--no-renames",
    baseRef,
    headRef,
    "--"
  ]);
  return output === "" ? [] : output.split("\n");
}

/** Repo-relative paths under `prefix` present in the tree at `ref`. */
export async function pathsAtRef(repo: GitRepoContext, ref: string, prefix: string): Promise<string[]> {
  let output: string;
  try {
    output = await runGitText(repo.root, ["ls-tree", "-r", "--name-only", ref, "--", prefix]);
  } catch {
    return [];
  }
  return output === "" ? [] : output.split("\n");
}

/** Resolve a revision expression to a full commit id, or undefined. */
export async function resolveCommit(repo: GitRepoContext, ref: string): Promise<string | undefined> {
  try {
    return await runGitText(repo.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}
