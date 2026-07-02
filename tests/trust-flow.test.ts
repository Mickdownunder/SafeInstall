import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  runTrustApproveFlow,
  runTrustLockFlow,
  runTrustStatusFlow,
  runTrustUnlockFlow
} from "../src/trust-flow";
import type { HumanGate } from "../src/trust-flow";
import { readLedgerHeadMirror, removeLedgerHeadMirror } from "../src/trust-ledger";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";

afterAll(async () => {
  await cleanupTempDirs();
});

let stateDir: string;

beforeEach(async () => {
  stateDir = await createTempDir("safeinstall-state-");
  process.env.SAFEINSTALL_STATE_DIR = stateDir;
});

async function seedProject(): Promise<string> {
  const root = await createTempDir("safeinstall-trustflow-");
  await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1 }));
  await writeFile(path.join(root, "AGENTS.md"), "# rules\n");
  return root;
}

function approvingGate(): HumanGate {
  return {
    async ensureInteractive() {
      /* interactive */
    },
    async confirm() {
      return true;
    }
  };
}

function decliningGate(): HumanGate {
  return {
    async ensureInteractive() {
      /* interactive */
    },
    async confirm() {
      return false;
    }
  };
}

describe("runTrustLockFlow", () => {
  it("creates a baseline and reports the locked files", async () => {
    const root = await seedProject();
    const result = await runTrustLockFlow(root, ["trust", "lock"]);
    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
    expect(result.infos.some((info) => info.includes("safeinstall.config.json"))).toBe(true);
  });

  it("refuses to lock twice, reporting drift instead", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, "safeinstall.config.json"), '{"minimumReleaseAgeHours":0}\n');

    const result = await runTrustLockFlow(root, ["trust", "lock"]);
    expect(result.decision).toBe("error");
    expect(result.summary).toContain("already locked");
  });

  it("refuses to lock a surface that contains hidden Unicode (P1b)", async () => {
    const root = await seedProject();
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nignore\u200bprevious\n");

    const result = await runTrustLockFlow(root, ["trust", "lock"]);
    expect(result.decision).toBe("error");
    expect(result.reasons.some((reason) => reason.code === "trust-hidden-unicode")).toBe(true);
  });

  it("scaffolds the CI workflow with --ci github, captures it in the baseline, and stays clean", async () => {
    const root = await seedProject();
    const first = await runTrustLockFlow(root, ["trust", "lock", "--ci", "github"]);
    expect(first.decision).toBe("allow");
    expect(first.infos.some((info) => info.includes(".github/workflows/safeinstall-trust.yml"))).toBe(true);

    const workflow = await readFile(path.join(root, ".github", "workflows", "safeinstall-trust.yml"), "utf8");
    expect(workflow).toContain("safeinstall trust status --require-lock");

    // The workflow the lock just wrote must be part of the baseline, not
    // reported as "added" enforcement drift on the next status.
    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
  });

  it("protects the CI workflow itself: flipping it off is enforcement drift", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock", "--ci", "github"]);

    const workflowPath = path.join(root, ".github", "workflows", "safeinstall-trust.yml");
    await writeFile(workflowPath, "name: neutered\non: [] \n");

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("block");
    expect(status.reasons.some((reason) => reason.code === "trust-enforcement-drift")).toBe(true);
  });

  it("adds CI to an already-locked clean surface without leaving drift", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);

    const added = await runTrustLockFlow(root, ["trust", "lock", "--ci", "github"]);
    expect(added.decision).toBe("allow");
    expect(added.infos.some((info) => info.includes("safeinstall-trust.yml"))).toBe(true);

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
  });

  it("rejects an unsupported --ci provider", async () => {
    const root = await seedProject();
    const result = await runTrustLockFlow(root, ["trust", "lock", "--ci", "jenkins"]);
    expect(result.decision).toBe("error");
    expect(result.reasons[0].code).toBe("trust-invalid-arguments");
  });
});

describe("P1 regression: lock forgery", () => {
  it("detects a lock edited to drop a protected file whose real file was deleted", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);

    // Attacker rewrites the committed lock to remove the hooks entry, then
    // deletes the actual hook file so no plain drift remains.
    const lockPath = path.join(root, ".safeinstall", "trust-surface.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      files: Array<{ path: string }>;
    };
    lock.files = lock.files.filter((file) => file.path !== ".cursor/hooks.json");
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    await rm(path.join(root, ".cursor", "hooks.json"));

    const status = await runTrustStatusFlow(root, ["trust", "status", "--require-lock"]);
    expect(status.decision).toBe("block");
    expect(status.exitCode).toBe(2);
    expect(status.reasons.some((reason) => reason.code === "trust-lock-forged")).toBe(true);
  });

  it("detects a lock downgraded from strict to warn to soften enforcement", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock", "--mode", "strict"]);

    // Attacker downgrades the mode so instruction drift only warns, then
    // edits an instruction file. Without binding mode to the ledger this
    // passed; now the recomputed baseline hash no longer matches.
    const lockPath = path.join(root, ".safeinstall", "trust-surface.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { mode: string };
    lock.mode = "warn";
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
    await writeFile(path.join(root, "AGENTS.md"), "# rules\ninjected instruction\n");

    const status = await runTrustStatusFlow(root, ["trust", "status", "--require-lock"]);
    expect(status.decision).toBe("block");
    expect(status.exitCode).toBe(2);
    expect(status.reasons.some((reason) => reason.code === "trust-lock-forged")).toBe(true);
  });
});

describe("P1b regression: hidden Unicode is never approved", () => {
  it("keeps blocking hidden Unicode even after it was present at (attempted) lock time", async () => {
    const root = await seedProject();
    // Plant the invisible instruction, then try to lock: refused.
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nsecretly\u202eevil\n");
    const lock = await runTrustLockFlow(root, ["trust", "lock"]);
    expect(lock.decision).toBe("error");

    // Clean-lock, then plant hidden Unicode: status must block, not silently
    // treat it as an approved baseline artifact.
    await writeFile(path.join(root, "AGENTS.md"), "# rules\n");
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nsecretly\u202eevil\n");

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("block");
    expect(status.reasons.some((reason) => reason.code === "trust-hidden-unicode")).toBe(true);
  });
});

describe("P2b: unpinned MCP stays visible", () => {
  async function seedUnpinnedMcp(): Promise<string> {
    const root = await createTempDir("safeinstall-unpinned-");
    await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"] } } })
    );
    return root;
  }

  it("warns persistently in warn mode, even with no drift", async () => {
    const root = await seedUnpinnedMcp();
    await runTrustLockFlow(root, ["trust", "lock"]);

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
    expect(status.warnings.some((warning) => warning.includes("Unpinned MCP server"))).toBe(true);
  });

  it("blocks in strict mode", async () => {
    const root = await seedUnpinnedMcp();
    await runTrustLockFlow(root, ["trust", "lock", "--mode", "strict"]);

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("block");
    expect(status.reasons.some((reason) => reason.code === "trust-unpinned-mcp")).toBe(true);
  });
});

describe("Theme A: honest anchor", () => {
  it("self-heals a missing head mirror on a clean verify instead of treating a fresh clone as drift", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    // Simulate a fresh clone of a committed lock: the local mirror is absent.
    await removeLedgerHeadMirror(root);
    expect(await readLedgerHeadMirror(root)).toBeUndefined();

    // A clean status must NOT nag or block — it re-establishes the mirror.
    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
    expect(status.warnings.some((warning) => warning.includes("head mirror"))).toBe(false);
    expect(await readLedgerHeadMirror(root)).toBeDefined();
  });

  it("does not error `trust lock` on a fresh clone whose local mirror is missing", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await removeLedgerHeadMirror(root); // fresh clone

    // Regression guard: the missing mirror must not be reported as drift.
    const relock = await runTrustLockFlow(root, ["trust", "lock"]);
    expect(relock.decision).toBe("allow");
    expect(relock.summary).toContain("already locked");
  });

  it("keeps status read-only: a drifted status run does not mutate the ledger", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, x: true }));

    const ledgerPath = path.join(root, ".safeinstall", "ledger.jsonl");
    const before = await readFile(ledgerPath, "utf8");
    await runTrustStatusFlow(root, ["trust", "status"]);
    await runTrustStatusFlow(root, ["trust", "status"]);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  });

  it("flags a broken ledger chain", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    const ledgerPath = path.join(root, ".safeinstall", "ledger.jsonl");
    const entry = JSON.parse((await readFile(ledgerPath, "utf8")).trim());
    entry.detail = "tampered";
    await writeFile(ledgerPath, `${JSON.stringify(entry)}\n`);

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("block");
    expect(status.reasons.some((reason) => reason.code === "trust-ledger-broken")).toBe(true);
  });
});

describe("trust unlock", () => {
  it("removes lock, ledger, and mirror so the surface is no longer governed", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);

    const unlock = await runTrustUnlockFlow(root, ["trust", "unlock"], { humanGate: approvingGate() });
    expect(unlock.decision).toBe("allow");

    // After unlock, a fresh status reports "not locked", not a lock-removed drift.
    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
    expect(status.summary).toContain("not locked");
  });

  it("clears a stale mirror that would otherwise fire lock-removed forever", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    // Delete only the in-repo lock: the mirror now makes status report lock-removed.
    await rm(path.join(root, ".safeinstall", "trust-surface.lock"));
    const drifted = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(drifted.decision).toBe("block");
    expect(drifted.reasons.some((reason) => reason.code === "trust-lock-removed")).toBe(true);

    // Unlock clears the mirror, restoring a clean "not locked" state.
    await runTrustUnlockFlow(root, ["trust", "unlock"], { humanGate: approvingGate() });
    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
    expect(status.summary).toContain("not locked");
  });

  it("refuses to unlock without an interactive human terminal (agent/CI cannot silently disable it)", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);

    const noTty: HumanGate = {
      async ensureInteractive() {
        throw new Error("no tty");
      },
      async confirm() {
        return true;
      }
    };
    const unlock = await runTrustUnlockFlow(root, ["trust", "unlock"], { humanGate: noTty });
    expect(unlock.decision).toBe("block");
    expect(unlock.reasons[0].code).toBe("trust-unlock-not-interactive");

    // The baseline must still be intact after a refused unlock.
    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
    expect(status.summary).toContain("verified");
  });
});

describe("runTrustStatusFlow", () => {
  it("passes cleanly right after locking", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    const result = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
  });

  it("blocks with exit 2 when an enforcement file changed", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, tampered: true }));

    const result = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(result.decision).toBe("block");
    expect(result.exitCode).toBe(2);
    expect(result.reasons.some((reason) => reason.code === "trust-enforcement-drift")).toBe(true);
  });

  it("blocks on hidden Unicode in an instruction file", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nignore\u202eprevious\n");

    const result = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((reason) => reason.code === "trust-hidden-unicode")).toBe(true);
  });

  it("warns (but does not block) on instruction content drift in warn mode", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nmore guidance\n");

    const result = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(result.decision).toBe("allow");
    expect(result.warnings.some((warning) => warning.includes("AGENTS.md"))).toBe(true);
  });

  it("blocks instruction content drift in strict mode", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock", "--mode", "strict"]);
    await writeFile(path.join(root, "AGENTS.md"), "# rules\nmore guidance\n");

    const result = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(result.decision).toBe("block");
    expect(result.reasons.some((reason) => reason.code === "trust-instruction-drift")).toBe(true);
  });

  it("fails with --require-lock when nothing is locked", async () => {
    const root = await seedProject();
    const result = await runTrustStatusFlow(root, ["trust", "status", "--require-lock"]);
    expect(result.decision).toBe("block");
    expect(result.exitCode).toBe(2);
    expect(result.reasons[0].code).toBe("trust-lock-required");
  });
});

describe("runTrustApproveFlow", () => {
  it("re-baselines after a human confirms, so status passes again", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, changed: true }));

    const approve = await runTrustApproveFlow(root, ["trust", "approve"], { humanGate: approvingGate() });
    expect(approve.decision).toBe("allow");

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("allow");
  });

  it("does not re-baseline when the human declines", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, changed: true }));

    const approve = await runTrustApproveFlow(root, ["trust", "approve"], { humanGate: decliningGate() });
    expect(approve.decision).toBe("block");

    const status = await runTrustStatusFlow(root, ["trust", "status"]);
    expect(status.decision).toBe("block");
  });

  it("refuses when there is no interactive terminal", async () => {
    const root = await seedProject();
    await runTrustLockFlow(root, ["trust", "lock"]);
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, changed: true }));

    const noTty: HumanGate = {
      async ensureInteractive() {
        throw new Error("no tty");
      },
      async confirm() {
        return true;
      }
    };
    const approve = await runTrustApproveFlow(root, ["trust", "approve"], { humanGate: noTty });
    expect(approve.decision).toBe("block");
    expect(approve.reasons[0].code).toBe("trust-approve-not-interactive");
  });
});
