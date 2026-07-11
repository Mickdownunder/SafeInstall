import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFileLock } from "./file-lock";

/**
 * Hash-chained trust ledger. Every baseline decision (created, approved) is
 * appended to `.safeinstall/ledger.jsonl` with a hash over the entry and the
 * previous entry's hash, so the in-repo history cannot be edited without
 * breaking the chain.
 *
 * Where the real guarantee lives — read this before trusting the mirror:
 * The durable, adversary-resistant anchor is the COMMITTED lock re-verified
 * on a different machine (CI or a reviewer). A scheme-aware agent running in
 * the user's own account can rewrite the in-repo ledger AND the lock into an
 * internally consistent state and delete the local head mirror — nothing in
 * user space stops that, because it can read/delete anything the user can.
 *
 * The out-of-workspace head mirror (`~/.safeinstall/ledger-heads/`) therefore
 * has a MODEST job: catch naive or accidental history rewrites, and make a
 * vanished local head VISIBLE (a warning) rather than silent. It is not a
 * cryptographic anchor and does not claim to defeat a deliberate,
 * scheme-aware in-account rewrite. Tamper-evident against mistakes and
 * non-targeted tampering; the committed-lock + CI path is what holds against
 * a real adversary.
 */

export type TrustLedgerEvent = "lock-created" | "approved";

export interface TrustLedgerEntry {
  ts: string;
  event: TrustLedgerEvent;
  detail: string;
  prevHash: string;
  hash: string;
}

const LEDGER_RELATIVE_PATH = path.join(".safeinstall", "ledger.jsonl");
export const LEDGER_GENESIS_HASH = "0".repeat(64);

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function entryHash(entry: Omit<TrustLedgerEntry, "hash">): string {
  return sha256(JSON.stringify({ ts: entry.ts, event: entry.event, detail: entry.detail, prevHash: entry.prevHash }));
}

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_RELATIVE_PATH);
}

/**
 * Serialize ledger writes with the shared exclusive-owned-lock primitive
 * (src/file-lock.ts — extracted verbatim from here so the decision-record
 * store reuses the reviewed concurrency behavior instead of reimplementing
 * it). Two concurrent runs (parallel agent commands, a CI matrix) would
 * otherwise read the same head and append entries that do not chain,
 * corrupting the ledger and causing a false lockdown.
 */
async function withLedgerLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(`${ledgerPath(root)}.lock`, { label: "trust ledger" }, action);
}

/** State dir for ledger-head mirrors — outside any workspace. */
function stateDir(): string {
  if (process.env.SAFEINSTALL_STATE_DIR) {
    return process.env.SAFEINSTALL_STATE_DIR;
  }
  return path.join(os.homedir(), ".safeinstall");
}

function mirrorPath(root: string): string {
  return path.join(stateDir(), "ledger-heads", `${sha256(path.resolve(root))}.json`);
}

interface MirrorRecord {
  projectRoot: string;
  head: string;
  updatedAt: string;
}

async function readLedgerEntries(root: string): Promise<TrustLedgerEntry[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(root), "utf8");
  } catch {
    return undefined;
  }

  const entries: TrustLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    entries.push(JSON.parse(line) as TrustLedgerEntry);
  }
  return entries;
}

export interface LedgerChainResult {
  status: "ok" | "missing" | "broken";
  head?: string;
  entries?: TrustLedgerEntry[];
}

/** Verify the chain end to end: every hash and every prevHash link. */
export async function verifyLedgerChain(root: string): Promise<LedgerChainResult> {
  let entries: TrustLedgerEntry[] | undefined;
  try {
    entries = await readLedgerEntries(root);
  } catch {
    return { status: "broken" };
  }
  if (entries === undefined || entries.length === 0) {
    return { status: "missing" };
  }

  let previousHash = LEDGER_GENESIS_HASH;
  for (const entry of entries) {
    if (entry.prevHash !== previousHash || entryHash(entry) !== entry.hash) {
      return { status: "broken" };
    }
    previousHash = entry.hash;
  }

  return { status: "ok", head: previousHash, entries };
}

/**
 * Append an entry and update the out-of-workspace head mirror.
 * Returns the new chain head.
 */
export async function appendLedgerEntry(
  root: string,
  event: TrustLedgerEvent,
  detail: string
): Promise<string> {
  return withLedgerLock(root, async () => {
    const chain = await verifyLedgerChain(root);
    const prevHash = chain.status === "ok" ? (chain.head as string) : LEDGER_GENESIS_HASH;

    const withoutHash = { ts: new Date().toISOString(), event, detail, prevHash };
    const entry: TrustLedgerEntry = { ...withoutHash, hash: entryHash(withoutHash) };

    const filePath = ledgerPath(root);
    await writeFile(filePath, `${await currentLedgerText(root)}${JSON.stringify(entry)}\n`, "utf8");
    await writeLedgerHeadMirror(root, entry.hash);
    return entry.hash;
  });
}

/** Existing ledger content, or empty string. Read inside the lock. */
async function currentLedgerText(root: string): Promise<string> {
  try {
    return await readFile(ledgerPath(root), "utf8");
  } catch {
    return "";
  }
}

export async function writeLedgerHeadMirror(root: string, head: string): Promise<void> {
  const filePath = mirrorPath(root);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const record: MirrorRecord = {
    projectRoot: path.resolve(root),
    head,
    updatedAt: new Date().toISOString()
  };
  await writeFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readLedgerHeadMirror(root: string): Promise<string | undefined> {
  try {
    const raw = await readFile(mirrorPath(root), "utf8");
    const record = JSON.parse(raw) as Partial<MirrorRecord>;
    return typeof record.head === "string" ? record.head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reconcile the in-repo chain head against the out-of-workspace mirror.
 * - "ok": mirror matches the head.
 * - "advanced": the verified chain CONTAINS the mirrored head as an ancestor —
 *   the ledger moved forward legitimately (a pull/rebase bringing reviewed,
 *   CI-verified history is the everyday case), so the mirror is fast-forwarded
 *   to the new head instead of raising a false alarm. The hash chain makes
 *   this safe: an old entry's hash only stays valid if the entire prefix is
 *   byte-identical, so a rewrite cannot contain the mirrored head, and a
 *   rollback (truncated chain) no longer contains the newer mirrored head —
 *   both still land in "mismatch".
 * - "mismatch": the mirrored head is NOT in the chain — rewrite or rollback.
 * - "missing": no local mirror. Ambiguous by nature (a fresh clone of a
 *   committed lock legitimately has none, but so does a deleted mirror), so
 *   the caller surfaces it as a WARNING, not a hard block. It is never proof
 *   of tampering on its own — the committed lock + CI re-verify is the anchor.
 */
export async function checkLedgerMirror(
  root: string,
  head: string,
  entries?: TrustLedgerEntry[]
): Promise<"ok" | "advanced" | "mismatch" | "missing"> {
  const mirrored = await readLedgerHeadMirror(root);
  if (mirrored === undefined) {
    return "missing";
  }
  if (mirrored === head) {
    return "ok";
  }
  if (entries?.some((entry) => entry.hash === mirrored)) {
    // Best-effort fast-forward, same posture as the missing-mirror self-heal:
    // a read-only state dir just leaves it stale for a later run.
    await writeLedgerHeadMirror(root, head).catch(() => {
      /* retry on a later run */
    });
    return "advanced";
  }
  return "mismatch";
}

/** Remove the mirror record (used when a project intentionally unlocks). */
export async function removeLedgerHeadMirror(root: string): Promise<void> {
  try {
    await unlink(mirrorPath(root));
  } catch {
    // Already gone.
  }
}

/**
 * Start a fresh chain with a single entry, replacing whatever is on disk.
 * Used by human-approved re-baselining when the existing chain is broken —
 * the break was already surfaced; after approval the history restarts.
 */
export async function resetLedger(root: string, event: TrustLedgerEvent, detail: string): Promise<string> {
  return withLedgerLock(root, () => resetLedgerLocked(root, event, detail));
}

async function resetLedgerLocked(root: string, event: TrustLedgerEvent, detail: string): Promise<string> {
  const withoutHash = {
    ts: new Date().toISOString(),
    event,
    detail,
    prevHash: LEDGER_GENESIS_HASH
  };
  const entry: TrustLedgerEntry = { ...withoutHash, hash: entryHash(withoutHash) };

  const filePath = ledgerPath(root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  await writeLedgerHeadMirror(root, entry.hash);
  return entry.hash;
}
