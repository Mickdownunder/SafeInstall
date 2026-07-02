import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
 * A lock older than this is presumed abandoned by a crashed process. Ledger
 * operations touch only tiny files and finish in milliseconds, so a lock that
 * has survived this long is not a live holder.
 */
const LEDGER_LOCK_STALE_MS = 10_000;
/** Overall backstop so a wedged lock errors instead of spinning forever. */
const LEDGER_LOCK_WAIT_MS = 15_000;

/**
 * Serialize ledger writes with an exclusive, OWNED lock file. Node has no
 * portable flock, but `open(..., "wx")` (O_CREAT|O_EXCL) is an atomic
 * create-or-fail on every platform. Two concurrent runs (parallel agent
 * commands, a CI matrix) would otherwise read the same head and append entries
 * that do not chain, corrupting the ledger and causing a false lockdown.
 *
 * Two properties make this race-safe where a naive lock is not:
 * - The lock file carries a per-acquisition token, and release removes the lock
 *   ONLY if it still holds our token — so a holder never deletes a lock that a
 *   different holder has since acquired (an unconditional rm-by-path is exactly
 *   what let two writers interleave before).
 * - A stale lock is stolen ATOMICALLY via rename(): of two racing stealers only
 *   one moves the observed file; the other gets ENOENT and retries a normal
 *   create. rm-then-open is never used, so the exclusive create is never raced.
 */
async function withLedgerLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockFile = `${ledgerPath(root)}.lock`;
  await mkdir(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;

  await acquireLedgerLock(lockFile, token);
  try {
    return await action();
  } finally {
    try {
      if ((await readFile(lockFile, "utf8")) === token) {
        await rm(lockFile, { force: true });
      }
    } catch {
      // Already gone, or now owned by someone else — never steal it back.
    }
  }
}

async function acquireLedgerLock(lockFile: string, token: string): Promise<void> {
  const waitUntil = Date.now() + LEDGER_LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    let ageMs: number;
    try {
      ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
    } catch {
      continue; // The lock vanished under us — retry the exclusive create.
    }

    if (ageMs > LEDGER_LOCK_STALE_MS) {
      // Steal a presumed-crashed lock atomically: rename moves the exact file
      // we observed; a second stealer racing us gets ENOENT and simply retries.
      try {
        const stolen = `${lockFile}.stale-${token}`;
        await rename(lockFile, stolen);
        await rm(stolen, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      continue;
    }

    if (Date.now() > waitUntil) {
      throw new Error(
        `Timed out waiting for the trust ledger lock at ${lockFile}. ` +
          "If no other safeinstall process is running, delete that file and retry."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)));
  }
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
 * Compare the in-repo chain head against the out-of-workspace mirror.
 * - "ok": mirror matches.
 * - "mismatch": mirror disagrees — the in-repo ledger was rewritten locally.
 * - "missing": no local mirror. Ambiguous by nature (a fresh clone of a
 *   committed lock legitimately has none, but so does a deleted mirror), so
 *   the caller surfaces it as a WARNING, not a hard block. It is never proof
 *   of tampering on its own — the committed lock + CI re-verify is the anchor.
 */
export async function checkLedgerMirror(root: string, head: string): Promise<"ok" | "mismatch" | "missing"> {
  const mirrored = await readLedgerHeadMirror(root);
  if (mirrored === undefined) {
    return "missing";
  }
  return mirrored === head ? "ok" : "mismatch";
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
