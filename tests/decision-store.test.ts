import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DECISION_GENESIS_DIGEST,
  decisionRecordDigest,
  decisionRecordFileName,
  encodeDecisionRecord,
  type DecisionRecord
} from "../src/decision-record";
import {
  appendDecisionRecord,
  decisionsDirForLockfile,
  readDecisionChain,
  type StoredDecisionRecord
} from "../src/decision-store";
import { createDecisionDraft } from "./helpers/decision-fixture";
import { present } from "./helpers/present";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-decisions-"));
  tempDirs.push(dir);
  return dir;
}

function draft(lockfilePath = "pnpm-lock.yaml") {
  return createDecisionDraft({
    lockfilePath,
    before: null,
    after: {
      path: lockfilePath,
      blobOid: "a".repeat(40),
      objectFormat: "sha1",
      sha256: "b".repeat(64)
    }
  });
}

describe("appendDecisionRecord", () => {
  it("assigns genesis-linked seq 1 and chains subsequent appends by digest", async () => {
    const root = await createRoot();

    const first = await appendDecisionRecord(root, draft());
    const second = await appendDecisionRecord(root, draft());

    expect(first.seq).toBe(1);
    expect(first.record.chain.prev).toBe(DECISION_GENESIS_DIGEST);
    expect(second.seq).toBe(2);
    expect(second.record.chain.prev).toBe(first.digest);

    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(present(chain[1]).record.chain.prev).toBe(present(chain[0]).digest);
  });

  it("keeps chains for different lockfile paths independent", async () => {
    const root = await createRoot();
    await appendDecisionRecord(root, draft("pnpm-lock.yaml"));
    const other = await appendDecisionRecord(root, draft("apps/web/package-lock.json"));

    expect(other.seq).toBe(1);
    expect(await readDecisionChain(root, "apps/web/package-lock.json")).toHaveLength(1);
    expect(await readDecisionChain(root, "pnpm-lock.yaml")).toHaveLength(1);
  });

  it("serializes concurrent appends into one unforked chain", async () => {
    const root = await createRoot();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => appendDecisionRecord(root, draft()))
    );

    expect(new Set(results.map((entry) => entry.seq))).toEqual(new Set([1, 2, 3, 4, 5]));
    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain).toHaveLength(5);
  });
});

describe("readDecisionChain", () => {
  it("returns an empty chain when no records exist", async () => {
    expect(await readDecisionChain(await createRoot(), "pnpm-lock.yaml")).toEqual([]);
  });

  it("rejects a record whose bytes were modified after writing", async () => {
    const root = await createRoot();
    const stored = await appendDecisionRecord(root, draft());
    const dir = decisionsDirForLockfile(root, "pnpm-lock.yaml");
    const filePath = path.join(dir, stored.fileName);

    const bytes = await readFile(filePath);
    // A single-byte content change with the same shape: digest mismatch.
    await writeFile(filePath, Buffer.from(bytes.toString("utf8").replace('"installed":true', '"installed":null')));

    await expect(readDecisionChain(root, "pnpm-lock.yaml")).rejects.toThrow(/does not match its digest/);
  });

  it("rejects a chain with a removed record (gap)", async () => {
    const root = await createRoot();
    await appendDecisionRecord(root, draft());
    await appendDecisionRecord(root, draft());
    const dir = decisionsDirForLockfile(root, "pnpm-lock.yaml");
    const [first] = (await readdir(dir)).sort();
    await rm(path.join(dir, present(first)));

    await expect(readDecisionChain(root, "pnpm-lock.yaml")).rejects.toThrow(/expected seq 1/);
  });

  it("rejects a renamed (renumbered) record", async () => {
    const root = await createRoot();
    const stored = await appendDecisionRecord(root, draft());
    const dir = decisionsDirForLockfile(root, "pnpm-lock.yaml");
    await rename(
      path.join(dir, stored.fileName),
      path.join(dir, stored.fileName.replace("000001", "000002"))
    );

    await expect(readDecisionChain(root, "pnpm-lock.yaml")).rejects.toThrow(/expected seq 1/);
  });
});

/**
 * Parallel branches each append one record at the same chain position; the
 * merge then holds several records with one seq and one prev (the
 * 12.09.2026 incident: three records 000013 on one predecessor).
 */
describe("readDecisionChain with forked siblings from merged branches", () => {
  /** Write a record file directly — what a merged branch contributes. */
  async function writeRecord(root: string, record: DecisionRecord): Promise<string> {
    const bytes = encodeDecisionRecord(record);
    const fileName = decisionRecordFileName(record.chain.seq, decisionRecordDigest(bytes));
    await writeFile(path.join(decisionsDirForLockfile(root, record.lockfile.path), fileName), bytes);
    return fileName;
  }

  /** A record at `head`'s successor position, as another branch would write it. */
  function sibling(head: StoredDecisionRecord, overrides: Partial<DecisionRecord>): DecisionRecord {
    return {
      ...head.record,
      ...overrides,
      chain: { seq: head.seq + 1, prev: head.digest, archive: null }
    };
  }

  /** Twelve linked records — the state before the parallel branches. */
  async function chainOfTwelve(root: string): Promise<StoredDecisionRecord> {
    let head: StoredDecisionRecord | undefined;
    for (let index = 0; index < 12; index += 1) {
      head = await appendDecisionRecord(root, draft());
    }
    return present(head);
  }

  it("resolves siblings identical except createdAt to the earliest and appends seq 14 onto it", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    const late = await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:38.415Z" }));
    const earliest = await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:11.645Z" }));
    const middle = await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:22.139Z" }));

    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain).toHaveLength(13);
    const thirteen = present(chain[12]);
    expect(thirteen.fileName).toBe(earliest);
    expect([...(thirteen.duplicateSiblings ?? [])].sort()).toEqual([late, middle].sort());

    const fourteen = await appendDecisionRecord(root, draft());
    expect(fourteen.seq).toBe(14);
    expect(fourteen.record.chain.prev).toBe(thirteen.digest);
    expect(await readDecisionChain(root, "pnpm-lock.yaml")).toHaveLength(14);
  });

  it("follows the sibling a later record already chains onto, even when it is not the earliest", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:11.645Z" }));
    const continuedRecord = sibling(twelve, { createdAt: "2026-09-12T11:36:38.415Z" });
    const continued = await writeRecord(root, continuedRecord);
    await writeRecord(root, {
      ...continuedRecord,
      chain: { seq: 14, prev: decisionRecordDigest(encodeDecisionRecord(continuedRecord)), archive: null }
    });

    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain).toHaveLength(14);
    expect(present(chain[12]).fileName).toBe(continued);
  });

  it("refuses siblings that record different decisions and names every sibling file with the repair path", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    const allow = await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:11.645Z" }));
    const block = await writeRecord(
      root,
      sibling(twelve, {
        createdAt: "2026-09-12T11:36:22.139Z",
        verdict: { decision: "block", reasons: [{ code: "too-new", message: "too new" }], notEvaluableCount: 0 }
      })
    );

    const failure = readDecisionChain(root, "pnpm-lock.yaml");
    await expect(failure).rejects.toThrow(/forked at seq 13/);
    await expect(failure).rejects.toThrow(new RegExp(allow));
    await expect(failure).rejects.toThrow(new RegExp(block));
    await expect(failure).rejects.toThrow(/subdirectory/);

    // Nothing is silently dropped, and nothing is appended past the fork.
    const dir = decisionsDirForLockfile(root, "pnpm-lock.yaml");
    const before = (await readdir(dir)).sort();
    await expect(appendDecisionRecord(root, draft())).rejects.toThrow(/forked at seq 13/);
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it("refuses identical siblings when more than one of them was continued", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    for (const createdAt of ["2026-09-12T11:36:11.645Z", "2026-09-12T11:36:22.139Z"]) {
      const record = sibling(twelve, { createdAt });
      await writeRecord(root, record);
      await writeRecord(root, {
        ...record,
        chain: { seq: 14, prev: decisionRecordDigest(encodeDecisionRecord(record)), archive: null }
      });
    }

    await expect(readDecisionChain(root, "pnpm-lock.yaml")).rejects.toThrow(/forked at seq 13/);
  });

  it("refuses a sibling that does not chain onto the shared predecessor", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:11.645Z" }));
    const foreign = sibling(twelve, { createdAt: "2026-09-12T11:36:22.139Z" });
    await writeRecord(root, { ...foreign, chain: { seq: 13, prev: "f".repeat(64), archive: null } });

    await expect(readDecisionChain(root, "pnpm-lock.yaml")).rejects.toThrow(/does not chain/);
  });

  it("keeps the hand-repaired form valid: set-aside siblings in a subdirectory are evidence, not chain", async () => {
    const root = await createRoot();
    const twelve = await chainOfTwelve(root);
    const kept = await writeRecord(root, sibling(twelve, { createdAt: "2026-09-12T11:36:11.645Z" }));
    const dir = decisionsDirForLockfile(root, "pnpm-lock.yaml");
    const setAside = path.join(dir, "gabelung-2026-09-12");
    await mkdir(setAside);
    for (const createdAt of ["2026-09-12T11:36:22.139Z", "2026-09-12T11:36:38.415Z"]) {
      const name = await writeRecord(root, sibling(twelve, { createdAt }));
      await rename(path.join(dir, name), path.join(setAside, name));
    }
    await writeFile(path.join(setAside, "LIESMICH.md"), "set aside\n");

    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain).toHaveLength(13);
    expect(present(chain[12]).fileName).toBe(kept);
    expect(chain.every((entry) => entry.duplicateSiblings === undefined)).toBe(true);
    expect((await appendDecisionRecord(root, draft())).seq).toBe(14);
  });

  it("leaves unforked chains exactly as before: no sibling notes, same linkage", async () => {
    const root = await createRoot();
    await chainOfTwelve(root);

    const chain = await readDecisionChain(root, "pnpm-lock.yaml");
    expect(chain.map((entry) => entry.seq)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(chain.every((entry) => entry.duplicateSiblings === undefined)).toBe(true);
    for (const [index, entry] of chain.entries()) {
      expect(entry.record.chain.prev).toBe(
        index === 0 ? DECISION_GENESIS_DIGEST : present(chain[index - 1]).digest
      );
    }
  });
});
