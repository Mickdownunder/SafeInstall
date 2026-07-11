import { createHash } from "node:crypto";
import path from "node:path";

import { DEFAULT_REGISTRY_URL } from "./config";
import {
  DECISION_GENESIS_DIGEST,
  DECISIONS_RELATIVE_DIR,
  decisionRecordDigest,
  lockfilePathSlug,
  parseDecisionRecord,
  type DecisionBinding,
  type DecisionRecord
} from "./decision-record";
import {
  blobOidAtRef,
  changedPaths,
  pathsAtRef,
  readBlob,
  resolveCommit,
  resolveGitRepo,
  type GitRepoContext
} from "./git-blob";

/**
 * Committed-state verification of decision-record chains (RFC-001 §7, D5) —
 * the offline half of L1. Everything here reads the repository's committed
 * trees only: the working tree, the local store, and every recorded verdict
 * are ignored. What is enforced:
 *
 * - every record blob at HEAD is canonical, schema-valid, named by its
 *   digest, and stored under its lockfile path's slug directory;
 * - per lockfile path, records form one linked chain (seq continuity, digest
 *   linkage, before/after continuity);
 * - PR-level completeness: the set of lockfile paths changed between base
 *   and head equals the set covered by chains that span exactly base -> head
 *   (M4's unrecorded-second-lockfile is a deterministic failure);
 * - binding honesty at the anchored ends: the base and head lockfile blobs'
 *   sha256 match the recorded bindings (intermediate, never-committed states
 *   are attested by the chain linkage between the two anchored ends);
 * - the effective registry is the verifier's trust root (D3): a non-default
 *   registryUrl in the candidate's config is a hard finding unless
 *   explicitly allowlisted on the verifier side.
 *
 * The chain is audit bookkeeping (§7, M2): fresh policy re-evaluation is
 * `decisions authorize`, not this.
 */

export const KNOWN_LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  // Detection-only (D5): bun cannot produce records in v1, so a changed bun
  // lockfile deterministically fails completeness instead of slipping through.
  "bun.lock",
  "bun.lockb"
]);

export interface DecisionVerifyOptions {
  baseRef: string;
  headRef?: string;
  /** Registry URLs accepted besides the default (verifier-side input, D3). */
  allowedRegistryUrls?: string[];
}

export interface DecisionVerifyFinding {
  code: string;
  message: string;
}

export interface DecisionVerifyResult {
  ok: boolean;
  findings: DecisionVerifyFinding[];
  infos: string[];
  /** Lockfile paths whose chains were verified against the base..head delta. */
  verifiedPaths: string[];
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isKnownLockfile(repoPath: string): boolean {
  return KNOWN_LOCKFILE_NAMES.has(path.posix.basename(repoPath));
}

interface StoredAtHead {
  filePath: string;
  slugDir: string;
  seq: number;
  digest: string;
  record: DecisionRecord;
}

const RECORD_FILE_PATTERN = /^(\d{6})-([0-9a-f]{12})\.json$/;

async function readRecordsAtHead(
  repo: GitRepoContext,
  headRef: string,
  findings: DecisionVerifyFinding[]
): Promise<Map<string, StoredAtHead[]>> {
  const byLockfile = new Map<string, StoredAtHead[]>();
  const filePaths = await pathsAtRef(repo, headRef, DECISIONS_RELATIVE_DIR);

  for (const filePath of filePaths) {
    const relative = filePath.slice(DECISIONS_RELATIVE_DIR.length + 1);
    const segments = relative.split("/");
    if (segments.length !== 2) {
      continue; // decisions.lock or unrelated layout — not a record file.
    }
    const [slugDir, fileName] = segments;
    const match = RECORD_FILE_PATTERN.exec(fileName);
    if (!match) {
      continue;
    }

    const oid = await blobOidAtRef(repo, headRef, filePath);
    if (!oid) {
      findings.push({ code: "decisions-unreadable", message: `Could not read ${filePath} at head.` });
      continue;
    }
    const bytes = await readBlob(repo, oid);
    const digest = decisionRecordDigest(bytes);

    let record: DecisionRecord;
    try {
      record = parseDecisionRecord(bytes);
    } catch (error) {
      findings.push({
        code: "decisions-invalid-record",
        message: `${filePath}: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    if (!digest.startsWith(match[2]) || Number(match[1]) !== record.chain.seq) {
      findings.push({
        code: "decisions-name-mismatch",
        message: `${filePath} does not match its content (digest/seq) — the record was renamed or edited.`
      });
      continue;
    }
    if (lockfilePathSlug(record.lockfile.path) !== slugDir) {
      findings.push({
        code: "decisions-misfiled",
        message: `${filePath} claims lockfile ${record.lockfile.path}, which does not map to directory ${slugDir}.`
      });
      continue;
    }

    const group = byLockfile.get(record.lockfile.path) ?? [];
    group.push({ filePath, slugDir, seq: record.chain.seq, digest, record });
    byLockfile.set(record.lockfile.path, group);
  }

  for (const group of byLockfile.values()) {
    group.sort((a, b) => a.seq - b.seq);
  }
  return byLockfile;
}

function verifyChainLinkage(
  lockfilePath: string,
  chain: StoredAtHead[],
  findings: DecisionVerifyFinding[]
): boolean {
  let prevDigest = DECISION_GENESIS_DIGEST;
  let prevAfter: DecisionBinding = null;
  for (const [index, entry] of chain.entries()) {
    if (entry.seq !== index + 1) {
      findings.push({
        code: "decisions-chain-gap",
        message: `Chain for ${lockfilePath} jumps to seq ${entry.seq} at position ${index + 1} — records were removed or renumbered.`
      });
      return false;
    }
    if (entry.record.chain.prev !== prevDigest) {
      findings.push({
        code: "decisions-chain-broken",
        message: `Chain for ${lockfilePath} breaks at seq ${entry.seq}: prev digest does not match the preceding record.`
      });
      return false;
    }
    if (index > 0) {
      const before = entry.record.lockfile.before;
      const matches =
        (before === null && prevAfter === null) ||
        (before !== null && prevAfter !== null && before.blobOid === prevAfter.blobOid);
      if (!matches) {
        findings.push({
          code: "decisions-state-discontinuity",
          message: `Chain for ${lockfilePath} at seq ${entry.seq}: 'before' state does not equal the previous record's 'after' state.`
        });
        return false;
      }
    }
    prevDigest = entry.digest;
    prevAfter = entry.record.lockfile.after;
  }
  return true;
}

async function verifyAnchoredBinding(
  repo: GitRepoContext,
  ref: string,
  lockfilePath: string,
  binding: DecisionBinding,
  label: string,
  findings: DecisionVerifyFinding[]
): Promise<boolean> {
  const oid = await blobOidAtRef(repo, ref, lockfilePath);
  if (binding === null) {
    if (oid !== undefined) {
      findings.push({
        code: "decisions-binding-mismatch",
        message: `${label} for ${lockfilePath}: record says the file was absent, but ${ref} has it.`
      });
      return false;
    }
    return true;
  }
  if (oid === undefined) {
    findings.push({
      code: "decisions-binding-mismatch",
      message: `${label} for ${lockfilePath}: record binds a blob, but the file is absent at ${ref}.`
    });
    return false;
  }
  if (oid !== binding.blobOid) {
    findings.push({
      code: "decisions-binding-mismatch",
      message: `${label} for ${lockfilePath}: recorded blob ${binding.blobOid} != committed blob ${oid}.`
    });
    return false;
  }
  // §5.2: check BOTH the tree lookup and an independent sha256 recomputation.
  const content = await readBlob(repo, oid);
  if (sha256Hex(content) !== binding.sha256) {
    findings.push({
      code: "decisions-sha256-mismatch",
      message: `${label} for ${lockfilePath}: blob ${oid} does not match the recorded sha256.`
    });
    return false;
  }
  return true;
}

async function checkRegistryTrustRoot(
  repo: GitRepoContext,
  headRef: string,
  allowedRegistryUrls: string[],
  findings: DecisionVerifyFinding[]
): Promise<void> {
  const configOid = await blobOidAtRef(repo, headRef, "safeinstall.config.json");
  if (!configOid) {
    return; // Defaults in effect — the default registry is the trust root.
  }
  let registryUrl: unknown;
  try {
    const parsed = JSON.parse((await readBlob(repo, configOid)).toString("utf8")) as Record<string, unknown>;
    registryUrl = parsed.registryUrl;
  } catch {
    findings.push({
      code: "decisions-config-unreadable",
      message: "safeinstall.config.json at head is not valid JSON; the effective registry cannot be established."
    });
    return;
  }
  if (registryUrl === undefined) {
    return;
  }
  const normalized = String(registryUrl).replace(/\/+$/, "");
  const allowed = new Set(
    [DEFAULT_REGISTRY_URL, ...allowedRegistryUrls].map((url) => url.replace(/\/+$/, ""))
  );
  if (!allowed.has(normalized)) {
    findings.push({
      code: "registry-not-default",
      message:
        `The candidate's registryUrl (${normalized}) is not the verifier's registry trust root. ` +
        "A registry the pull request can choose is not a trust root (RFC-001 D3); allowlist it " +
        "on the verifier side deliberately, or remove the override."
    });
  }
}

export async function verifyDecisions(
  cwd: string,
  options: DecisionVerifyOptions
): Promise<DecisionVerifyResult> {
  const findings: DecisionVerifyFinding[] = [];
  const infos: string[] = [];
  const verifiedPaths: string[] = [];

  const repo = await resolveGitRepo(cwd);
  if (!repo) {
    return {
      ok: false,
      findings: [{ code: "decisions-no-git", message: "decisions verify requires a git repository." }],
      infos,
      verifiedPaths
    };
  }

  const headRef = options.headRef ?? "HEAD";
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(repo, options.baseRef),
    resolveCommit(repo, headRef)
  ]);
  if (!baseCommit || !headCommit) {
    return {
      ok: false,
      findings: [
        {
          code: "decisions-bad-ref",
          message: `Could not resolve ${!baseCommit ? options.baseRef : headRef} to a commit.`
        }
      ],
      infos,
      verifiedPaths
    };
  }

  const changed = (await changedPaths(repo, baseCommit, headCommit)).filter(isKnownLockfile);
  const recordsByLockfile = await readRecordsAtHead(repo, headCommit, findings);

  for (const lockfilePath of changed) {
    const chain = recordsByLockfile.get(lockfilePath);
    if (!chain || chain.length === 0) {
      findings.push({
        code: "decisions-missing",
        message:
          `${lockfilePath} changed between ${options.baseRef} and ${headRef} without a decision record ` +
          "covering the change (RFC-001 §7). The change does not verify, regardless of how the lockfile was produced."
      });
      continue;
    }
    if (!verifyChainLinkage(lockfilePath, chain, findings)) {
      continue;
    }

    // The chain must span exactly base -> head: some record's 'before' is the
    // base state (earlier records are prior merged history), and the final
    // record's 'after' is the head state.
    const baseOid = await blobOidAtRef(repo, baseCommit, lockfilePath);
    const boundaryIndex = chain.findIndex((entry) =>
      baseOid === undefined
        ? entry.record.lockfile.before === null
        : entry.record.lockfile.before !== null && entry.record.lockfile.before.blobOid === baseOid
    );
    if (boundaryIndex === -1) {
      findings.push({
        code: "decisions-base-unanchored",
        message:
          `No record in the chain for ${lockfilePath} starts from the base state at ${options.baseRef} — ` +
          "the recorded history does not connect to what is being merged onto."
      });
      continue;
    }

    const boundary = chain[boundaryIndex];
    const last = chain[chain.length - 1];
    const baseOk =
      boundary.record.lockfile.before === null
        ? true
        : await verifyAnchoredBinding(
            repo,
            baseCommit,
            lockfilePath,
            boundary.record.lockfile.before,
            "base binding",
            findings
          );
    const headOk = await verifyAnchoredBinding(
      repo,
      headCommit,
      lockfilePath,
      last.record.lockfile.after,
      "head binding",
      findings
    );
    if (baseOk && headOk) {
      verifiedPaths.push(lockfilePath);
    }
  }

  // Chains for unchanged lockfiles are inert history (§9): linkage is still
  // required to hold, but no base/head anchoring applies in this delta.
  for (const [lockfilePath, chain] of recordsByLockfile) {
    if (!changed.includes(lockfilePath)) {
      if (verifyChainLinkage(lockfilePath, chain, findings)) {
        infos.push(`${lockfilePath}: ${chain.length} record(s) of prior history verified (path unchanged in this delta).`);
      }
    }
  }

  await checkRegistryTrustRoot(repo, headCommit, options.allowedRegistryUrls ?? [], findings);

  if (changed.length === 0) {
    infos.push("No lockfile changes between base and head; nothing required a decision record.");
  }

  return { ok: findings.length === 0, findings, infos, verifiedPaths };
}
