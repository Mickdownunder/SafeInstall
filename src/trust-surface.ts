import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".github/copilot-instructions.md"];
const INSTRUCTION_DIRS = [".cursor/rules"];

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

/** Hash every existing trust-surface file and parse MCP declarations. */
export async function snapshotTrustSurface(root: string): Promise<TrustSurfaceSnapshot> {
  const files: TrustSurfaceFileEntry[] = [];

  const staticEntries: Array<{ relativePath: string; kind: TrustSurfaceKind }> = [
    ...ENFORCEMENT_FILES.map((relativePath) => ({ relativePath, kind: "enforcement" as const })),
    ...INSTRUCTION_FILES.map((relativePath) => ({ relativePath, kind: "instruction" as const })),
    ...TOOL_FILES.map((relativePath) => ({ relativePath, kind: "tool" as const }))
  ];

  for (const { relativePath, kind } of staticEntries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    if (await fileExists(absolutePath)) {
      files.push(await createFileEntry(root, absolutePath, kind));
    }
  }

  for (const dir of INSTRUCTION_DIRS) {
    const absoluteDir = path.join(root, ...dir.split("/"));
    for (const filePath of await listFilesRecursive(absoluteDir)) {
      files.push(await createFileEntry(root, filePath, "instruction"));
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
  return INSTRUCTION_DIRS.some((dir) => posixRelative === dir || posixRelative.startsWith(`${dir}/`));
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
  | "lock-unreadable";

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
 * Walk upward from a directory looking for a trust lock. A directory whose
 * ledger-head mirror exists in the user's state dir but whose lock file is
 * gone was tampered with: deleting the lock must not silently disable the
 * trust surface.
 *
 * The walk never leaves the repository that contains `startDir`: a `.git`
 * entry (directory in a normal checkout, file in a worktree or submodule)
 * marks the boundary. Without this stop, a nested checkout — a git worktree
 * under the main checkout's tree, a submodule, a vendored repo — would
 * silently inherit the trust context of the enclosing checkout, and its
 * lock, approvals, and guard decisions would be governed by a baseline it
 * does not own.
 */
export async function findTrustContext(
  startDir: string
): Promise<{ root: string; hasLock: boolean } | undefined> {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (await fileExists(trustLockPath(currentDir))) {
      return { root: currentDir, hasLock: true };
    }
    if ((await readLedgerHeadMirror(currentDir)) !== undefined) {
      return { root: currentDir, hasLock: false };
    }
    if (await fileExists(path.join(currentDir, ".git"))) {
      return undefined;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}
