import {
  checkLedgerMirror,
  verifyLedgerChain,
  writeLedgerHeadMirror
} from "./trust-ledger";
import {
  computeBaselineHash,
  computeTrustSurfaceDrift,
  findTrustContext,
  readTrustLock,
  snapshotTrustSurface,
  trustLedgerPath,
  trustLockPath
} from "./trust-surface";
import type {
  TrustFinding,
  TrustSurfaceFileDrift,
  TrustSurfaceLock,
  TrustSurfaceMcpDrift,
  TrustSurfaceStatus
} from "./trust-surface";
import type { CliReason } from "./types";

/**
 * Trust-surface reconciliation and presentation — the orchestration layer over
 * the data model in trust-surface.ts (snapshot, drift, lock I/O, ledger). It
 * locates a lock, hashes the current state, verifies the ledger chain and its
 * out-of-workspace mirror, and classifies every deviation into findings that
 * the guard and CLI flows act on. Kept separate so the data model stays free of
 * presentation and finding-classification concerns.
 */

function describeFileDrift(drift: TrustSurfaceFileDrift): string {
  switch (drift.change) {
    case "added":
      return `${drift.path} appeared (not in the trust baseline)`;
    case "removed":
      return `${drift.path} was removed`;
    case "modified":
      return `${drift.path} was modified`;
  }
}

function describeMcpDrift(drift: TrustSurfaceMcpDrift): string {
  const extras: string[] = [];
  if (drift.envKeysAdded.length > 0) {
    extras.push(`new env keys: ${drift.envKeysAdded.join(", ")}`);
  }
  if (drift.unpinned) {
    extras.push("unpinned version — the server code can change upstream without any config drift");
  }
  const suffix = extras.length > 0 ? ` (${extras.join("; ")})` : "";
  return `MCP server "${drift.name}" in ${drift.source} was ${drift.change}${suffix}`;
}

/**
 * Full trust-surface reconciliation for a directory: locate the lock, hash
 * the current state, verify the ledger chain and its out-of-workspace head
 * mirror, and classify every deviation into findings.
 */
export async function checkTrustSurface(startDir: string): Promise<TrustSurfaceStatus> {
  const context = await findTrustContext(startDir);
  if (!context) {
    return { active: false, findings: [], instructionWarnings: [] };
  }

  if (!context.hasLock) {
    return {
      active: true,
      root: context.root,
      findings: [
        {
          kind: "lock-removed",
          message:
            `The trust lock at ${trustLockPath(context.root)} is gone, but this project has a recorded ` +
            "trust baseline. Deleting the lock does not disable the trust surface."
        }
      ],
      instructionWarnings: []
    };
  }

  let lock: TrustSurfaceLock;
  try {
    lock = await readTrustLock(context.root);
  } catch (error) {
    return {
      active: true,
      root: context.root,
      findings: [
        {
          kind: "lock-unreadable",
          message: `The trust lock could not be read: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      instructionWarnings: []
    };
  }

  const snapshot = await snapshotTrustSurface(context.root);
  const drift = computeTrustSurfaceDrift(lock, snapshot);
  const findings: TrustFinding[] = [];
  const instructionWarnings: string[] = [];

  for (const fileDrift of drift.files) {
    const description = describeFileDrift(fileDrift);
    if (fileDrift.kind === "enforcement") {
      findings.push({ kind: "enforcement-drift", message: `Enforcement surface drift: ${description}.` });
    } else if (fileDrift.kind === "tool") {
      findings.push({ kind: "tool-drift", message: `Tool surface drift: ${description}.` });
    } else if (lock.mode === "strict") {
      findings.push({ kind: "instruction-drift", message: `Instruction surface drift: ${description}.` });
    } else {
      instructionWarnings.push(`Instruction surface drift: ${description}.`);
    }
  }

  for (const mcpDrift of drift.mcpServers) {
    findings.push({ kind: "tool-drift", message: `Tool surface drift: ${describeMcpDrift(mcpDrift)}.` });
  }

  for (const unicodeFinding of drift.newHiddenUnicode) {
    findings.push({
      kind: "hidden-unicode",
      message:
        `Hidden Unicode characters appeared in ${unicodeFinding.path}: ${unicodeFinding.codes.join(", ")}. ` +
        "Invisible characters in agent instruction or config files are a known injection vector."
    });
  }

  // Unpinned MCP servers are a standing rug-pull risk (the server code can
  // change upstream without any config drift), so surface them on every
  // reconciliation, not only at lock time. Strict mode blocks; warn mode
  // keeps it visible as a warning.
  for (const server of snapshot.mcpServers) {
    if (!server.unpinned) {
      continue;
    }
    const message =
      `Unpinned MCP server "${server.name}" in ${server.source}: no fixed version, so the server code ` +
      "can change upstream without any config change. Pin an exact version.";
    if (lock.mode === "strict") {
      findings.push({ kind: "unpinned-mcp", message });
    } else {
      instructionWarnings.push(message);
    }
  }

  const chain = await verifyLedgerChain(context.root);
  if (chain.status !== "ok") {
    findings.push({
      kind: "ledger-broken",
      message: `The trust ledger at ${trustLedgerPath(context.root)} is ${chain.status === "missing" ? "missing" : "broken"}.`
    });
  } else {
    // The lock must reference a baseline entry in the chain, and no later
    // baseline entry (lock-created / approved) may exist after it.
    const entries = chain.entries ?? [];
    const lockIndex = entries.findIndex((entry) => entry.hash === lock.ledgerHead);
    const staleBaseline =
      lockIndex === -1 ||
      entries.slice(lockIndex + 1).some((entry) => entry.event === "lock-created" || entry.event === "approved");
    if (staleBaseline) {
      findings.push({
        kind: "ledger-mismatch",
        message: "The trust lock does not reference the current baseline entry of the trust ledger."
      });
    } else {
      // Bind the lock's CONTENT to the ledger: the baseline entry recorded the
      // hash of the exact files/mcpServers list at approval time. Editing the
      // committed lock (e.g. dropping a protected file so its deletion is not
      // seen as drift) changes this hash but cannot change the hash-chained
      // ledger entry without breaking the chain.
      const baselineEntry = entries[lockIndex];
      if (baselineEntry === undefined) {
        // Invariant: this branch runs only when staleBaseline is false, which
        // requires lockIndex !== -1 (a valid findIndex result), so the entry exists.
        throw new Error("invariant violated: baseline ledger entry missing for a resolved lockIndex.");
      }
      const recordedHash = baselineEntry.detail.slice(baselineEntry.detail.indexOf(":") + 1);
      if (recordedHash !== computeBaselineHash(lock)) {
        findings.push({
          kind: "lock-forged",
          message:
            "The trust lock's baseline does not match the hash recorded in the ledger. " +
            "The lock file was edited after it was approved."
        });
      }

      const mirror = await checkLedgerMirror(context.root, chain.head as string, entries);
      if (mirror === "mismatch") {
        findings.push({
          kind: "mirror-mismatch",
          message:
            "The trust ledger does not match the recorded head outside the workspace. " +
            "The in-repo ledger and lock may have been rewritten."
        });
      } else if (mirror === "missing") {
        // A fresh clone of a committed lock legitimately has no local mirror,
        // and a deleted mirror looks identical — the two are indistinguishable
        // locally, and the mirror is explicitly NOT the anchor (the committed
        // lock + CI re-verify is). So self-heal: establish the mirror from the
        // verified head rather than nagging (a warning here broke `trust lock`
        // and `approve` on every fresh clone, since they treat any warning as
        // drift) or blocking (which would break clones outright). Best-effort
        // and out-of-tree: a read-only state dir just leaves it missing for a
        // later run, never turning a benign clone into a failure.
        await writeLedgerHeadMirror(context.root, chain.head as string).catch(() => {
          /* state dir not writable — retry on a later run */
        });
      }
    }
  }

  return {
    active: true,
    root: context.root,
    mode: lock.mode,
    lock,
    snapshot,
    drift,
    findings,
    instructionWarnings
  };
}

/**
 * Split findings by required guard response: lockdown findings deny every
 * agent command; tool findings deny installs and runners until approval.
 */
export function partitionTrustFindings(findings: TrustFinding[]): {
  lockdown: TrustFinding[];
  tool: TrustFinding[];
} {
  const lockdown: TrustFinding[] = [];
  const tool: TrustFinding[] = [];
  for (const finding of findings) {
    if (finding.kind === "tool-drift" || finding.kind === "unpinned-mcp") {
      tool.push(finding);
    } else {
      lockdown.push(finding);
    }
  }
  return { lockdown, tool };
}

/**
 * Trust-surface precheck for the install and check flows: every CLI
 * invocation reconciles, so a deleted guard hook (which silences the guard
 * itself) is still caught the next time SafeInstall runs. Returns block
 * reasons when the surface has drifted, plus non-blocking warnings (warn-mode
 * instruction drift, unpinned MCP servers) so they are surfaced rather than
 * silently dropped. Empty when clean or not locked.
 */
export async function trustSurfacePrecheck(
  cwd: string
): Promise<{ reasons: CliReason[]; warnings: string[] }> {
  let status: TrustSurfaceStatus;
  try {
    status = await checkTrustSurface(cwd);
  } catch (error) {
    // A read error during reconciliation (e.g. a file rotating under us) must
    // fail closed as a clean policy block, not crash the whole command with an
    // unhandled error. Mirrors the guard, which denies rather than throwing.
    return {
      reasons: [
        {
          code: "trust-verification-failed",
          message: `SafeInstall could not verify the Agent Trust Surface (${error instanceof Error ? error.message : String(error)}).`,
          suggestion: "Retry; if it persists, run `safeinstall trust status` to inspect the trust surface."
        }
      ],
      warnings: []
    };
  }

  if (!status.active) {
    return { reasons: [], warnings: [] };
  }
  return {
    reasons: status.findings.map((finding) => ({
      code: `trust-${finding.kind}`,
      message: finding.message,
      suggestion:
        "Review the drift with `safeinstall trust status`. If the change is intentional, approve it with `safeinstall trust approve` in your terminal."
    })),
    warnings: status.instructionWarnings
  };
}
