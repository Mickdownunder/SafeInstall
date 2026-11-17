import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { listGitlinks, listWorkingTreeFiles } from "./git-blob";
import { detectHiddenUnicode } from "./hidden-unicode";
import { parseMcpServers } from "./mcp-server-parse";
import { fileExists } from "./project-discovery";
import { readLedgerHeadMirror } from "./trust-ledger";

/**
 * Agent Trust Surface — the set of files that program the next agent session
 * or configure SafeInstall's own enforcement. A prompt-injected agent (or a
 * malicious payload) that edits these files owns every future session:
 * weakening the policy config, deleting the guard hook, planting invisible
 * Unicode instructions in a rules file, or registering a malicious MCP
 * server are the persistence mechanisms of the agent era.
 *
 * SafeInstall keeps a hash baseline (the trust lock, committed to the repo)
 * and reconciles the real state against it before guard decisions and CLI
 * flows. Two layers: fast interception of direct writes (redirections, tee,
 * sed -i, rm) and content reconciliation against the baseline.
 *
 * Honest scope — do not overstate this:
 * - The DURABLE guarantee is the COMMITTED lock re-verified on a different
 *   machine (CI or a reviewer). That is what holds against a real adversary.
 * - Locally, this is tamper-EVIDENT against mistakes and non-targeted
 *   tampering, NOT tamper-proof. A scheme-aware agent in the user's own
 *   account can bypass interception (e.g. an install driven from `node -e`),
 *   rewrite the in-repo lock and ledger into a consistent state, and delete
 *   the local head mirror — user space cannot prevent that, because the agent
 *   can read and delete anything the user can. What remains, and what the
 *   design leans on, is that none of that survives CI re-verification of the
 *   committed lock on a machine the agent does not control.
 */

export type TrustSurfaceKind = "enforcement" | "instruction" | "tool";
export type TrustSurfaceMode = "warn" | "strict";

export const TRUST_DIR = ".safeinstall";
export const TRUST_LOCK_FILE = "trust-surface.lock";
export const TRUST_LEDGER_FILE = "ledger.jsonl";
export const TRUST_LOCK_RELATIVE_PATH = `${TRUST_DIR}/${TRUST_LOCK_FILE}`;
export const TRUST_LEDGER_RELATIVE_PATH = `${TRUST_DIR}/${TRUST_LEDGER_FILE}`;

/**
 * The CI re-verification workflow scaffolded by `trust lock --ci github`. It
 * IS the durable anchor, so it is part of the enforcement surface: flipping
 * `verify-trust`/`--require-lock` off or deleting the file is drift, and the
 * guard denies raw shell writes to it.
 */
export const CI_TRUST_WORKFLOW_RELATIVE_PATH = ".github/workflows/safeinstall-trust.yml";

/** Zone 1 — files that configure enforcement itself. Any drift locks down. */
const ENFORCEMENT_FILES = [
  "safeinstall.config.json",
  ".claude/settings.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
  CI_TRUST_WORKFLOW_RELATIVE_PATH
];

/**
 * Zone 2 — files that instruct the agent. Hidden Unicode is always a hard
 * finding (invisible characters have no legitimate purpose in instruction
 * files); plain content drift warns by default because these files change
 * legitimately all the time (Claude Code's memory feature appends to
 * CLAUDE.md by design). "strict" mode hardens content drift to a block.
 */
const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".claude/CLAUDE.md"
];
const INSTRUCTION_DIRS = [".cursor/rules", ".claude/rules"];

/**
 * Agents also load instruction files from subdirectories (Claude Code reads
 * nested CLAUDE.md, Codex nested AGENTS.md, Cursor nested `.cursor/rules`).
 * These names are on the surface at ANY depth; `.claude/CLAUDE.md`,
 * `.claude/rules` and `.github/copilot-instructions.md` stay root-only.
 */
const NESTED_INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
const NESTED_INSTRUCTION_DIR = [".cursor", "rules"];

/** Directories whose content is never on the surface (dependencies, git internals). */
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git"]);

/**
 * Directory-walk limits for the non-git fallback. Hitting the cap makes the
 * snapshot throw, which every caller already treats as fail-closed.
 */
const WALK_MAX_DIRECTORIES = 20_000;

/** Is this repository-relative POSIX path a nested (depth >= 0) instruction file by shape? */
function isNestedInstructionPath(posixRelative: string): boolean {
  const segments = posixRelative.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return false;
  }
  if (NESTED_INSTRUCTION_NAMES.includes(segments[segments.length - 1] as string)) {
    return true;
  }
  // A file below `<any>/.cursor/rules/`.
  for (let index = 0; index + 2 < segments.length; index += 1) {
    if (segments[index] === NESTED_INSTRUCTION_DIR[0] && segments[index + 1] === NESTED_INSTRUCTION_DIR[1]) {
      return true;
    }
  }
  return false;
}

/** Zone 3 — files that define which tools/MCP servers the agent can reach. */
const TOOL_FILES = [".mcp.json", ".cursor/mcp.json"];

/** Files that may carry an `mcpServers` block worth tracking semantically. */
const MCP_CONFIG_FILES = [".mcp.json", ".cursor/mcp.json", ".claude/settings.json"];

export interface TrustSurfaceFileEntry {
  /** Project-relative path with forward slashes. */
  path: string;
  kind: TrustSurfaceKind;
  sha256: string;
  /** Unique hidden code points present in the file, as U+XXXX labels. */
  hiddenUnicode: string[];
}

export interface TrustSurfaceMcpServer {
  name: string;
  /** Project-relative path of the config file declaring the server. */
  source: string;
  /** Hash over command/args/url/type — no secret values are stored. */
  commandHash: string;
  /** Env variable NAMES the server receives (never values). */
  envKeys: string[];
  /** True for runner-launched servers without a pinned version (rug-pull vector). */
  unpinned: boolean;
}

export interface TrustSurfaceLock {
  schemaVersion: 1;
  mode: TrustSurfaceMode;
  files: TrustSurfaceFileEntry[];
  mcpServers: TrustSurfaceMcpServer[];
  approvedAt: string;
  ledgerHead: string;
}

export interface TrustSurfaceSnapshot {
  files: TrustSurfaceFileEntry[];
  mcpServers: TrustSurfaceMcpServer[];
}

export interface TrustSurfaceFileDrift {
  path: string;
  kind: TrustSurfaceKind;
  change: "added" | "removed" | "modified";
}

export interface TrustSurfaceMcpDrift {
  name: string;
  source: string;
  change: "added" | "removed" | "modified";
  envKeysAdded: string[];
  unpinned: boolean;
}

export interface TrustSurfaceDrift {
  files: TrustSurfaceFileDrift[];
  mcpServers: TrustSurfaceMcpDrift[];
  /**
   * Hidden Unicode present in tracked files. Always a finding — baselines
   * cannot contain it (lock/approve refuse), so any occurrence here is a
   * genuine injection signal, not an approved artifact.
   */
  newHiddenUnicode: Array<{ path: string; codes: string[] }>;
  clean: boolean;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash of a baseline's full identity — schema version, enforcement mode, and
 * the tracked files + MCP servers. Recorded in the ledger at lock/approve time
 * and re-checked on every reconciliation, so editing the committed lock is
 * detected: dropping a protected file, OR downgrading `mode` from strict to
 * warn to soften instruction-drift enforcement, changes this hash but cannot
 * change the hash-chained ledger entry without breaking the chain.
 */
export function computeBaselineHash(baseline: {
  schemaVersion: number;
  mode: TrustSurfaceMode;
  files: TrustSurfaceFileEntry[];
  mcpServers: TrustSurfaceMcpServer[];
}): string {
  return sha256(
    JSON.stringify({
      schemaVersion: baseline.schemaVersion,
      mode: baseline.mode,
      files: baseline.files,
      mcpServers: baseline.mcpServers
    })
  );
}

function toPosixRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function createFileEntry(
  root: string,
  absolutePath: string,
  kind: TrustSurfaceKind
): Promise<TrustSurfaceFileEntry> {
  const raw = await readFile(absolutePath);
  const text = raw.toString("utf8");
  return {
    path: toPosixRelative(root, absolutePath),
    kind,
    sha256: sha256(raw),
    hiddenUnicode: detectHiddenUnicode(text)
  };
}

/**
 * Bounded breadth-first walk used outside a git repository. Skips
 * `node_modules`, `.git` and hidden directories other than `.cursor` and
 * `.claude`. Throws when more than WALK_MAX_DIRECTORIES directories would be
 * visited: silently ignoring part of the tree would let a nested file escape.
 */
async function walkForNestedInstructions(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [""];
  let visited = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    visited += 1;
    if (visited > WALK_MAX_DIRECTORIES) {
      throw new Error(
        `The trust surface walk stopped after ${WALK_MAX_DIRECTORIES} directories in ${root}; ` +
          "nested instruction files cannot be enumerated reliably outside a git repository."
      );
    }
    let entries;
    try {
      entries = await readdir(path.join(root, ...next.split("/").filter(Boolean)), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = next === "" ? entry.name : `${next}/${entry.name}`;
      if (entry.isDirectory()) {
        const hidden = entry.name.startsWith(".") && entry.name !== ".cursor" && entry.name !== ".claude";
        if (!EXCLUDED_SEGMENTS.has(entry.name) && !hidden) {
          queue.push(relative);
        }
      } else if (entry.isFile() && isNestedInstructionPath(relative)) {
        found.push(relative);
      }
    }
  }
  return found;
}

/**
 * Nested instruction files (repository-relative POSIX paths). In a git
 * checkout this is ONE `git ls-files` call (tracked plus untracked-but-not-
 * ignored, so a brand-new `sub/AGENTS.md` is seen) filtered by name. Files
 * ignored by .gitignore are not discovered. If git cannot answer, the bounded
 * directory walk is used instead.
 */
async function discoverNestedInstructionPaths(root: string): Promise<string[]> {
  // Ask git from the trust root itself, which may be a subdirectory of the
  // repository: `ls-files` then lists paths relative to that directory. This
  // keeps the directory walk, which runs on every guard call, for trees that
  // are not in a repository at all.
  try {
    return await listNestedInstructionsWithGit(root, "", 0);
  } catch {
    return walkForNestedInstructions(root);
  }
}

/** Repositories nested inside the trust root are listed to this depth. */
const NESTED_REPOSITORY_DEPTH = 8;

/**
 * `git ls-files` stops at the boundary of another repository: a submodule is
 * one gitlink entry, and an untracked embedded checkout is one `dir/` entry.
 * Files inside them are still inside the trust root and are read by agents,
 * so each checked-out nested repository is listed in turn.
 */
async function listNestedInstructionsWithGit(dir: string, prefix: string, depth: number): Promise<string[]> {
  const listed = await listWorkingTreeFiles(dir, new Set(NESTED_INSTRUCTION_NAMES));
  const found = listed.filter((entry) => !entry.endsWith("/")).map((entry) => `${prefix}${entry}`);

  const nestedRepositories = listed.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1));
  if (await fileExists(path.join(dir, ".gitmodules"))) {
    nestedRepositories.push(...(await listGitlinks(dir)));
  }

  for (const relative of new Set(nestedRepositories)) {
    if (relative.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
      continue;
    }
    const nestedDir = path.join(dir, ...relative.split("/"));
    // A submodule that is not checked out has no files to read.
    if (!(await fileExists(path.join(nestedDir, ".git")))) {
      continue;
    }
    if (depth >= NESTED_REPOSITORY_DEPTH) {
      throw new Error(`Nested repositories below ${dir} are deeper than ${NESTED_REPOSITORY_DEPTH} levels.`);
    }
    found.push(...(await listNestedInstructionsWithGit(nestedDir, `${prefix}${relative}/`, depth + 1)));
  }
  return found.filter(isNestedInstructionPath);
}

/** Hash every existing trust-surface file and parse MCP declarations. */
export async function snapshotTrustSurface(root: string): Promise<TrustSurfaceSnapshot> {
  const files: TrustSurfaceFileEntry[] = [];
  const seen = new Set<string>();

  const staticEntries: Array<{ relativePath: string; kind: TrustSurfaceKind }> = [
    ...ENFORCEMENT_FILES.map((relativePath) => ({ relativePath, kind: "enforcement" as const })),
    ...INSTRUCTION_FILES.map((relativePath) => ({ relativePath, kind: "instruction" as const })),
    ...TOOL_FILES.map((relativePath) => ({ relativePath, kind: "tool" as const }))
  ];

  for (const { relativePath, kind } of staticEntries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (await fileExists(absolutePath)) {
      seen.add(relativePath);
      files.push(await createFileEntry(root, absolutePath, kind));
    }
  }

  for (const dir of INSTRUCTION_DIRS) {
    const absoluteDir = path.join(root, ...dir.split("/"));
    for (const filePath of await listFilesRecursive(absoluteDir)) {
      const entry = await createFileEntry(root, filePath, "instruction");
      seen.add(entry.path);
      files.push(entry);
    }
  }

  for (const relativePath of await discoverNestedInstructionPaths(root)) {
    if (seen.has(relativePath)) {
      continue;
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    // A tracked file deleted from disk is still listed by git: no entry, so it
    // reads as "removed" drift exactly like a deleted root file.
    if (await fileExists(absolutePath)) {
      seen.add(relativePath);
      files.push(await createFileEntry(root, absolutePath, "instruction"));
    }
  }

  const mcpServers: TrustSurfaceMcpServer[] = [];
  for (const relativePath of MCP_CONFIG_FILES) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (await fileExists(absolutePath)) {
      mcpServers.push(...parseMcpServers(relativePath, await readFile(absolutePath, "utf8")));
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, mcpServers };
}

/** Compare the current snapshot against the locked baseline. */
export function computeTrustSurfaceDrift(
  lock: Pick<TrustSurfaceLock, "files" | "mcpServers">,
  snapshot: TrustSurfaceSnapshot
): TrustSurfaceDrift {
  const fileDrifts: TrustSurfaceFileDrift[] = [];
  const newHiddenUnicode: Array<{ path: string; codes: string[] }> = [];

  const lockedByPath = new Map(lock.files.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(snapshot.files.map((entry) => [entry.path, entry]));

  for (const current of snapshot.files) {
    const locked = lockedByPath.get(current.path);
    if (!locked) {
      fileDrifts.push({ path: current.path, kind: current.kind, change: "added" });
    } else if (locked.sha256 !== current.sha256) {
      fileDrifts.push({ path: current.path, kind: current.kind, change: "modified" });
    }
    // Hidden Unicode is ALWAYS a finding, never "approved" by having been in
    // the baseline. `trust lock`/`approve` refuse to baseline a file that
    // contains it, so a clean baseline plus this check means any hidden
    // Unicode present at reconciliation time is flagged.
    if (current.hiddenUnicode.length > 0) {
      newHiddenUnicode.push({ path: current.path, codes: current.hiddenUnicode });
    }
  }

  for (const locked of lock.files) {
    if (!currentByPath.has(locked.path)) {
      fileDrifts.push({ path: locked.path, kind: locked.kind, change: "removed" });
    }
  }

  const mcpDrifts: TrustSurfaceMcpDrift[] = [];
  const mcpKey = (server: TrustSurfaceMcpServer): string => `${server.source}\u0000${server.name}`;
  const lockedMcp = new Map(lock.mcpServers.map((server) => [mcpKey(server), server]));
  const currentMcp = new Map(snapshot.mcpServers.map((server) => [mcpKey(server), server]));

  for (const current of snapshot.mcpServers) {
    const locked = lockedMcp.get(mcpKey(current));
    if (!locked) {
      mcpDrifts.push({
        name: current.name,
        source: current.source,
        change: "added",
        envKeysAdded: current.envKeys,
        unpinned: current.unpinned
      });
      continue;
    }
    if (locked.commandHash !== current.commandHash || locked.envKeys.join(",") !== current.envKeys.join(",")) {
      mcpDrifts.push({
        name: current.name,
        source: current.source,
        change: "modified",
        envKeysAdded: current.envKeys.filter((key) => !locked.envKeys.includes(key)),
        unpinned: current.unpinned
      });
    }
  }

  for (const locked of lock.mcpServers) {
    if (!currentMcp.has(mcpKey(locked))) {
      mcpDrifts.push({
        name: locked.name,
        source: locked.source,
        change: "removed",
        envKeysAdded: [],
        unpinned: locked.unpinned
      });
    }
  }

  return {
    files: fileDrifts,
    mcpServers: mcpDrifts,
    newHiddenUnicode,
    clean: fileDrifts.length === 0 && mcpDrifts.length === 0 && newHiddenUnicode.length === 0
  };
}

export function trustLockPath(root: string): string {
  return path.join(root, TRUST_DIR, TRUST_LOCK_FILE);
}

export function trustLedgerPath(root: string): string {
  return path.join(root, TRUST_DIR, TRUST_LEDGER_FILE);
}

export async function readTrustLock(root: string): Promise<TrustSurfaceLock> {
  const raw = await readFile(trustLockPath(root), "utf8");
  const parsed = JSON.parse(raw) as Partial<TrustSurfaceLock>;
  if (
    parsed.schemaVersion !== 1 ||
    (parsed.mode !== "warn" && parsed.mode !== "strict") ||
    !Array.isArray(parsed.files) ||
    !Array.isArray(parsed.mcpServers) ||
    typeof parsed.ledgerHead !== "string"
  ) {
    throw new Error(`Trust lock at ${trustLockPath(root)} is malformed.`);
  }
  return parsed as TrustSurfaceLock;
}

export async function writeTrustLock(root: string, lock: TrustSurfaceLock): Promise<void> {
  const lockPath = trustLockPath(root);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const temporaryPath = `${lockPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await rename(temporaryPath, lockPath);
}

/**
 * True when an absolute path points at a trust-surface file, the lock, the
 * ledger, or anything else under `.safeinstall/`. Used by the guard to deny
 * shell writes (redirections, tee, sed -i) that target the surface.
 */
export function isTrustSurfacePath(root: string, absolutePath: string): boolean {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const posixRelative = relative.split(path.sep).join("/");

  if (posixRelative === TRUST_DIR || posixRelative.startsWith(`${TRUST_DIR}/`)) {
    return true;
  }
  if (
    ENFORCEMENT_FILES.includes(posixRelative) ||
    INSTRUCTION_FILES.includes(posixRelative) ||
    TOOL_FILES.includes(posixRelative) ||
    MCP_CONFIG_FILES.includes(posixRelative)
  ) {
    return true;
  }
  if (INSTRUCTION_DIRS.some((dir) => posixRelative === dir || posixRelative.startsWith(`${dir}/`))) {
    return true;
  }
  if (isNestedInstructionPath(posixRelative)) {
    return true;
  }
  // The nested rules directory itself (`a/.cursor/rules`), which has no file below it yet.
  const segments = posixRelative.split("/");
  return (
    segments.length >= 2 &&
    segments[segments.length - 2] === NESTED_INSTRUCTION_DIR[0] &&
    segments[segments.length - 1] === NESTED_INSTRUCTION_DIR[1] &&
    !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))
  );
}

/**
 * The protected shape of the trust surface in repository-relative POSIX form:
 * exact files, and subtrees whose whole content is protected. The guard uses it
 * to decide whether a write target pattern (glob, expansion, unknown cwd) could
 * reach the surface; `isTrustSurfacePath` stays the check for one concrete path.
 */
export function trustSurfaceProtectedPaths(): {
  files: string[];
  subtrees: string[];
  /** File names protected at any depth below the root (never under node_modules or .git). */
  nestedNames: string[];
  /** Directory chains (`.cursor/rules`) whose whole subtree is protected at any depth. */
  nestedSubtree: string[];
} {
  const files = [
    ...new Set([
      ...ENFORCEMENT_FILES,
      ...INSTRUCTION_FILES,
      ...TOOL_FILES,
      ...MCP_CONFIG_FILES,
      TRUST_LOCK_RELATIVE_PATH,
      TRUST_LEDGER_RELATIVE_PATH
    ])
  ];
  return {
    files,
    subtrees: [TRUST_DIR, ...INSTRUCTION_DIRS],
    nestedNames: [...NESTED_INSTRUCTION_NAMES],
    nestedSubtree: [...NESTED_INSTRUCTION_DIR]
  };
}

export type TrustFindingKind =
  | "enforcement-drift"
  | "instruction-drift"
  | "tool-drift"
  | "unpinned-mcp"
  | "hidden-unicode"
  | "ledger-broken"
  | "ledger-mismatch"
  | "mirror-mismatch"
  | "lock-forged"
  | "lock-removed"
  | "lock-unreadable"
  | "lock-ambiguous";

export interface TrustFinding {
  kind: TrustFindingKind;
  message: string;
}

export interface TrustSurfaceStatus {
  /** False when no trust lock (and no mirror) governs this directory. */
  active: boolean;
  root?: string;
  mode?: TrustSurfaceMode;
  lock?: TrustSurfaceLock;
  snapshot?: TrustSurfaceSnapshot;
  drift?: TrustSurfaceDrift;
  /** Hard, block-worthy findings. */
  findings: TrustFinding[];
  /** Instruction-content drift in warn mode: surfaced, not blocking. */
  instructionWarnings: string[];
}

/**
 * True when `candidate/.git` looks like a real git checkout: a directory
 * containing `HEAD`, or a file (worktree/submodule pointer) starting with
 * `gitdir:`. An empty `.git` directory is NOT a boundary: otherwise anyone who
 * can create a directory could declare any subfolder its own "repository" and
 * thereby make a planted lock authoritative.
 *
 * Documented limit: a real `git init` inside a locked repository creates a
 * genuinely independent checkout, and is treated as one by design (that is
 * what keeps submodules, worktrees and vendored repos independent of an
 * enclosing checkout the user never locked for them). The lock of the
 * enclosing repository does not govern it.
 */
async function isGitBoundary(candidate: string): Promise<boolean> {
  const gitPath = path.join(candidate, ".git");
  // Read first and let the failure tell file from directory: a separate
  // stat-then-read would leave a window in which the entry can be swapped.
  try {
    return (await readFile(gitPath, "utf8")).slice(0, 512).startsWith("gitdir:");
  } catch {
    // A directory (or no entry at all): a checkout only if it holds HEAD.
    return fileExists(path.join(gitPath, "HEAD"));
  }
}

/** The nearest repository root, recognizing normal checkouts and worktrees. */
export async function findTrustRepositoryRoot(startDir: string): Promise<string | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (await isGitBoundary(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

async function readTrustContextAt(root: string): Promise<{ root: string; hasLock: boolean } | undefined> {
  if (await fileExists(trustLockPath(root))) {
    return { root, hasLock: true };
  }
  if ((await readLedgerHeadMirror(root)) !== undefined) {
    return { root, hasLock: false };
  }
  return undefined;
}

export interface TrustContext {
  root: string;
  hasLock: boolean;
  /**
   * Set only when more than one directory on the path carries a trust lock
   * (or ledger-head mirror): every such root, nearest first. No lock may
   * silently shadow another, so callers must treat this as a hard finding.
   */
  conflictingRoots?: string[];
}

/**
 * Locate the trust lock that governs a directory. A directory whose
 * ledger-head mirror exists in the user's state dir but whose lock file is
 * gone was tampered with: deleting the lock must not silently disable the
 * trust surface.
 *
 * Scope: from `startDir` up to and including the nearest real git boundary
 * (or the filesystem root outside a repository). Every directory on that path
 * with a lock or mirror is a candidate. Exactly one candidate is authoritative
 * wherever it sits, so a SafeInstall project living in a repo subfolder keeps
 * its protection. More than one is ambiguous and is reported through
 * `conflictingRoots` instead of letting either one win: a planted nested lock
 * must not shadow the real one, and a planted root lock must not shadow a
 * project's own. A nested checkout (submodule, worktree, vendored repo) stays
 * independent because its own `.git` ends the search.
 */
export async function findTrustContext(startDir: string): Promise<TrustContext | undefined> {
  const boundary = await findTrustRepositoryRoot(startDir);
  const candidates: Array<{ root: string; hasLock: boolean }> = [];

  let currentDir = path.resolve(startDir);
  while (true) {
    const context = await readTrustContextAt(currentDir);
    if (context !== undefined) {
      candidates.push(context);
    }

    const parentDir = path.dirname(currentDir);
    if (currentDir === boundary || parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  const [nearest, ...rest] = candidates;
  if (nearest === undefined) {
    return undefined;
  }
  if (rest.length === 0) {
    return nearest;
  }
  return { ...nearest, conflictingRoots: candidates.map((candidate) => candidate.root) };
}
