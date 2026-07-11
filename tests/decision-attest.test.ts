import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalizeJson, isCanonicalJson } from "../src/canonical-json";
import {
  AUTHORIZATION_PREDICATE_TYPE,
  AUTHORIZATION_SUBJECT_NAME,
  IN_TOTO_STATEMENT_TYPE,
  buildAuthorizationStatement,
  parseAuthorizationArtifact,
  verifyAuthorizationStatement
} from "../src/decision-attest";

/** A canonical authorization artifact, as `decisions authorize --output` writes. */
function authorizationBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    canonicalizeJson({
      schemaVersion: 1,
      evaluatedAt: "2026-07-11T12:00:00.000Z",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      lockfiles: [{ path: "package-lock.json", headBlobOid: "c".repeat(40) }],
      policyBlobOid: "d".repeat(40),
      verdict: "allow",
      reasons: [],
      warnings: [],
      ...overrides
    }),
    "utf8"
  );
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("parseAuthorizationArtifact", () => {
  it("accepts a canonical allow artifact and returns its sha256", () => {
    const bytes = authorizationBytes();
    const { authorization, sha256 } = parseAuthorizationArtifact(bytes);
    expect(authorization.verdict).toBe("allow");
    expect(sha256).toBe(sha256Hex(bytes));
  });

  it("rejects non-canonical bytes", () => {
    const pretty = Buffer.from(JSON.stringify({ schemaVersion: 1, verdict: "allow" }, null, 2), "utf8");
    expect(() => parseAuthorizationArtifact(pretty)).toThrow(/not canonical/);
  });

  it("fails closed on an unknown schemaVersion", () => {
    expect(() => parseAuthorizationArtifact(authorizationBytes({ schemaVersion: 2 }))).toThrow(
      /unsupported authorization schemaVersion/
    );
  });
});

describe("buildAuthorizationStatement", () => {
  it("builds a canonical in-toto v1 statement binding the artifact by sha256", () => {
    const bytes = authorizationBytes();
    const { statement, canonicalBytes } = buildAuthorizationStatement(bytes);

    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(AUTHORIZATION_PREDICATE_TYPE);
    expect(statement.subject).toEqual([
      { name: AUTHORIZATION_SUBJECT_NAME, digest: { sha256: sha256Hex(bytes) } }
    ]);
    expect(statement.predicate.verdict).toBe("allow");
    expect(isCanonicalJson(canonicalBytes)).toBe(true);
  });

  it("is byte-deterministic (the same signature covers the same payload)", () => {
    const bytes = authorizationBytes();
    expect(buildAuthorizationStatement(bytes).canonicalBytes.equals(buildAuthorizationStatement(bytes).canonicalBytes)).toBe(
      true
    );
  });
});

describe("verifyAuthorizationStatement", () => {
  it("accepts a statement built for the same artifact", () => {
    const bytes = authorizationBytes();
    const { canonicalBytes } = buildAuthorizationStatement(bytes);
    const result = verifyAuthorizationStatement(canonicalBytes, bytes);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("allow");
    expect(result.headCommit).toBe("b".repeat(40));
  });

  it("rejects a statement built for a DIFFERENT artifact", () => {
    const { canonicalBytes } = buildAuthorizationStatement(authorizationBytes({ headCommit: "e".repeat(40) }));
    const result = verifyAuthorizationStatement(canonicalBytes, authorizationBytes());
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("subject digest"))).toBe(true);
  });

  it("rejects a statement whose predicate was swapped but subject digest left intact", () => {
    const bytes = authorizationBytes();
    const { statement } = buildAuthorizationStatement(bytes);
    // Keep the (correct) subject digest, but tamper the predicate verdict.
    const tampered = Buffer.from(
      canonicalizeJson({ ...statement, predicate: { ...statement.predicate, verdict: "block" } }),
      "utf8"
    );
    const result = verifyAuthorizationStatement(tampered, bytes);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("verdict does not match"))).toBe(true);
  });

  it("rejects a non-canonical statement", () => {
    const bytes = authorizationBytes();
    const { statement } = buildAuthorizationStatement(bytes);
    const pretty = Buffer.from(JSON.stringify(statement, null, 2), "utf8");
    const result = verifyAuthorizationStatement(pretty, bytes);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("not canonical");
  });

  it("rejects a statement with the wrong predicateType", () => {
    const bytes = authorizationBytes();
    const { statement } = buildAuthorizationStatement(bytes);
    const wrong = Buffer.from(
      canonicalizeJson({ ...statement, predicateType: "https://example.com/other/v1" }),
      "utf8"
    );
    const result = verifyAuthorizationStatement(wrong, bytes);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("predicateType"))).toBe(true);
  });
});
