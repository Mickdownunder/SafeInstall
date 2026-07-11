import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DECISION_GENESIS_DIGEST } from "../src/decision-record";
import {
  appendDecisionRecord,
  decisionsDirForLockfile,
  readDecisionChain
} from "../src/decision-store";
import { createDecisionDraft } from "./helpers/decision-fixture";

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
    expect(chain[1].record.chain.prev).toBe(chain[0].digest);
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
    await rm(path.join(dir, first));

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
