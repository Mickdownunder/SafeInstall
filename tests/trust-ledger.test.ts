import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendLedgerEntry,
  checkLedgerMirror,
  readLedgerHeadMirror,
  removeLedgerHeadMirror,
  resetLedger,
  verifyLedgerChain
} from "../src/trust-ledger";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";
import { present } from "./helpers/present";

afterAll(async () => {
  await cleanupTempDirs();
});

let stateDir: string;

beforeEach(async () => {
  stateDir = await createTempDir("safeinstall-state-");
  process.env.SAFEINSTALL_STATE_DIR = stateDir;
});

describe("trust ledger", () => {
  it("builds a verifiable hash chain and mirrors the head out of the workspace", async () => {
    const root = await createTempDir("safeinstall-ledger-");
    const head1 = await resetLedger(root, "lock-created", "baseline");
    const head2 = await appendLedgerEntry(root, "approved", "rebaseline");

    const chain = await verifyLedgerChain(root);
    expect(chain.status).toBe("ok");
    expect(chain.head).toBe(head2);
    expect(head1).not.toBe(head2);

    expect(await readLedgerHeadMirror(root)).toBe(head2);
    expect(await checkLedgerMirror(root, head2)).toBe("ok");
  });

  it("detects a rewritten (tampered) ledger", async () => {
    const root = await createTempDir("safeinstall-ledger-tamper-");
    await resetLedger(root, "lock-created", "baseline");
    await appendLedgerEntry(root, "approved", "rebaseline");

    const ledgerPath = path.join(root, ".safeinstall", "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split("\n");
    const first = JSON.parse(present(lines[0]));
    first.detail = "forged";
    await writeFile(ledgerPath, `${JSON.stringify(first)}\n${lines[1]}\n`);

    expect((await verifyLedgerChain(root)).status).toBe("broken");
  });

  it("reports a mirror mismatch when the in-repo head no longer matches", async () => {
    const root = await createTempDir("safeinstall-ledger-mirror-");
    await resetLedger(root, "lock-created", "baseline");
    expect(await checkLedgerMirror(root, "deadbeef")).toBe("mismatch");
  });

  it("treats a missing chain as missing, not broken", async () => {
    const root = await createTempDir("safeinstall-ledger-empty-");
    expect((await verifyLedgerChain(root)).status).toBe("missing");
  });

  it("serializes concurrent appends into an intact chain (no race corruption)", async () => {
    const root = await createTempDir("safeinstall-ledger-race-");
    await resetLedger(root, "lock-created", "baseline");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => appendLedgerEntry(root, "approved", `d${index}`))
    );

    const chain = await verifyLedgerChain(root);
    expect(chain.status).toBe("ok");
    expect(chain.entries).toHaveLength(9); // baseline + 8 appends, all chained
  });

  it("reports a missing mirror distinctly from a mismatch", async () => {
    const root = await createTempDir("safeinstall-ledger-nomirror-");
    const head = await resetLedger(root, "lock-created", "baseline");
    await removeLedgerHeadMirror(root);
    expect(await checkLedgerMirror(root, head)).toBe("missing");
  });
});
