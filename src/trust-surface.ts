import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { fileExists } from "./project-discovery";
import {
  checkLedgerMirror,
  readLedgerHeadMirror,
  verifyLedgerChain,
  writeLedgerHeadMirror
} from "./trust-ledger";
import type { CliReason } from "./types";

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

/**
 * Invisible / direction-override code points with NO legitimate purpose in
 * agent instruction or config files: the implicit and explicit bidi controls
 * Trojan Source abuses, zero-width characters that hide text, and the Unicode
 * tags block that can smuggle invisible instructions. Anything here is a hard
 * finding.
 *
 * Deliberately EXCLUDED to avoid false positives with no override path: soft
 * hyphen (U+00AD, common in prose pasted from Word/PDF) and the line/paragraph
 * separators (U+2028/2029, which JSON.stringify emits raw into config string
 * values). These are formatting characters, not injection vectors; hard-blocking
 * them would lock down a benign file that `lock`/`approve` then refuse to
 * baseline.
 */
const HIDDEN_UNICODE_RANGES: Array<[number, number]> = [
  [0x061c, 0x061c], // ARABIC LETTER MARK (implicit bidi)
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x202a, 0x202e], // explicit bidi embeddings/overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates (LRI/RLI/FSI/PDI)
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
  [0xe0000, 0xe007f] // Unicode tags block
];

function isHiddenCodePoint(codePoint: number): boolean {
  return HIDDEN_UNICODE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Detect hidden Unicode code points in a text. A byte-order mark at offset 0
 * is a legitimate encoding artifact and is not reported (it is still removed
 * by normalization so hashes stay stable).
 */
export function detectHiddenUnicode(text: string): string[] {
  const found = new Set<string>();
  let offset = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (isHiddenCodePoint(codePoint) && !(offset === 0 && codePoint === 0xfeff)) {
      found.add(formatCodePoint(codePoint));
    }
    offset += char.length;
  }
  return [...found].sort();
}

/** Remove all hidden Unicode code points (including a leading BOM). */
export function normalizeHiddenUnicode(text: string): string {
  let result = "";
  for (const char of text) {
    if (!isHiddenCodePoint(char.codePointAt(0) as number)) {
      result += char;
    }
  }
  return result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runner flags that consume the following token as their value. */
const RUNNER_VALUE_FLAGS = new Set(["-c", "--call", "--shell", "--cwd"]);

/**
 * The package spec a runner would resolve. An explicit `-p/--package <spec>`
 * (npm exec / npx) names the package directly and wins; otherwise it is the
 * first positional argument, skipping flags and the values of other
 * value-taking flags (so `--shell bash pkg` resolves to `pkg`, not `bash`).
 */
function runnerSpec(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-p" || arg === "--package") {
      return args[index + 1];
    }
    if (arg.startsWith("--package=")) {
      return arg.slice("--package=".length);
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && RUNNER_VALUE_FLAGS.has(arg)) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

/**
 * True when a runner package spec floats — the server code can change
 * upstream without any config drift (the MCP rug-pull). Only an EXACT semver
 * pin (1.2.3, optionally with prerelease/build) counts as pinned; tags
 * (`latest`, `next`), ranges (`^1`, `~1`, `1.x`, `*`, `>=1`), and a bare name
 * are all floating.
 */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isFloatingSpec(spec: string): boolean {
  const searchFrom = spec.startsWith("@") ? spec.indexOf("/") + 1 : 1;
  const atIndex = spec.indexOf("@", Math.max(searchFrom, 1));
  if (atIndex === -1) {
    return true;
  }
  return !EXACT_SEMVER.test(spec.slice(atIndex + 1).trim());
}

const RUNNER_BINARIES = new Set(["npx", "uvx", "bunx", "pnpx"]);

function isUnpinnedMcpServer(command: string | undefined, args: string[]): boolean {
  if (!command) {
    return false;
  }
  const binary = path.basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "");
  let spec: string | undefined;
  if (RUNNER_BINARIES.has(binary)) {
    spec = runnerSpec(args);
  } else if ((binary === "pnpm" || binary === "yarn") && args[0] === "dlx") {
    spec = runnerSpec(args.slice(1));
  } else {
    return false;
  }
  return spec === undefined || isFloatingSpec(spec);
}

/** Parse the `mcpServers` block of one config file into tracked entries. */
export function parseMcpServers(source: string, rawJson: string): TrustSurfaceMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return [];
  }

  const servers: TrustSurfaceMcpServer[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(value)) {
      continue;
    }
    const command = typeof value.command === "string" ? value.command : undefined;
    const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
    const url = typeof value.url === "string" ? value.url : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    const envKeys = isRecord(value.env) ? Object.keys(value.env).sort() : [];

    servers.push({
      name,
      source,
      commandHash: sha256(JSON.stringify({ command: command ?? null, args, url: url ?? null, type: type ?? null })),
      envKeys,
      unpinned: isUnpinnedMcpServer(command, args)
    });
  }
  return servers.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
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

function describeFileDrift(drift: TrustSurfaceFileDrift): string {
  switch (drift.change) {
    case "added":
      return `${drift.path} appeared (not in the trust baseline)`;
    case "removed":
      return `${drift.path} was removed`;
    case "modified":
      return `${drift.path} was modified`;
  }
}

function describeMcpDrift(drift: TrustSurfaceMcpDrift): string {
  const extras: string[] = [];
  if (drift.envKeysAdded.length > 0) {
    extras.push(`new env keys: ${drift.envKeysAdded.join(", ")}`);
  }
  if (drift.unpinned) {
    extras.push("unpinned version — the server code can change upstream without any config drift");
  }
  const suffix = extras.length > 0 ? ` (${extras.join("; ")})` : "";
  return `MCP server "${drift.name}" in ${drift.source} was ${drift.change}${suffix}`;
}

/**
 * Full trust-surface reconciliation for a directory: locate the lock, hash
 * the current state, verify the ledger chain and its out-of-workspace head
 * mirror, and classify every deviation into findings.
 */
export async function checkTrustSurface(startDir: string): Promise<TrustSurfaceStatus> {
  const context = await findTrustContext(startDir);
  if (!context) {
    return { active: false, findings: [], instructionWarnings: [] };
  }

  if (!context.hasLock) {
    return {
      active: true,
      root: context.root,
      findings: [
        {
          kind: "lock-removed",
          message:
            `The trust lock at ${trustLockPath(context.root)} is gone, but this project has a recorded ` +
            "trust baseline. Deleting the lock does not disable the trust surface."
        }
      ],
      instructionWarnings: []
    };
  }

  let lock: TrustSurfaceLock;
  try {
    lock = await readTrustLock(context.root);
  } catch (error) {
    return {
      active: true,
      root: context.root,
      findings: [
        {
          kind: "lock-unreadable",
          message: `The trust lock could not be read: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      instructionWarnings: []
    };
  }

  const snapshot = await snapshotTrustSurface(context.root);
  const drift = computeTrustSurfaceDrift(lock, snapshot);
  const findings: TrustFinding[] = [];
  const instructionWarnings: string[] = [];

  for (const fileDrift of drift.files) {
    const description = describeFileDrift(fileDrift);
    if (fileDrift.kind === "enforcement") {
      findings.push({ kind: "enforcement-drift", message: `Enforcement surface drift: ${description}.` });
    } else if (fileDrift.kind === "tool") {
      findings.push({ kind: "tool-drift", message: `Tool surface drift: ${description}.` });
    } else if (lock.mode === "strict") {
      findings.push({ kind: "instruction-drift", message: `Instruction surface drift: ${description}.` });
    } else {
      instructionWarnings.push(`Instruction surface drift: ${description}.`);
    }
  }

  for (const mcpDrift of drift.mcpServers) {
    findings.push({ kind: "tool-drift", message: `Tool surface drift: ${describeMcpDrift(mcpDrift)}.` });
  }

  for (const unicodeFinding of drift.newHiddenUnicode) {
    findings.push({
      kind: "hidden-unicode",
      message:
        `Hidden Unicode characters appeared in ${unicodeFinding.path}: ${unicodeFinding.codes.join(", ")}. ` +
        "Invisible characters in agent instruction or config files are a known injection vector."
    });
  }

  // Unpinned MCP servers are a standing rug-pull risk (the server code can
  // change upstream without any config drift), so surface them on every
  // reconciliation, not only at lock time. Strict mode blocks; warn mode
  // keeps it visible as a warning.
  for (const server of snapshot.mcpServers) {
    if (!server.unpinned) {
      continue;
    }
    const message =
      `Unpinned MCP server "${server.name}" in ${server.source}: no fixed version, so the server code ` +
      "can change upstream without any config change. Pin an exact version.";
    if (lock.mode === "strict") {
      findings.push({ kind: "unpinned-mcp", message });
    } else {
      instructionWarnings.push(message);
    }
  }

  const chain = await verifyLedgerChain(context.root);
  if (chain.status !== "ok") {
    findings.push({
      kind: "ledger-broken",
      message: `The trust ledger at ${trustLedgerPath(context.root)} is ${chain.status === "missing" ? "missing" : "broken"}.`
    });
  } else {
    // The lock must reference a baseline entry in the chain, and no later
    // baseline entry (lock-created / approved) may exist after it.
    const entries = chain.entries ?? [];
    const lockIndex = entries.findIndex((entry) => entry.hash === lock.ledgerHead);
    const staleBaseline =
      lockIndex === -1 ||
      entries.slice(lockIndex + 1).some((entry) => entry.event === "lock-created" || entry.event === "approved");
    if (staleBaseline) {
      findings.push({
        kind: "ledger-mismatch",
        message: "The trust lock does not reference the current baseline entry of the trust ledger."
      });
    } else {
      // Bind the lock's CONTENT to the ledger: the baseline entry recorded the
      // hash of the exact files/mcpServers list at approval time. Editing the
      // committed lock (e.g. dropping a protected file so its deletion is not
      // seen as drift) changes this hash but cannot change the hash-chained
      // ledger entry without breaking the chain.
      const baselineEntry = entries[lockIndex];
      const recordedHash = baselineEntry.detail.slice(baselineEntry.detail.indexOf(":") + 1);
      if (recordedHash !== computeBaselineHash(lock)) {
        findings.push({
          kind: "lock-forged",
          message:
            "The trust lock's baseline does not match the hash recorded in the ledger. " +
            "The lock file was edited after it was approved."
        });
      }

      const mirror = await checkLedgerMirror(context.root, chain.head as string);
      if (mirror === "mismatch") {
        findings.push({
          kind: "mirror-mismatch",
          message:
            "The trust ledger does not match the recorded head outside the workspace. " +
            "The in-repo ledger and lock may have been rewritten."
        });
      } else if (mirror === "missing") {
        // A fresh clone of a committed lock legitimately has no local mirror,
        // and a deleted mirror looks identical — the two are indistinguishable
        // locally, and the mirror is explicitly NOT the anchor (the committed
        // lock + CI re-verify is). So self-heal: establish the mirror from the
        // verified head rather than nagging (a warning here broke `trust lock`
        // and `approve` on every fresh clone, since they treat any warning as
        // drift) or blocking (which would break clones outright). Best-effort
        // and out-of-tree: a read-only state dir just leaves it missing for a
        // later run, never turning a benign clone into a failure.
        await writeLedgerHeadMirror(context.root, chain.head as string).catch(() => {
          /* state dir not writable — retry on a later run */
        });
      }
    }
  }

  return {
    active: true,
    root: context.root,
    mode: lock.mode,
    lock,
    snapshot,
    drift,
    findings,
    instructionWarnings
  };
}

/**
 * Split findings by required guard response: lockdown findings deny every
 * agent command; tool findings deny installs and runners until approval.
 */
export function partitionTrustFindings(findings: TrustFinding[]): {
  lockdown: TrustFinding[];
  tool: TrustFinding[];
} {
  const lockdown: TrustFinding[] = [];
  const tool: TrustFinding[] = [];
  for (const finding of findings) {
    if (finding.kind === "tool-drift" || finding.kind === "unpinned-mcp") {
      tool.push(finding);
    } else {
      lockdown.push(finding);
    }
  }
  return { lockdown, tool };
}

/**
 * Trust-surface precheck for the install and check flows: every CLI
 * invocation reconciles, so a deleted guard hook (which silences the guard
 * itself) is still caught the next time SafeInstall runs. Returns block
 * reasons when the surface has drifted, plus non-blocking warnings (warn-mode
 * instruction drift, unpinned MCP servers) so they are surfaced rather than
 * silently dropped. Empty when clean or not locked.
 */
export async function trustSurfacePrecheck(
  cwd: string
): Promise<{ reasons: CliReason[]; warnings: string[] }> {
  let status: TrustSurfaceStatus;
  try {
    status = await checkTrustSurface(cwd);
  } catch (error) {
    // A read error during reconciliation (e.g. a file rotating under us) must
    // fail closed as a clean policy block, not crash the whole command with an
    // unhandled error. Mirrors the guard, which denies rather than throwing.
    return {
      reasons: [
        {
          code: "trust-verification-failed",
          message: `SafeInstall could not verify the Agent Trust Surface (${error instanceof Error ? error.message : String(error)}).`,
          suggestion: "Retry; if it persists, run `safeinstall trust status` to inspect the trust surface."
        }
      ],
      warnings: []
    };
  }

  if (!status.active) {
    return { reasons: [], warnings: [] };
  }
  return {
    reasons: status.findings.map((finding) => ({
      code: `trust-${finding.kind}`,
      message: finding.message,
      suggestion:
        "Review the drift with `safeinstall trust status`. If the change is intentional, approve it with `safeinstall trust approve` in your terminal."
    })),
    warnings: status.instructionWarnings
  };
}
