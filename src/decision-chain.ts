import { encodeDecisionRecord, type DecisionRecord } from "./decision-record";

/**
 * Fork resolution for decision-record chains — the one rule both readers
 * apply: the local store (`readDecisionChain`) and committed-state
 * verification (`verifyDecisions`).
 *
 * The file lock serializes writers within one worktree, but not across git
 * branches: two branches that each append one record at the same position
 * produce, after their merge, sibling records with the same seq and the same
 * prev. Two shapes are distinguished:
 *
 * - Siblings that are byte-identical except for `createdAt` record the same
 *   decision about the same state transition. Exactly one is the chain
 *   record — the one a later record already continues, else the earliest by
 *   `createdAt` (ties: label order) — and the others are reported as
 *   duplicates, never silently dropped.
 * - Siblings that differ in anything else record different decisions, and
 *   siblings of which more than one was continued are two histories. Neither
 *   is resolved automatically: choosing would discard a decision. The error
 *   names every sibling and the repair path.
 *
 * Seq continuity, per-file integrity and prev linkage of single records stay
 * with the callers; this only collapses multi-record positions.
 */

export interface ChainCandidate {
  /** File name or repository path, as the caller reports records. */
  label: string;
  seq: number;
  digest: string;
  record: DecisionRecord;
}

export interface ResolvedDuplicate<T extends ChainCandidate> {
  seq: number;
  kept: T;
  duplicates: T[];
}

export type ChainResolution<T extends ChainCandidate> =
  | { chain: T[]; duplicates: ResolvedDuplicate<T>[]; failure?: undefined }
  | { failure: { code: "decisions-chain-fork" | "decisions-chain-broken"; message: string } };

/** The record's bytes with its timestamp blanked: equal means same decision. */
function contentWithoutTimestamp(record: DecisionRecord): Buffer {
  return encodeDecisionRecord({ ...record, createdAt: "" });
}

function byCreatedAtThenLabel(a: ChainCandidate, b: ChainCandidate): number {
  const delta = Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt);
  if (delta !== 0) {
    return delta;
  }
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * Walk `candidates` (any order) from genesis and collapse sibling positions.
 * `location` names the record directory in repair hints.
 */
export function resolveChainForks<T extends ChainCandidate>(
  lockfilePath: string,
  location: string,
  genesisDigest: string,
  candidates: T[]
): ChainResolution<T> {
  const bySeq = new Map<number, T[]>();
  for (const candidate of candidates) {
    const group = bySeq.get(candidate.seq) ?? [];
    group.push(candidate);
    bySeq.set(candidate.seq, group);
  }
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);

  const chain: T[] = [];
  const duplicates: ResolvedDuplicate<T>[] = [];
  let prevDigest = genesisDigest;
  for (const seq of seqs) {
    const group = bySeq.get(seq) ?? [];
    const [first] = group;
    if (first === undefined) {
      continue;
    }
    if (group.length === 1) {
      chain.push(first);
      prevDigest = first.digest;
      continue;
    }

    const labels = group.map((entry) => entry.label).sort();
    const forkHeader =
      `Decision chain for ${lockfilePath} is forked at seq ${seq}: ${group.length} records ` +
      `(${labels.join(", ")}) occupy one position — parallel branches each appended a record and were merged.`;
    const repair =
      "SafeInstall will not choose between different decisions. To repair: keep the record the merged " +
      `history continues from, move the other(s) unchanged into a subdirectory of ${location} (records in ` +
      "subdirectories are kept as evidence and are not read as chain), add a note why, and commit that as a reviewed change.";

    const foreign = group.find((entry) => entry.record.chain.prev !== prevDigest);
    if (foreign) {
      return {
        failure: {
          code: "decisions-chain-broken",
          message:
            `${forkHeader} Decision record ${foreign.label} does not chain: prev ${foreign.record.chain.prev} != ${prevDigest}.`
        }
      };
    }

    const reference = contentWithoutTimestamp(first.record);
    if (!group.every((entry) => contentWithoutTimestamp(entry.record).equals(reference))) {
      return {
        failure: {
          code: "decisions-chain-fork",
          message: `${forkHeader} They record different decisions, not only different createdAt times. ${repair}`
        }
      };
    }

    const next = bySeq.get(seq + 1) ?? [];
    const continued = group.filter((entry) => next.some((later) => later.record.chain.prev === entry.digest));
    if (continued.length > 1) {
      return {
        failure: {
          code: "decisions-chain-fork",
          message:
            `${forkHeader} More than one of them was continued by a later record ` +
            `(${continued.map((entry) => entry.label).sort().join(", ")}), so the chain holds two histories. ${repair}`
        }
      };
    }

    const kept = continued[0] ?? [...group].sort(byCreatedAtThenLabel)[0] ?? first;
    chain.push(kept);
    duplicates.push({ seq, kept, duplicates: group.filter((entry) => entry !== kept) });
    prevDigest = kept.digest;
  }
  return { chain, duplicates };
}

/** One line per resolved position, for callers that report duplicates. */
export function describeResolvedDuplicate(lockfilePath: string, resolved: ResolvedDuplicate<ChainCandidate>): string {
  return (
    `${lockfilePath}: seq ${resolved.seq} holds ${resolved.duplicates.length} duplicate sibling record(s) from ` +
    `merged parallel branches (${resolved.duplicates.map((entry) => entry.label).sort().join(", ")}), identical to ` +
    `${resolved.kept.label} except createdAt; ${resolved.kept.label} is the chain record. Moving the duplicates ` +
    "into a subdirectory records this resolution in the repository."
  );
}
