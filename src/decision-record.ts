import { createHash } from "node:crypto";

import { canonicalJsonBytes, isCanonicalJson } from "./canonical-json";
import type { GitFileBinding } from "./git-blob";

/**
 * Dependency Decision Records — L0 (RFC-001 §5).
 *
 * A record is the deterministic, machine-readable trace of one dependency
 * decision: what was asked, the effective policy, the registry facts
 * observed, the verdict, and git-blob bindings to the exact repository state
 * involved. Records are EXPLICITLY UNTRUSTED (§3): they carry `actor`
 * provenance, they are audit evidence rather than a gate, and CI (L1)
 * re-derives everything and ignores the recorded verdict.
 *
 * Byte semantics (§5.1): the record file IS the canonical JCS bytes; the
 * record digest is sha256 over those bytes. Chains are per lockfile path
 * (§7, D5): each record names one lockfile and links to the previous record
 * for that path by digest.
 */

export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_GENESIS_DIGEST = "0".repeat(64);
export const DECISIONS_RELATIVE_DIR = ".safeinstall/decisions";

export type DecisionActor = "agent" | "human-unverified";
export type DecisionRecordType = "install" | "check";
export type DecisionVerdict = "allow" | "block" | "error";

/** A GitFileBinding, or null for an explicit "file absent at this point". */
export type DecisionBinding = GitFileBinding | null;

export interface DecisionReason {
  code: string;
  message: string;
}

/**
 * Per-package registry observation. Signals that could not be computed are
 * explicit `notEvaluable` reasons — never absent fields (§5.4, D4).
 */
export interface DecisionObservation {
  name: string;
  requestedSpec: string;
  sourceType: string;
  resolvedVersion: string | null;
  publishedAt: string | null;
  publishTimeSource: "registry-time" | "tarball-last-modified" | null;
  findings: DecisionReason[];
  notEvaluable: {
    releaseAge: string | null;
    provenance: string | null;
  };
}

export interface DecisionRecord {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  recordType: DecisionRecordType;
  /** L0 provenance: never upgradeable in place (§3). */
  actor: DecisionActor;
  /** Observed local time, RFC 3339 — recorded, never trusted (§6). */
  createdAt: string;
  cliVersion: string;
  request: {
    command: string[];
    packageManager: string | null;
  };
  policy: {
    /** Binding of safeinstall.config.json, or null when defaults ran. */
    binding: DecisionBinding;
    effective: {
      minimumReleaseAgeHours: number;
      allowedSources: string[];
      provenanceMode: string;
      typoSquatMode: string;
      transitiveMode: string;
      continuityMode: string;
      registryUrl: string;
      /** False is a hard L1 finding pending allowlisting (D3). */
      registryDefault: boolean;
    };
  };
  observations: DecisionObservation[];
  verdict: {
    decision: DecisionVerdict;
    reasons: DecisionReason[];
    /** Count of observations with any notEvaluable signal — a record with
     *  non-registry sources can never summarize as clean (§5.4). */
    notEvaluableCount: number;
  };
  manifest: {
    path: string | null;
    before: DecisionBinding;
    after: DecisionBinding;
  };
  lockfile: {
    /** Exactly one lockfile path per record (§7, D5). */
    path: string;
    before: DecisionBinding;
    after: DecisionBinding;
  };
  trust: {
    /** Binding of .safeinstall/trust-surface.lock, or null when unlocked. */
    lockBinding: DecisionBinding;
  };
  /** Install records: package manager exited 0. Check records: null.
   *  Honesty metadata, not a gate input (§4, M3). */
  installed: boolean | null;
  chain: {
    /** 1-based position within this lockfile path's chain. */
    seq: number;
    /** Digest of the previous record for this path, or the genesis digest. */
    prev: string;
    /** Digest of a compaction archive this chain continues from (D6);
     *  null until compaction exists. */
    archive: string | null;
  };
}

export function encodeDecisionRecord(record: DecisionRecord): Buffer {
  return canonicalJsonBytes(record);
}

export function decisionRecordDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `<seq, 6 digits>-<digest prefix>.json` (§5.3). */
export function decisionRecordFileName(seq: number, digest: string): string {
  return `${String(seq).padStart(6, "0")}-${digest.slice(0, 12)}.json`;
}

/**
 * Directory slug for a lockfile path: readable prefix plus a digest suffix so
 * distinct paths can never collide (`a__b/x` vs `a/b__x` under a naive
 * separator replacement).
 */
export function lockfilePathSlug(lockfilePath: string): string {
  const readable = lockfilePath.replaceAll("/", "__");
  const suffix = createHash("sha256").update(lockfilePath, "utf8").digest("hex").slice(0, 8);
  return `${readable}-${suffix}`;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

class RecordShapeError extends Error {
  constructor(message: string) {
    super(`Invalid decision record: ${message}`);
    this.name = "RecordShapeError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RecordShapeError(`${label} must be a string`);
  }
  return value;
}

function expectStringOrNull(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new RecordShapeError(`${label} must be a string or null`);
  }
  return value as string | null;
}

function expectReasons(value: unknown, label: string): DecisionReason[] {
  if (!Array.isArray(value)) {
    throw new RecordShapeError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new RecordShapeError(`${label}[${index}] must be an object`);
    }
    return {
      code: expectString(entry.code, `${label}[${index}].code`),
      message: expectString(entry.message, `${label}[${index}].message`)
    };
  });
}

function expectBinding(value: unknown, label: string): DecisionBinding {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new RecordShapeError(`${label} must be a binding object or null`);
  }
  const objectFormat = expectString(value.objectFormat, `${label}.objectFormat`);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new RecordShapeError(`${label}.objectFormat must be "sha1" or "sha256"`);
  }
  const sha256 = expectString(value.sha256, `${label}.sha256`);
  if (!HEX_64.test(sha256)) {
    throw new RecordShapeError(`${label}.sha256 must be 64 lowercase hex characters`);
  }
  return {
    path: expectString(value.path, `${label}.path`),
    blobOid: expectString(value.blobOid, `${label}.blobOid`),
    objectFormat,
    sha256
  };
}

/**
 * Structural validation. Unknown schema versions fail closed (§5.1); every
 * field the verifier later relies on is checked here so a malformed record is
 * one error, not an undefined-property crash mid-verification.
 */
export function validateDecisionRecord(value: unknown): DecisionRecord {
  if (!isPlainObject(value)) {
    throw new RecordShapeError("not a JSON object");
  }
  if (value.schemaVersion !== DECISION_SCHEMA_VERSION) {
    throw new RecordShapeError(
      `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (this CLI supports ${DECISION_SCHEMA_VERSION}); failing closed`
    );
  }
  const recordType = expectString(value.recordType, "recordType");
  if (recordType !== "install" && recordType !== "check") {
    throw new RecordShapeError(`recordType must be "install" or "check"`);
  }
  const actor = expectString(value.actor, "actor");
  if (actor !== "agent" && actor !== "human-unverified") {
    throw new RecordShapeError(`actor must be "agent" or "human-unverified"`);
  }
  const createdAt = expectString(value.createdAt, "createdAt");
  if (!RFC3339.test(createdAt)) {
    throw new RecordShapeError("createdAt must be an RFC 3339 timestamp");
  }

  if (!isPlainObject(value.request) || !Array.isArray(value.request.command)) {
    throw new RecordShapeError("request.command must be an array");
  }
  if (!isPlainObject(value.policy) || !isPlainObject(value.policy.effective)) {
    throw new RecordShapeError("policy.effective must be an object");
  }
  if (typeof value.policy.effective.registryDefault !== "boolean") {
    throw new RecordShapeError("policy.effective.registryDefault must be a boolean");
  }

  if (!Array.isArray(value.observations)) {
    throw new RecordShapeError("observations must be an array");
  }
  const observations = value.observations.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new RecordShapeError(`observations[${index}] must be an object`);
    }
    if (!isPlainObject(entry.notEvaluable)) {
      throw new RecordShapeError(
        `observations[${index}].notEvaluable must be an object with explicit nulls (D4)`
      );
    }
    const publishTimeSource = expectStringOrNull(
      entry.publishTimeSource,
      `observations[${index}].publishTimeSource`
    );
    if (
      publishTimeSource !== null &&
      publishTimeSource !== "registry-time" &&
      publishTimeSource !== "tarball-last-modified"
    ) {
      throw new RecordShapeError(`observations[${index}].publishTimeSource is invalid`);
    }
    const validatedSource = publishTimeSource as DecisionObservation["publishTimeSource"];
    return {
      name: expectString(entry.name, `observations[${index}].name`),
      requestedSpec: expectString(entry.requestedSpec, `observations[${index}].requestedSpec`),
      sourceType: expectString(entry.sourceType, `observations[${index}].sourceType`),
      resolvedVersion: expectStringOrNull(entry.resolvedVersion, `observations[${index}].resolvedVersion`),
      publishedAt: expectStringOrNull(entry.publishedAt, `observations[${index}].publishedAt`),
      publishTimeSource: validatedSource,
      findings: expectReasons(entry.findings, `observations[${index}].findings`),
      notEvaluable: {
        releaseAge: expectStringOrNull(
          entry.notEvaluable.releaseAge,
          `observations[${index}].notEvaluable.releaseAge`
        ),
        provenance: expectStringOrNull(
          entry.notEvaluable.provenance,
          `observations[${index}].notEvaluable.provenance`
        )
      }
    };
  });

  if (!isPlainObject(value.verdict)) {
    throw new RecordShapeError("verdict must be an object");
  }
  const decision = expectString(value.verdict.decision, "verdict.decision");
  if (decision !== "allow" && decision !== "block" && decision !== "error") {
    throw new RecordShapeError(`verdict.decision must be allow, block, or error`);
  }
  if (typeof value.verdict.notEvaluableCount !== "number") {
    throw new RecordShapeError("verdict.notEvaluableCount must be a number");
  }

  if (!isPlainObject(value.manifest) || !isPlainObject(value.lockfile) || !isPlainObject(value.trust)) {
    throw new RecordShapeError("manifest, lockfile, and trust sections are required");
  }
  const lockfilePath = expectString(value.lockfile.path, "lockfile.path");

  if (value.installed !== null && typeof value.installed !== "boolean") {
    throw new RecordShapeError("installed must be a boolean or null");
  }

  if (!isPlainObject(value.chain)) {
    throw new RecordShapeError("chain must be an object");
  }
  const seq = value.chain.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new RecordShapeError("chain.seq must be a positive integer");
  }
  const prev = expectString(value.chain.prev, "chain.prev");
  if (!HEX_64.test(prev)) {
    throw new RecordShapeError("chain.prev must be 64 lowercase hex characters");
  }
  const archive = expectStringOrNull(value.chain.archive, "chain.archive");
  if (archive !== null && !HEX_64.test(archive)) {
    throw new RecordShapeError("chain.archive must be 64 lowercase hex characters or null");
  }

  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    recordType,
    actor,
    createdAt,
    cliVersion: expectString(value.cliVersion, "cliVersion"),
    request: {
      command: (value.request.command as unknown[]).map((part, index) =>
        expectString(part, `request.command[${index}]`)
      ),
      packageManager: expectStringOrNull(value.request.packageManager, "request.packageManager")
    },
    policy: {
      binding: expectBinding(value.policy.binding, "policy.binding"),
      effective: {
        minimumReleaseAgeHours: value.policy.effective.minimumReleaseAgeHours as number,
        allowedSources: (value.policy.effective.allowedSources as unknown[] ?? []).map((entry, index) =>
          expectString(entry, `policy.effective.allowedSources[${index}]`)
        ),
        provenanceMode: expectString(value.policy.effective.provenanceMode, "policy.effective.provenanceMode"),
        typoSquatMode: expectString(value.policy.effective.typoSquatMode, "policy.effective.typoSquatMode"),
        transitiveMode: expectString(value.policy.effective.transitiveMode, "policy.effective.transitiveMode"),
        continuityMode: expectString(value.policy.effective.continuityMode, "policy.effective.continuityMode"),
        registryUrl: expectString(value.policy.effective.registryUrl, "policy.effective.registryUrl"),
        registryDefault: value.policy.effective.registryDefault
      }
    },
    observations,
    verdict: {
      decision,
      reasons: expectReasons(value.verdict.reasons, "verdict.reasons"),
      notEvaluableCount: value.verdict.notEvaluableCount
    },
    manifest: {
      path: expectStringOrNull(value.manifest.path, "manifest.path"),
      before: expectBinding(value.manifest.before, "manifest.before"),
      after: expectBinding(value.manifest.after, "manifest.after")
    },
    lockfile: {
      path: lockfilePath,
      before: expectBinding(value.lockfile.before, "lockfile.before"),
      after: expectBinding(value.lockfile.after, "lockfile.after")
    },
    trust: {
      lockBinding: expectBinding(value.trust.lockBinding, "trust.lockBinding")
    },
    installed: value.installed as boolean | null,
    chain: { seq, prev, archive }
  };
}

/**
 * Parse record bytes: canonical-form check first (§5.1 — a record whose bytes
 * are not canonical must never verify), then structural validation.
 */
export function parseDecisionRecord(bytes: Buffer): DecisionRecord {
  if (!isCanonicalJson(bytes)) {
    throw new RecordShapeError("bytes are not canonical RFC 8785 JSON (profile D1)");
  }
  return validateDecisionRecord(JSON.parse(bytes.toString("utf8")));
}
