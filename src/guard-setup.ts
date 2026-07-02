import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatCommand } from "./output";
import { fileExists } from "./project-discovery";
import type { CliReason, CliResult } from "./types";

/**
 * `safeinstall guard install` — writes project-level hook configuration so
 * AI coding agents cannot run raw package installs. Supports Claude Code
 * (`.claude/settings.json`, PreToolUse/Bash) and Cursor
 * (`.cursor/hooks.json`, beforeShellExecution).
 *
 * Merging is conservative: existing files are parsed, existing unrelated
 * hooks are preserved byte-for-byte in structure, and a file that cannot be
 * parsed is left untouched and reported as an error. Re-running is
 * idempotent — an existing SafeInstall guard entry is detected and skipped.
 */

export type GuardSetupClient = "claude" | "cursor";

export const GUARD_HOOK_TIMEOUT_SECONDS = 60;

interface GuardSetupTargetResult {
  client: GuardSetupClient;
  configPath: string;
  status: "created" | "updated" | "already-installed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function guardCommand(client: GuardSetupClient): string {
  return `safeinstall guard ${client}`;
}

function isGuardCommand(value: unknown): boolean {
  return typeof value === "string" && /(^|\/)safeinstall guard\b/.test(value);
}

/**
 * Merge the SafeInstall PreToolUse hook into a Claude Code settings object.
 * Returns undefined when the guard is already registered.
 */
export function mergeClaudeSettings(existing: Record<string, unknown>): Record<string, unknown> | undefined {
  const settings = { ...existing };
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];

  for (const group of preToolUse) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      continue;
    }
    for (const hook of group.hooks) {
      if (isRecord(hook) && isGuardCommand(hook.command)) {
        return undefined;
      }
    }
  }

  preToolUse.push({
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: guardCommand("claude"),
        timeout: GUARD_HOOK_TIMEOUT_SECONDS
      }
    ]
  });

  hooks.PreToolUse = preToolUse;
  settings.hooks = hooks;
  return settings;
}

/**
 * Merge the SafeInstall beforeShellExecution hook into a Cursor hooks.json
 * object. Returns undefined when the guard is already registered.
 */
export function mergeCursorHooks(existing: Record<string, unknown>): Record<string, unknown> | undefined {
  const config = { ...existing };
  const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
  const beforeShellExecution = Array.isArray(hooks.beforeShellExecution)
    ? [...hooks.beforeShellExecution]
    : [];

  for (const hook of beforeShellExecution) {
    if (isRecord(hook) && isGuardCommand(hook.command)) {
      return undefined;
    }
  }

  beforeShellExecution.push({
    command: guardCommand("cursor"),
    timeout: GUARD_HOOK_TIMEOUT_SECONDS,
    // The guard is a security gate: if it crashes or times out, the shell
    // command must not silently proceed.
    failClosed: true
  });

  hooks.beforeShellExecution = beforeShellExecution;
  config.hooks = hooks;
  if (config.version === undefined) {
    config.version = 1;
  }
  return config;
}

const CLIENT_FILES: Record<GuardSetupClient, { relativePath: string; label: string }> = {
  claude: { relativePath: path.join(".claude", "settings.json"), label: "Claude Code" },
  cursor: { relativePath: path.join(".cursor", "hooks.json"), label: "Cursor" }
};

async function setupClient(cwd: string, client: GuardSetupClient): Promise<GuardSetupTargetResult> {
  const configPath = path.join(cwd, CLIENT_FILES[client].relativePath);
  const exists = await fileExists(configPath);

  let existing: Record<string, unknown> = {};
  if (exists) {
    const raw = await readFile(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Cannot update ${configPath}: the file is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix it manually, then re-run safeinstall guard install.`
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`Cannot update ${configPath}: expected a JSON object at the top level.`);
    }
    existing = parsed;
  }

  const merged = client === "claude" ? mergeClaudeSettings(existing) : mergeCursorHooks(existing);
  if (!merged) {
    return { client, configPath, status: "already-installed" };
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { client, configPath, status: exists ? "updated" : "created" };
}

export interface GuardSetupOptions {
  clients: GuardSetupClient[];
}

export function parseGuardSetupClients(argv: string[]): GuardSetupClient[] | Error {
  const requested: GuardSetupClient[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    let value: string | undefined;

    if (token === "--client") {
      value = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--client=")) {
      value = token.slice("--client=".length);
    } else {
      continue;
    }

    for (const entry of (value ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
      if (entry !== "claude" && entry !== "cursor") {
        return new Error(`Unsupported --client value "${entry}". Supported: claude, cursor.`);
      }
      if (!requested.includes(entry)) {
        requested.push(entry);
      }
    }

    if (!value) {
      return new Error("--client requires a value (claude, cursor, or a comma-separated list).");
    }
  }

  return requested.length > 0 ? requested : ["claude", "cursor"];
}

export async function runGuardSetupFlow(
  cwd: string,
  argv: string[],
  options: GuardSetupOptions
): Promise<CliResult> {
  const commandString = formatCommand("safeinstall", argv);
  const results: GuardSetupTargetResult[] = [];
  const failures: CliReason[] = [];

  for (const client of options.clients) {
    try {
      results.push(await setupClient(cwd, client));
    } catch (error) {
      failures.push({
        code: "guard-setup-failed",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const infos = results.map((result) => {
    const label = CLIENT_FILES[result.client].label;
    switch (result.status) {
      case "created":
        return `${label}: hook registered in new file ${result.configPath}.`;
      case "updated":
        return `${label}: hook added to existing file ${result.configPath}.`;
      case "already-installed":
        return `${label}: SafeInstall guard already registered in ${result.configPath}.`;
    }
  });

  if (failures.length > 0) {
    return {
      mode: "guard",
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "SafeInstall could not register all guard hooks.",
      command: argv,
      commandString,
      reasons: failures,
      summary: "Guard setup failed.",
      warnings: [],
      infos,
      affectedPackages: [],
      details: { results: results.map(({ client, configPath, status }) => ({ client, configPath, status })) }
    };
  }

  return {
    mode: "guard",
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "Guard hooks are registered.",
    command: argv,
    commandString,
    reasons: [],
    summary: "Guard hooks registered. Agent shell commands that install packages will be routed through SafeInstall.",
    warnings: [
      "The guard requires the safeinstall binary on the agent's PATH (npm install -g safeinstall-cli)."
    ],
    infos,
    affectedPackages: [],
    details: { results: results.map(({ client, configPath, status }) => ({ client, configPath, status })) }
  };
}
