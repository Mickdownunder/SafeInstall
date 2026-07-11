import { describe, expect, it } from "vitest";

import {
  DECISION_GENESIS_DIGEST,
  decisionRecordDigest,
  decisionRecordFileName,
  encodeDecisionRecord,
  lockfilePathSlug,
  parseDecisionRecord,
  validateDecisionRecord,
  type DecisionRecord
} from "../src/decision-record";
import { createDecisionDraft } from "./helpers/decision-fixture";

function createRecord(): DecisionRecord {
  return {
    ...createDecisionDraft({
      lockfilePath: "pnpm-lock.yaml",
      before: null,
      after: {
        path: "pnpm-lock.yaml",
        blobOid: "a".repeat(40),
        objectFormat: "sha1",
        sha256: "b".repeat(64)
      }
    }),
    chain: { seq: 1, prev: DECISION_GENESIS_DIGEST, archive: null }
  };
}

describe("decision record encoding", () => {
  it("round-trips through canonical bytes", () => {
    const record = createRecord();
    const bytes = encodeDecisionRecord(record);
    expect(parseDecisionRecord(bytes)).toEqual(record);
  });

  it("has no trailing newline and is byte-deterministic", () => {
    const bytes = encodeDecisionRecord(createRecord());
    expect(bytes[bytes.length - 1]).not.toBe(0x0a);
    expect(encodeDecisionRecord(createRecord()).equals(bytes)).toBe(true);
  });

  it("rejects non-canonical bytes even when the JSON parses", () => {
    const pretty = Buffer.from(JSON.stringify(createRecord(), null, 2), "utf8");
    expect(() => parseDecisionRecord(pretty)).toThrow(/not canonical/);
  });

  it("names record files by seq and digest prefix", () => {
    const bytes = encodeDecisionRecord(createRecord());
    const digest = decisionRecordDigest(bytes);
    expect(decisionRecordFileName(3, digest)).toBe(`000003-${digest.slice(0, 12)}.json`);
  });
});

describe("validateDecisionRecord", () => {
  it("fails closed on unknown schema versions", () => {
    const record = { ...createRecord(), schemaVersion: 2 };
    expect(() => validateDecisionRecord(record)).toThrow(/unsupported schemaVersion.*failing closed/);
  });

  it.each([
    ["actor", { actor: "ci" }],
    ["recordType", { recordType: "audit" }],
    ["createdAt", { createdAt: "yesterday" }],
    ["verdict.decision", { verdict: { decision: "maybe", reasons: [], notEvaluableCount: 0 } }],
    ["chain.prev", { chain: { seq: 1, prev: "xyz", archive: null } }],
    ["chain.seq", { chain: { seq: 0, prev: DECISION_GENESIS_DIGEST, archive: null } }],
    ["installed", { installed: "yes" }]
  ])("rejects an invalid %s", (_field, override) => {
    expect(() => validateDecisionRecord({ ...createRecord(), ...override })).toThrow(
      /Invalid decision record/
    );
  });

  it("requires explicit notEvaluable objects on observations (D4)", () => {
    const record = createRecord();
    const observation = { ...record.observations[0] } as Record<string, unknown>;
    delete observation.notEvaluable;
    expect(() => validateDecisionRecord({ ...record, observations: [observation] })).toThrow(
      /notEvaluable must be an object with explicit nulls/
    );
  });
});

describe("lockfilePathSlug", () => {
  it("cannot collide for paths that a naive separator replacement would merge", () => {
    expect(lockfilePathSlug("a__b/pnpm-lock.yaml")).not.toBe(lockfilePathSlug("a/b__pnpm-lock.yaml"));
  });

  it("is deterministic and readable", () => {
    expect(lockfilePathSlug("apps/web/pnpm-lock.yaml")).toMatch(/^apps__web__pnpm-lock\.yaml-[0-9a-f]{8}$/);
  });
});
