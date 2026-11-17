import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DECISION_GENESIS_DIGEST,
  DECISIONS_RELATIVE_DIR,
  decisionRecordDigest,
  decisionRecordFileName,
  encodeDecisionRecord,
  lockfilePathSlug,
  parseDecisionRecord,
  type DecisionRecord
} from "./decision-record";
import { resolveChainForks } from "./decision-chain";
import { withFileLock } from "./file-lock";

/**
 * On-disk store for decision records: one directory per lockfile path, one
 * canonical-bytes file per record, appended under the shared owned-token file
 * lock so parallel agent commands cannot fork a chain (§9, D6).
 */

const RECORD_FILE_PATTERN = /^(\d{6})-([0-9a-f]{12})\.json$/;

export interface StoredDecisionRecord {
  fileName: string;
  seq: number;
  digest: string;
  record: DecisionRecord;
  /** Sibling files at this seq, identical except createdAt, that this record
   *  was chosen over (a fork from merged branches, see decision-chain). */
  duplicateSiblings?: string[];
}

export function decisionsDir(root: string): string {
  return path.join(root, ...DECISIONS_RELATIVE_DIR.split("/"));
}

export function decisionsDirForLockfile(root: string, lockfilePath: string): string {
  return path.join(decisionsDir(root), lockfilePathSlug(lockfilePath));
}

/**
 * Read and fully verify one lockfile path's local chain: file naming, byte
 * canonicality, schema, digest-vs-filename, seq continuity, and digest
 * linkage. Sibling records from merged branches resolve by the one rule in
 * decision-chain (identical except createdAt: one chain record, the rest
 * reported; anything else: an error naming the files). Any inconsistency
 * throws — a broken local chain must surface, not be silently skipped.
 */
export async function readDecisionChain(
  root: string,
  lockfilePath: string
): Promise<StoredDecisionRecord[]> {
  const dir = decisionsDirForLockfile(root, lockfilePath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries = names
    .map((name) => {
      const match = RECORD_FILE_PATTERN.exec(name);
      return match ? { name, seq: Number(match[1]), digestPrefix: match[2] } : undefined;
    })
    .filter((entry): entry is { name: string; seq: number; digestPrefix: string } => entry !== undefined)
    .sort((a, b) => a.seq - b.seq || (a.name < b.name ? -1 : 1));

  // Seq continuity by file name first: several files may share a seq (a fork
  // from merged branches, resolved below), but no seq may be skipped.
  let expectedSeq = 1;
  for (const entry of entries) {
    if (expectedSeq > 1 && entry.seq === expectedSeq - 1) {
      continue;
    }
    if (entry.seq !== expectedSeq) {
      throw new Error(
        `Decision chain for ${lockfilePath} is broken: expected seq ${expectedSeq}, found ${entry.name} — ` +
          "a record was removed or renumbered."
      );
    }
    expectedSeq += 1;
  }

  const verified: StoredDecisionRecord[] = [];
  for (const entry of entries) {
    const bytes = await readFile(path.join(dir, entry.name));
    const digest = decisionRecordDigest(bytes);
    if (!digest.startsWith(entry.digestPrefix)) {
      throw new Error(
        `Decision record ${entry.name} for ${lockfilePath} does not match its digest — the file was modified.`
      );
    }
    const record = parseDecisionRecord(bytes);
    if (record.lockfile.path !== lockfilePath) {
      throw new Error(
        `Decision record ${entry.name} claims lockfile ${record.lockfile.path} but is stored under ${lockfilePath}.`
      );
    }
    if (record.chain.seq !== entry.seq) {
      throw new Error(`Decision record ${entry.name} carries chain.seq ${record.chain.seq}, expected ${entry.seq}.`);
    }
    verified.push({ fileName: entry.name, seq: entry.seq, digest, record });
  }

  const resolution = resolveChainForks(
    lockfilePath,
    dir,
    DECISION_GENESIS_DIGEST,
    verified.map((entry) => ({ ...entry, label: entry.fileName }))
  );
  if (resolution.failure) {
    throw new Error(resolution.failure.message);
  }
  const duplicatesByKept = new Map(
    resolution.duplicates.map((resolved) => [resolved.kept.fileName, resolved.duplicates.map((entry) => entry.fileName)])
  );

  const chain: StoredDecisionRecord[] = [];
  let prevDigest = DECISION_GENESIS_DIGEST;
  for (const { label: _label, ...entry } of resolution.chain) {
    if (entry.record.chain.prev !== prevDigest) {
      throw new Error(
        `Decision record ${entry.fileName} does not chain: prev ${entry.record.chain.prev} != ${prevDigest}.`
      );
    }
    const duplicateSiblings = duplicatesByKept.get(entry.fileName);
    chain.push(duplicateSiblings ? { ...entry, duplicateSiblings } : entry);
    prevDigest = entry.digest;
  }
  return chain;
}

export type DecisionRecordDraft = Omit<DecisionRecord, "chain">;

/**
 * Append a record to its lockfile path's chain. The chain position (seq,
 * prev) is assigned under the lock, after re-reading the head, so two
 * concurrent writers serialize instead of forking the chain.
 */
export async function appendDecisionRecord(
  root: string,
  draft: DecisionRecordDraft
): Promise<StoredDecisionRecord> {
  const lockFile = path.join(decisionsDir(root), "decisions.lock");
  return withFileLock(lockFile, { label: "decision store" }, async () => {
    const existing = await readDecisionChain(root, draft.lockfile.path);
    const head = existing.at(-1);
    const record: DecisionRecord = {
      ...draft,
      chain: {
        seq: (head?.seq ?? 0) + 1,
        prev: head?.digest ?? DECISION_GENESIS_DIGEST,
        archive: null
      }
    };

    const bytes = encodeDecisionRecord(record);
    const digest = decisionRecordDigest(bytes);
    const fileName = decisionRecordFileName(record.chain.seq, digest);
    const dir = decisionsDirForLockfile(root, draft.lockfile.path);
    await mkdir(dir, { recursive: true });

    // Atomic publish: a crash mid-write must never leave a half-record that
    // breaks every later chain read.
    const tmpPath = path.join(dir, `.tmp-${randomUUID()}`);
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, path.join(dir, fileName));

    return { fileName, seq: record.chain.seq, digest, record };
  });
}
