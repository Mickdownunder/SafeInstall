import { writeFile } from "node:fs/promises";
import path from "node:path";

import { createDefaultConfig, getConfigPath, serializeConfig } from "./config";
import { describeGuardTarget, runGuardSetupFlow } from "./guard-setup";
import type { GuardSetupClient, GuardSetupTargetResult } from "./guard-setup";
import { formatCommand } from "./output";
import { fileExists } from "./project-discovery";
import { runTrustLockFlow } from "./trust-flow";
import type { CliReason, CliResult } from "./types";

/**
 * `safeinstall init` — one command that takes a project from zero to
 * protected: starter policy config, guard hooks for the agents that are
 * actually present in the project, and a trust-surface baseline over the
 * result — in that order, because the lock must hash the hook files the
 * guard step just wrote.
 *
 * Every step is idempotent and fail-closed on re-runs: an existing config
 * is kept (unless --force), an existing guard entry is skipped, and an
 * existing trust lock is never re-baselined — drift aborts init with the
 * trust findings instead of blessing a tampered surface with a new lock.
 */

export interface InitOptions {
  force: boolean;
  guard: boolean;
  lock: boolean;
  /** Explicit --client list; undefined means detect from the project. */
  clients?: GuardSetupClient[];
  /** Forwarded to `trust lock`; the lock flow defaults to "warn". */
  mode?: "warn" | "strict";
}

export function parseInitOptions(argv: string[]): InitOptions | Error {
  const options: InitOptions = { force: false, guard: true, lock: true };
  const clients: GuardSetupClient[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--force") {
      options.force = true;
      continue;
    }
    if (token === "--no-guard") {
      options.guard = false;
      continue;
    }
    if (token === "--no-lock") {
      options.lock = false;
      continue;
    }

    let clientValue: string | undefined;
    let modeValue: string | undefined;
    if (token === "--client") {
      clientValue = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--client=")) {
      clientValue = token.slice("--client=".length);
    } else if (token === "--mode") {
      modeValue = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--mode=")) {
      modeValue = token.slice("--mode=".length);
    } else {
      return new Error(
        `Unknown init option ${JSON.stringify(token)}. Supported: --force, --client <claude,codex,cursor>, --no-guard, --no-lock, --mode <warn|strict>.`
      );
    }

    if (clientValue !== undefined || (token === "--client" && clientValue === undefined)) {
      if (!clientValue) {
        return new Error("--client requires a value (claude, cursor, or a comma-separated list).");
      }
      for (const entry of clientValue.split(",").map((part) => part.trim()).filter(Boolean)) {
        if (entry !== "claude" && entry !== "codex" && entry !== "cursor") {
          return new Error(`Unsupported --client value ${JSON.stringify(entry)}. Supported: claude, codex, cursor.`);
        }
        if (!clients.includes(entry)) {
          clients.push(entry);
        }
      }
      continue;
    }

    if (modeValue !== "warn" && modeValue !== "strict") {
      return new Error(`Unsupported --mode value ${JSON.stringify(modeValue ?? "")}. Supported: warn, strict.`);
    }
    options.mode = modeValue;
  }

  if (clients.length > 0) {
    options.clients = clients;
  }
  return options;
}

/**
 * Files or directories whose presence means an agent is used in this
 * project, even before it has any hook configuration.
 */
const AGENT_MARKERS: Record<GuardSetupClient, string[]> = {
  claude: [".claude", "CLAUDE.md"],
  codex: [".codex", "AGENTS.md"],
  cursor: [".cursor", ".cursorrules"]
};

async function detectClients(cwd: string): Promise<GuardSetupClient[]> {
  const detected: GuardSetupClient[] = [];
  for (const client of Object.keys(AGENT_MARKERS) as GuardSetupClient[]) {
    const checks = await Promise.all(
      AGENT_MARKERS[client].map((marker) => fileExists(path.join(cwd, marker)))
    );
    if (checks.some(Boolean)) {
      detected.push(client);
    }
  }
  return detected;
}

interface InitState {
  argv: string[];
  infos: string[];
  warnings: string[];
  details: Record<string, unknown>;
}

function initFailure(state: InitState, reasons: CliReason[], summary: string, exitCode = 1): CliResult {
  return {
    mode: "init",
    decision: "error",
    exitCode,
    exitCodeMeaning: "SafeInstall init stopped before the project was fully protected.",
    command: state.argv,
    commandString: formatCommand("safeinstall", state.argv),
    reasons,
    summary,
    warnings: state.warnings,
    infos: state.infos,
    affectedPackages: [],
    details: state.details
  };
}

export async function runInitFlow(cwd: string, argv: string[], options: InitOptions): Promise<CliResult> {
  const state: InitState = { argv, infos: [], warnings: [], details: {} };

  // 1. Policy config — keep an existing one unless --force asks to replace it.
  const configPath = getConfigPath(cwd);
  const configExisted = await fileExists(configPath);
  const writeConfigFile = !configExisted || options.force;
  if (writeConfigFile) {
    await writeFile(configPath, serializeConfig(createDefaultConfig()), "utf8");
    state.infos.push(configExisted ? `Config: overwrote ${configPath}.` : `Config: created ${configPath}.`);
    state.warnings.push(
      "Edit allowedScripts, allowedSources, or allowedPackages only when you intend to trust that exception."
    );
  } else {
    state.infos.push(`Config: kept existing ${configPath} (use --force to overwrite).`);
  }
  state.details.configPath = configPath;
  state.details.overwritten = configExisted && writeConfigFile;

  // 2. Guard hooks — for the agents that are present, before the lock runs.
  let guardSummary = "skipped";
  if (!options.guard) {
    state.infos.push("Guard: skipped (--no-guard).");
  } else {
    const clients = options.clients ?? (await detectClients(cwd));
    if (clients.length === 0) {
      state.infos.push(
        "Guard: no agent configuration detected (.claude/, CLAUDE.md, .codex/, AGENTS.md, .cursor/, .cursorrules) — skipped. Force with `safeinstall init --client claude,codex,cursor`."
      );
      guardSummary = "no agent detected";
    } else {
      const guardResult = await runGuardSetupFlow(cwd, argv, { clients });
      const guardDetails = guardResult.details as { results?: GuardSetupTargetResult[] } | undefined;
      for (const target of guardDetails?.results ?? []) {
        state.infos.push(describeGuardTarget(target));
      }
      state.details.guard = guardResult.details;
      if (guardResult.exitCode !== 0) {
        return initFailure(
          state,
          guardResult.reasons,
          "Init stopped: guard hook registration failed. Fix the reported file, then re-run safeinstall init."
        );
      }
      state.warnings.push(...guardResult.warnings);
      guardSummary = clients.join(", ");
    }
  }

  // 3. Trust-surface baseline — last, so it covers the hooks written above.
  // An existing clean lock is a no-op; an existing drifted lock aborts init
  // (re-baselining here would launder tampering into a fresh baseline).
  let lockSummary = "skipped";
  if (!options.lock) {
    state.infos.push("Trust lock: skipped (--no-lock).");
  } else {
    const lockArgv = ["trust", "lock", ...(options.mode ? ["--mode", options.mode] : [])];
    const lockResult = await runTrustLockFlow(cwd, lockArgv);
    state.details.trust = lockResult.details;
    if (lockResult.exitCode !== 0) {
      state.warnings.push(...lockResult.warnings);
      return initFailure(
        state,
        lockResult.reasons,
        `Init stopped: ${lockResult.summary}`,
        lockResult.exitCode
      );
    }
    state.infos.push(lockResult.summary);
    state.infos.push(
      "Next: commit .safeinstall/ and run `safeinstall trust lock --ci github` to add the CI backstop."
    );
    lockSummary = "locked";
  }

  return {
    mode: "init",
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "Project initialized: policy config, guard hooks, and trust baseline are in place.",
    command: argv,
    commandString: formatCommand("safeinstall", argv),
    reasons: [],
    summary: `Init complete — config: ${writeConfigFile ? (configExisted ? "overwritten" : "created") : "kept"}, guard: ${guardSummary}, trust surface: ${lockSummary}.`,
    warnings: state.warnings,
    infos: state.infos,
    affectedPackages: [],
    details: state.details
  };
}
