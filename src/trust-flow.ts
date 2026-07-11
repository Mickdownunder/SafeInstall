import { createReadStream, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { cliVersionWarning } from "./cli-version";
import { loadConfig } from "./config";
import { formatCommand } from "./output";
import { parseCiProvider, scaffoldCiWorkflow } from "./trust-ci";
import type { CiProvider } from "./trust-ci";
import {
  appendLedgerEntry,
  removeLedgerHeadMirror,
  resetLedger,
  verifyLedgerChain
} from "./trust-ledger";
import {
  checkTrustSurface,
  computeBaselineHash,
  detectHiddenUnicode,
  findTrustContext,
  readTrustLock,
  snapshotTrustSurface,
  trustLedgerPath,
  trustLockPath,
  writeTrustLock,
  TRUST_LOCK_RELATIVE_PATH
} from "./trust-surface";
import type { TrustSurfaceLock, TrustSurfaceMode, TrustSurfaceSnapshot } from "./trust-surface";
import type { CliReason, CliResult } from "./types";

/**
 * `safeinstall trust <lock|status|approve>` — manage the Agent Trust Surface
 * baseline. `lock` creates the baseline, `status` reconciles (the CI entry
 * point), `approve` re-baselines after human review.
 *
 * `approve` is human-gated: it reads its confirmation from the controlling
 * terminal (/dev/tty), never from stdin, so agent-piped input goes nowhere,
 * and it refuses to run in CI or known agent-hook contexts. This raises the
 * bar substantially — an agent would have to orchestrate a pseudo-terminal —
 * but it is not proof of human presence, and is documented as such.
 */

type TrustSubcommand = "lock" | "status" | "approve" | "unlock";

/**
 * Environment markers of contexts where a human is not at the keyboard.
 * CODEX_SHELL is set by Codex in every shell it spawns (verified empirically
 * against a live Codex session); CODEX_HOME is deliberately NOT listed — a
 * human's own shell may export it for configuration, and a false refusal
 * there would train users to bypass the gate.
 */
const NON_HUMAN_ENV_MARKERS = ["CI", "CLAUDECODE", "CODEX_SHELL", "CURSOR_AGENT"];

export interface HumanGate {
  /** Throws with an explanation when no interactive human context exists. */
  ensureInteractive(): Promise<void>;
  /** Ask a yes/no question on the controlling terminal. */
  confirm(promptText: string): Promise<boolean>;
}

function nonHumanMarker(): string | undefined {
  return NON_HUMAN_ENV_MARKERS.find((name) => {
    const value = process.env[name];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  });
}

export function createTtyHumanGate(): HumanGate {
  return {
    async ensureInteractive(): Promise<void> {
      const marker = nonHumanMarker();
      if (marker) {
        throw new Error(
          `safeinstall trust approve refuses to run here (${marker} is set). ` +
            "Approval must come from a human at an interactive terminal."
        );
      }
      if (process.platform === "win32") {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error(
            "safeinstall trust approve requires an interactive terminal. Run it directly in a console window."
          );
        }
        return;
      }
      try {
        openSync("/dev/tty", "r");
      } catch {
        throw new Error(
          "safeinstall trust approve requires a controlling terminal (/dev/tty) and cannot run " +
            "non-interactively, from CI, or from an agent hook. Run it in your own terminal."
        );
      }
    },

    confirm(promptText: string): Promise<boolean> {
      // Read from the controlling terminal, never from stdin: input piped by
      // a program (or an agent) does not reach /dev/tty.
      const input =
        process.platform === "win32" ? process.stdin : createReadStream("", { fd: openSync("/dev/tty", "r") });
      const rl = readline.createInterface({ input, output: process.stderr });
      return new Promise((resolve) => {
        rl.question(promptText, (answer) => {
          rl.close();
          if (input !== process.stdin) {
            input.destroy();
          }
          resolve(answer.trim().toLowerCase() === "yes");
        });
      });
    }
  };
}

function baselineHashFor(mode: TrustSurfaceMode, snapshot: TrustSurfaceSnapshot): string {
  return computeBaselineHash({
    schemaVersion: 1,
    mode,
    files: snapshot.files,
    mcpServers: snapshot.mcpServers
  });
}

function baseResult(argv: string[], overrides: Partial<CliResult>): CliResult {
  return {
    mode: "trust",
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "",
    command: argv,
    commandString: formatCommand("safeinstall", argv),
    reasons: [],
    summary: "",
    warnings: [],
    infos: [],
    affectedPackages: [],
    ...overrides
  };
}

function parseMode(argv: string[]): TrustSurfaceMode | Error {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    let value: string | undefined;
    if (token === "--mode") {
      value = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--mode=")) {
      value = token.slice("--mode=".length);
    } else {
      continue;
    }
    if (value !== "warn" && value !== "strict") {
      return new Error(`Unsupported --mode value ${JSON.stringify(value ?? "")}. Supported: warn, strict.`);
    }
    return value;
  }
  return "warn";
}

function describeSnapshot(snapshot: TrustSurfaceSnapshot): string[] {
  const infos = snapshot.files.map((file) => `Locked: ${file.path} (${file.kind})`);
  for (const server of snapshot.mcpServers) {
    const pinNote = server.unpinned ? " — WARNING: unpinned version, server code can change upstream" : "";
    infos.push(`Locked MCP server: "${server.name}" in ${server.source}${pinNote}`);
  }
  return infos;
}

function baselineWarnings(snapshot: TrustSurfaceSnapshot): string[] {
  const warnings: string[] = [];
  for (const server of snapshot.mcpServers) {
    if (server.unpinned) {
      warnings.push(
        `MCP server "${server.name}" in ${server.source} has no pinned version. ` +
          "Pin an exact version so upstream changes cannot alter the server silently."
      );
    }
  }
  return warnings;
}

/**
 * Files carrying hidden Unicode. A baseline must never contain invisible
 * characters — they have no legitimate purpose in agent instruction or config
 * files, so `lock`/`approve` refuse rather than "approving" the injection.
 */
function hiddenUnicodeReasons(snapshot: TrustSurfaceSnapshot): CliReason[] {
  return snapshot.files
    .filter((file) => file.hiddenUnicode.length > 0)
    .map((file) => ({
      code: "trust-hidden-unicode",
      message: `${file.path} contains hidden Unicode (${file.hiddenUnicode.join(", ")}).`,
      suggestion:
        "Remove the invisible characters before locking. They cannot be part of a trusted baseline — invisible characters in agent files are a known injection vector."
    }));
}

async function writeBaseline(
  root: string,
  mode: TrustSurfaceMode,
  snapshot: TrustSurfaceSnapshot,
  event: "lock-created" | "approved",
  freshChain: boolean
): Promise<void> {
  const detail = `${event}:${baselineHashFor(mode, snapshot)}`;
  const head = freshChain ? await resetLedger(root, event, detail) : await appendLedgerEntry(root, event, detail);
  const lock: TrustSurfaceLock = {
    schemaVersion: 1,
    mode,
    files: snapshot.files,
    mcpServers: snapshot.mcpServers,
    approvedAt: new Date().toISOString(),
    ledgerHead: head
  };
  await writeTrustLock(root, lock);
}

export async function runTrustLockFlow(cwd: string, argv: string[]): Promise<CliResult> {
  const mode = parseMode(argv.slice(2));
  if (mode instanceof Error) {
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Invalid trust lock arguments.",
      reasons: [{ code: "trust-invalid-arguments", message: mode.message }],
      summary: "Trust lock failed."
    });
  }

  const ciProvider = parseCiProvider(argv.slice(2));
  if (ciProvider instanceof Error) {
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Invalid trust lock arguments.",
      reasons: [{ code: "trust-invalid-arguments", message: ciProvider.message }],
      summary: "Trust lock failed."
    });
  }

  const existing = await findTrustContext(cwd);
  if (existing) {
    const status = await checkTrustSurface(cwd);
    if (status.findings.length === 0 && status.instructionWarnings.length === 0) {
      // Adding CI to an already-locked, clean surface: scaffold the workflow,
      // then re-baseline so the new (tracked) workflow file is part of the
      // baseline instead of showing up as "added" enforcement drift. This is
      // safe — the clean check above already proved nothing else drifted, and
      // an agent-smuggled change would have failed that check.
      if (ciProvider && status.mode) {
        const ciInfos = await scaffoldCi(existing.root, ciProvider);
        const rebaselined = await snapshotTrustSurface(existing.root);
        await writeBaseline(existing.root, status.mode, rebaselined, "approved", false);
        return baseResult(argv, {
          exitCodeMeaning: "The trust surface is already locked; CI re-verification was added.",
          summary: `Trust surface already locked (${trustLockPath(existing.root)}). Added CI re-verification.`,
          infos: ciInfos
        });
      }
      return baseResult(argv, {
        exitCodeMeaning: "The trust surface is already locked and matches the baseline.",
        summary: `Trust surface already locked (${trustLockPath(existing.root)}). Baseline unchanged.`
      });
    }
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "The trust surface is already locked and has drifted.",
      reasons: [
        ...status.findings.map((finding) => ({ code: `trust-${finding.kind}`, message: finding.message })),
        ...status.instructionWarnings.map((message) => ({ code: "trust-instruction-drift", message }))
      ],
      summary:
        "Trust surface already locked and the current state differs from the baseline. " +
        "Review the drift and run `safeinstall trust approve` in your terminal.",
      warnings: []
    });
  }

  const root = cwd;
  const preScaffold = await snapshotTrustSurface(root);
  if (preScaffold.files.length === 0 && preScaffold.mcpServers.length === 0) {
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "There is nothing to lock in this directory.",
      reasons: [
        {
          code: "trust-nothing-to-lock",
          message:
            "No trust-surface files found (safeinstall.config.json, agent hook configs, rules files, MCP configs).",
          suggestion: "Run `safeinstall guard install` and `safeinstall init` first, then lock the surface."
        }
      ],
      summary: "Trust lock failed: nothing to lock."
    });
  }

  // Refuse before scaffolding so a failed lock never leaves an orphan workflow.
  const tainted = hiddenUnicodeReasons(preScaffold);
  if (tainted.length > 0) {
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "The trust surface cannot be locked while it contains hidden Unicode.",
      reasons: tainted,
      summary: "Trust lock refused: hidden Unicode present."
    });
  }

  // Scaffold the CI workflow BEFORE the baseline snapshot so the workflow file
  // — part of the tracked enforcement surface — is captured in this baseline
  // rather than appearing as drift on the next status run.
  const ciInfos = ciProvider ? await scaffoldCi(root, ciProvider) : [];
  const snapshot = ciProvider ? await snapshotTrustSurface(root) : preScaffold;

  await writeBaseline(root, mode, snapshot, "lock-created", true);

  return baseResult(argv, {
    exitCodeMeaning: "The trust surface baseline was created.",
    summary: `Trust surface locked (${snapshot.files.length} file(s), ${snapshot.mcpServers.length} MCP server(s), mode: ${mode}). Commit ${TRUST_LOCK_RELATIVE_PATH} so CI can re-verify it.`,
    infos: [...describeSnapshot(snapshot), ...ciInfos],
    warnings: baselineWarnings(snapshot),
    details: { root, lockPath: trustLockPath(root) }
  });
}

/**
 * Scaffold the CI re-verification workflow and describe the outcome. Kept
 * non-fatal: a scaffolding hiccup must not fail an otherwise-successful lock.
 */
async function scaffoldCi(root: string, provider: CiProvider): Promise<string[]> {
  try {
    const result = await scaffoldCiWorkflow(root, provider);
    if (result.status === "created") {
      return [
        `CI: wrote ${result.path} (pins safeinstall-cli@${result.pinnedVersion} by sha512 content hash). Commit it, and make it a required status check with review of .safeinstall/ — only then does the re-verification actually gate merges.`
      ];
    }
    return [
      `CI: ${result.path} already exists; left it untouched. Ensure it runs \`safeinstall trust status --require-lock\` on a version that has the trust command.`
    ];
  } catch (error) {
    return [
      `CI: could not write the workflow (${error instanceof Error ? error.message : String(error)}). The lock itself succeeded, but the CI anchor is missing — re-run \`safeinstall trust lock --ci ${provider}\` once the registry is reachable.`
    ];
  }
}

export interface TrustStatusOptions {
  /** When set, the absence of a trust lock is a failure (CI usage). */
  requireLock?: boolean;
}

/**
 * The `minimumCliVersion` claim, rendered for `trust status`. Status is a
 * read-only diagnostic that never loaded the config before this feature, so a
 * config parse failure surfaces as a warning line here instead of failing the
 * reconciliation — the policy-evaluating flows (install/check) are where
 * config errors fail closed.
 */
async function cliVersionStatusLines(cwd: string): Promise<{ infos: string[]; warnings: string[] }> {
  try {
    const { config } = await loadConfig(cwd);
    const warning = cliVersionWarning(config.minimumCliVersion);
    return { infos: warning ? [warning] : [], warnings: [] };
  } catch (error) {
    return {
      infos: [],
      warnings: [
        `Could not evaluate minimumCliVersion: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
}

export async function runTrustStatusFlow(
  cwd: string,
  argv: string[],
  options: TrustStatusOptions = {}
): Promise<CliResult> {
  const requireLock = options.requireLock || argv.includes("--require-lock");
  const status = await checkTrustSurface(cwd);
  const cliVersion = await cliVersionStatusLines(cwd);

  if (!status.active) {
    if (requireLock) {
      return baseResult(argv, {
        decision: "block",
        exitCode: 2,
        exitCodeMeaning: "No trust lock exists, but one is required here.",
        reasons: [
          {
            code: "trust-lock-required",
            message: "No trust-surface lock was found, and --require-lock is set.",
            suggestion: "Run `safeinstall trust lock` and commit .safeinstall/ to the repository."
          }
        ],
        summary: "Trust status failed: no lock.",
        warnings: cliVersion.warnings,
        infos: cliVersion.infos
      });
    }
    return baseResult(argv, {
      exitCodeMeaning: "No trust lock governs this directory.",
      summary: "Trust surface not locked. Run `safeinstall trust lock` to create a baseline.",
      warnings: cliVersion.warnings,
      infos: cliVersion.infos
    });
  }

  if (status.findings.length > 0) {
    // `trust status` is read-only by design: it must not mutate committed
    // files (that would dirty the working tree in CI and grow the ledger
    // unboundedly on every drifted run). Detection is reported, not recorded.
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "The trust surface has drifted from the approved baseline.",
      reasons: status.findings.map((finding) => ({ code: `trust-${finding.kind}`, message: finding.message })),
      summary: "Trust surface drift detected.",
      warnings: [...cliVersion.warnings, ...status.instructionWarnings],
      infos: cliVersion.infos,
      details: { root: status.root, drift: status.drift }
    });
  }

  return baseResult(argv, {
    exitCodeMeaning: "The trust surface matches the approved baseline.",
    summary: `Trust surface verified: ${status.lock?.files.length ?? 0} file(s), ${status.lock?.mcpServers.length ?? 0} MCP server(s) match the baseline (mode: ${status.mode}).`,
    warnings: [...cliVersion.warnings, ...status.instructionWarnings],
    infos: cliVersion.infos,
    details: { root: status.root }
  });
}

/** Render the lines of a file that contain hidden Unicode, escaped visibly. */
async function renderHiddenUnicodeLines(root: string, relativePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path.join(root, ...relativePath.split("/")), "utf8");
  } catch {
    return [];
  }
  const rendered: string[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (detectHiddenUnicode(lines[index]).length === 0) {
      continue;
    }
    const escaped = [...lines[index]]
      .map((char) => {
        const codePoint = char.codePointAt(0) as number;
        return detectHiddenUnicode(char).length > 0
          ? `\\u{${codePoint.toString(16).toUpperCase()}}`
          : char;
      })
      .join("");
    rendered.push(`  ${relativePath}:${index + 1}: ${escaped}`);
  }
  return rendered;
}

export interface TrustApproveOptions {
  /** Test seam. Production always uses the real /dev/tty gate. */
  humanGate?: HumanGate;
}

export async function runTrustApproveFlow(
  cwd: string,
  argv: string[],
  options: TrustApproveOptions = {}
): Promise<CliResult> {
  const gate = options.humanGate ?? createTtyHumanGate();

  const context = await findTrustContext(cwd);
  if (!context) {
    return baseResult(argv, {
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "There is no trust lock to approve against.",
      reasons: [
        {
          code: "trust-not-locked",
          message: "No trust-surface lock was found for this directory.",
          suggestion: "Run `safeinstall trust lock` to create the baseline first."
        }
      ],
      summary: "Trust approve failed: not locked."
    });
  }

  const status = await checkTrustSurface(cwd);
  if (status.findings.length === 0 && status.instructionWarnings.length === 0) {
    return baseResult(argv, {
      exitCodeMeaning: "The trust surface already matches the baseline.",
      summary: "Nothing to approve: the trust surface matches the approved baseline."
    });
  }

  try {
    await gate.ensureInteractive();
  } catch (error) {
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Trust approval requires an interactive human terminal.",
      reasons: [
        {
          code: "trust-approve-not-interactive",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      summary: "Trust approve refused."
    });
  }

  const root = context.root;
  const mode = status.mode ?? (await readTrustLock(root).then((lock) => lock.mode).catch(() => "warn" as const));
  const snapshot = await snapshotTrustSurface(root);

  const tainted = hiddenUnicodeReasons(snapshot);
  if (tainted.length > 0) {
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "The trust surface cannot be approved while it contains hidden Unicode.",
      reasons: tainted,
      summary: "Trust approve refused: hidden Unicode present. Remove the invisible characters first."
    });
  }

  const displayedHash = baselineHashFor(mode, snapshot);

  const reviewLines: string[] = [
    "SafeInstall trust surface review",
    `Project: ${root}`,
    ""
  ];
  for (const finding of status.findings) {
    reviewLines.push(`- ${finding.message}`);
  }
  for (const warning of status.instructionWarnings) {
    reviewLines.push(`- ${warning}`);
  }

  const unicodePaths = new Set<string>([
    ...(status.drift?.newHiddenUnicode.map((entry) => entry.path) ?? []),
    ...snapshot.files.filter((file) => file.hiddenUnicode.length > 0).map((file) => file.path)
  ]);
  if (unicodePaths.size > 0) {
    reviewLines.push("", "Hidden Unicode, rendered visibly:");
    for (const relativePath of unicodePaths) {
      reviewLines.push(...(await renderHiddenUnicodeLines(root, relativePath)));
    }
  }

  reviewLines.push("", `New baseline hash: ${displayedHash}`, "");
  process.stderr.write(`${reviewLines.join("\n")}\n`);

  const confirmed = await gate.confirm(
    "Approve this state as the new trusted baseline? Type 'yes' to approve: "
  );
  if (!confirmed) {
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "The human reviewer did not approve the new baseline.",
      reasons: [{ code: "trust-approve-declined", message: "Approval was declined at the terminal." }],
      summary: "Trust approve declined."
    });
  }

  // The approval binds to exactly the reviewed state: if the surface changed
  // between review and confirmation, abort instead of baselining unseen data.
  const recheck = await snapshotTrustSurface(root);
  if (baselineHashFor(mode, recheck) !== displayedHash) {
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "The trust surface changed while approval was pending.",
      reasons: [
        {
          code: "trust-approve-race",
          message: "The trust surface changed between review and confirmation. Nothing was approved — review again."
        }
      ],
      summary: "Trust approve aborted."
    });
  }

  const chain = await verifyLedgerChain(root);
  await writeBaseline(root, mode, snapshot, "approved", chain.status !== "ok");

  return baseResult(argv, {
    exitCodeMeaning: "The new trust-surface baseline was approved.",
    summary: `Trust surface re-baselined (${snapshot.files.length} file(s), ${snapshot.mcpServers.length} MCP server(s)). Commit the updated ${TRUST_LOCK_RELATIVE_PATH}.`,
    infos: describeSnapshot(snapshot),
    warnings: baselineWarnings(snapshot),
    details: { root, lockPath: trustLockPath(root) }
  });
}

export interface TrustUnlockOptions {
  /** Test seam. Production always uses the real /dev/tty gate. */
  humanGate?: HumanGate;
}

/**
 * Remove the trust baseline for this project: the lock, the in-repo ledger, and
 * the out-of-workspace head mirror (which also clears a stale mirror that would
 * otherwise keep firing `lock-removed`).
 *
 * Unlock RELAXES enforcement to "not locked", so — like `approve` — it is
 * human-gated: it refuses to run from CI or a known agent-hook context and
 * requires a controlling terminal. This closes the asymmetry where the guard
 * denies a raw `rm .safeinstall/...` yet the equivalent CLI command could be
 * driven by an agent to silently disable the surface. The durable anchor is
 * still CI re-verifying the committed lock; gating unlock removes the easy
 * in-session kill switch.
 */
export async function runTrustUnlockFlow(
  cwd: string,
  argv: string[],
  options: TrustUnlockOptions = {}
): Promise<CliResult> {
  const context = await findTrustContext(cwd);
  if (!context) {
    return baseResult(argv, {
      exitCodeMeaning: "There was no trust baseline to remove.",
      summary: "Trust surface is not locked; nothing to unlock."
    });
  }

  const gate = options.humanGate ?? createTtyHumanGate();
  try {
    await gate.ensureInteractive();
  } catch (error) {
    return baseResult(argv, {
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Unlocking the trust surface requires an interactive human terminal.",
      reasons: [
        {
          code: "trust-unlock-not-interactive",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      summary: "Trust unlock refused."
    });
  }

  const root = context.root;
  await rm(trustLockPath(root), { force: true });
  await rm(trustLedgerPath(root), { force: true });
  await removeLedgerHeadMirror(root);

  return baseResult(argv, {
    exitCodeMeaning: "The trust baseline was removed.",
    summary: `Trust surface unlocked (removed ${TRUST_LOCK_RELATIVE_PATH}, the ledger, and the head mirror). Run \`safeinstall trust lock\` to re-establish a baseline.`,
    details: { root }
  });
}

export function isTrustSubcommand(value: string | undefined): value is TrustSubcommand {
  return value === "lock" || value === "status" || value === "approve" || value === "unlock";
}

export async function runTrustFlow(
  cwd: string,
  argv: string[],
  options: TrustApproveOptions & TrustStatusOptions = {}
): Promise<CliResult> {
  const subcommand = argv[1];
  if (subcommand === "lock") {
    return runTrustLockFlow(cwd, argv);
  }
  if (subcommand === "status") {
    return runTrustStatusFlow(cwd, argv, options);
  }
  if (subcommand === "unlock") {
    return runTrustUnlockFlow(cwd, argv, options);
  }
  return runTrustApproveFlow(cwd, argv, options);
}
