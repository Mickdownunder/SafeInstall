import { createHash } from "node:crypto";

import { canonicalizeJson, isCanonicalJson } from "./canonical-json";

/**
 * L2 — the SIGNABLE authorization statement (RFC-001 §3 L2, §10).
 *
 * L2 binds an L1 authorization verdict to a workflow identity with a
 * verifiable signature. This module builds the in-toto v1 Statement that a
 * signature covers — the DSSE payload — and verifies, non-cryptographically,
 * that a statement binds exactly a given authorization artifact.
 *
 * LANGUAGE DISCIPLINE (issue #41): until a real signature exists, this is the
 * *signable statement*, never a "proof". The statement alone attests nothing;
 * it is the bytes a Sigstore keyless signature will cover. The signing step
 * (`sigstore.attest`, which needs an OIDC identity from a CI workflow or an
 * interactive browser flow) and bundle verification against an expected
 * workflow identity (`sigstore.verify`) are the cryptographic completion —
 * they run where an OIDC identity exists, not in a hermetic build, and are
 * documented as the release/CI/owner-gated step. The `sigstore` peer
 * dependency is already present for that path.
 *
 * By freezing the statement's canonical form here, the eventual signature
 * covers a stable, independently reconstructable payload.
 */

export const AUTHORIZATION_PREDICATE_TYPE =
  "https://safeinstall.dev/attestations/dependency-authorization/v1";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/** The subject name used for the authorization artifact in the statement. */
export const AUTHORIZATION_SUBJECT_NAME = "safeinstall-authorization";

export interface InTotoSubject {
  name: string;
  digest: { sha256: string };
}

export interface AuthorizationStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: InTotoSubject[];
  predicateType: typeof AUTHORIZATION_PREDICATE_TYPE;
  predicate: Record<string, unknown>;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

/**
 * Parse and minimally validate an authorization artifact (the canonical bytes
 * written by `decisions authorize --output`). The artifact must be canonical
 * (§5.1) so the subject digest is over stable bytes.
 */
export function parseAuthorizationArtifact(bytes: Buffer): {
  authorization: Record<string, unknown>;
  sha256: string;
} {
  if (!isCanonicalJson(bytes)) {
    throw new AttestationError(
      "authorization artifact is not canonical JSON — re-run `decisions authorize --output` to regenerate it."
    );
  }
  let authorization: Record<string, unknown>;
  try {
    authorization = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AttestationError("authorization artifact is not valid JSON.");
  }
  if (authorization.schemaVersion !== 1) {
    throw new AttestationError(
      `unsupported authorization schemaVersion ${JSON.stringify(authorization.schemaVersion)}; failing closed.`
    );
  }
  if (authorization.verdict !== "allow" && authorization.verdict !== "block") {
    throw new AttestationError("authorization artifact has no valid verdict.");
  }
  return { authorization, sha256: sha256Hex(bytes) };
}

/**
 * Build the in-toto v1 Statement over an authorization artifact. The subject
 * binds the artifact by sha256; the predicate is the authorization itself, so
 * a verifier can reconstruct and re-check every field the signature covers.
 * Returns canonical bytes (the DSSE payload to sign).
 */
export function buildAuthorizationStatement(authorizationBytes: Buffer): {
  statement: AuthorizationStatement;
  canonicalBytes: Buffer;
} {
  const { authorization, sha256 } = parseAuthorizationArtifact(authorizationBytes);
  const statement: AuthorizationStatement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: AUTHORIZATION_SUBJECT_NAME, digest: { sha256 } }],
    predicateType: AUTHORIZATION_PREDICATE_TYPE,
    predicate: authorization
  };
  return {
    statement,
    canonicalBytes: Buffer.from(canonicalizeJson(statement), "utf8")
  };
}

export interface StatementVerification {
  ok: boolean;
  reasons: string[];
  /** The verdict the statement carries, when the statement parsed. */
  verdict?: "allow" | "block";
  headCommit?: string;
}

/**
 * Non-cryptographic verification: does `statementBytes` bind exactly
 * `authorizationBytes`? Checks the statement is canonical and well-typed, the
 * subject digest equals the artifact's sha256, and the predicate's head commit
 * matches the artifact's. This catches a statement built for a different
 * artifact or a tampered artifact — it does NOT verify a signature. Signature
 * verification against a workflow identity is the Sigstore-bundle step
 * (release/CI-gated).
 */
export function verifyAuthorizationStatement(
  statementBytes: Buffer,
  authorizationBytes: Buffer
): StatementVerification {
  const reasons: string[] = [];

  if (!isCanonicalJson(statementBytes)) {
    return { ok: false, reasons: ["statement bytes are not canonical JSON"] };
  }
  let statement: AuthorizationStatement;
  try {
    statement = JSON.parse(statementBytes.toString("utf8")) as AuthorizationStatement;
  } catch {
    return { ok: false, reasons: ["statement is not valid JSON"] };
  }

  if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
    reasons.push(`statement _type is not ${IN_TOTO_STATEMENT_TYPE}`);
  }
  if (statement.predicateType !== AUTHORIZATION_PREDICATE_TYPE) {
    reasons.push(`statement predicateType is not ${AUTHORIZATION_PREDICATE_TYPE}`);
  }

  let artifactSha: string | undefined;
  let artifact: Record<string, unknown> | undefined;
  try {
    const parsed = parseAuthorizationArtifact(authorizationBytes);
    artifactSha = parsed.sha256;
    artifact = parsed.authorization;
  } catch (error) {
    reasons.push(error instanceof AttestationError ? error.message : String(error));
  }

  const subject = Array.isArray(statement.subject) ? statement.subject[0] : undefined;
  if (!subject || subject.digest?.sha256 === undefined) {
    reasons.push("statement subject has no sha256 digest");
  } else if (artifactSha !== undefined && subject.digest.sha256 !== artifactSha) {
    reasons.push(
      `statement subject digest (${subject.digest.sha256}) does not match the authorization artifact (${artifactSha})`
    );
  }

  // Cross-check a load-bearing field so a statement whose predicate was swapped
  // for a different (but same-digest-length) authorization is caught too.
  const predicate = statement.predicate as Record<string, unknown> | undefined;
  const verdict =
    artifact?.verdict === "allow" || artifact?.verdict === "block"
      ? (artifact.verdict as "allow" | "block")
      : undefined;
  const headCommit = typeof artifact?.headCommit === "string" ? artifact.headCommit : undefined;
  if (predicate && artifact) {
    if (predicate.headCommit !== artifact.headCommit) {
      reasons.push("statement predicate headCommit does not match the authorization artifact");
    }
    if (predicate.verdict !== artifact.verdict) {
      reasons.push("statement predicate verdict does not match the authorization artifact");
    }
  }

  return { ok: reasons.length === 0, reasons, verdict, headCommit };
}
