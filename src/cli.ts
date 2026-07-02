#!/usr/bin/env node

import { parseCliOptions } from "./cli-options";
import { runCheckFlow } from "./check-flow";
import { isGuardClient, runGuardHook } from "./guard-flow";
import { parseGuardSetupClients, runGuardSetupFlow } from "./guard-setup";
import { runInitFlow } from "./init-flow";
import { runInstallFlow } from "./install-flow";
import { runMcpServer } from "./mcp";
import { formatCommand, writeCliResult } from "./output";
import { isTrustSubcommand, runTrustFlow } from "./trust-flow";
import { createShutdownController, ShutdownSignalError, signalExitCode } from "./signals";
import type { CliResult } from "./types";

const PACKAGE_VERSION = String((require("../package.json") as { version?: string }).version ?? "0.0.0");

function isHelpRequest(argv: string[]): boolean {
  return argv[0] === "--help" || argv[0] === "-h";
}

function isVersionRequest(argv: string[]): boolean {
  return argv[0] === "--version" || argv[0] === "-v";
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  safeinstall <npm|pnpm|bun> <install-command> [...args]",
      "  safeinstall check",
      "  safeinstall init [--force]",
      "  safeinstall mcp",
      "  safeinstall guard install [--client claude,cursor]",
      "  safeinstall guard <claude|cursor>",
      "  safeinstall trust lock [--mode warn|strict]",
      "  safeinstall trust status [--require-lock]",
      "  safeinstall trust approve",
      "  safeinstall trust unlock",
      "",
      "Commands:",
      "  mcp          Run the MCP server (stdio) so AI coding agents can call",
      "               the check_package tool before installing dependencies.",
      "  guard install  Register SafeInstall as a pre-shell hook for Claude Code",
      "               (.claude/settings.json) and Cursor (.cursor/hooks.json).",
      "  guard <client>  Run as the hook itself: reads the hook event from stdin",
      "               and denies raw package installs, pointing the agent at the",
      "               equivalent safeinstall command instead.",
      "  trust lock   Create the Agent Trust Surface baseline: hash the files",
      "               that configure SafeInstall and your AI agents (policy,",
      "               hooks, rules files, MCP configs).",
      "  trust status  Reconcile the trust surface against the baseline.",
      "               Exit 2 on drift — use it in CI to catch tampering.",
      "  trust approve  Review drift and approve a new baseline. Interactive",
      "               only: refuses to run from CI or agent hooks.",
      "  trust unlock  Remove the trust baseline (lock, ledger, head mirror).",
      "",
      "Global options:",
      "  --json       Emit machine-readable JSON output.",
      "  --config <path>  Use an explicit safeinstall.config.json instead of",
      "               discovering the nearest config by walking upward.",
      "  --help, -h   Show this help text.",
      "  --version, -v  Show the current SafeInstall version."
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const [, , ...rawArgv] = process.argv;

  let parsedOptions: ReturnType<typeof parseCliOptions>;
  try {
    parsedOptions = parseCliOptions(rawArgv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const { args: argv, json, configPath } = parsedOptions;
  const shutdown = createShutdownController();

  try {
    if (isHelpRequest(argv)) {
      printHelp();
      process.exitCode = 0;
      return;
    }

    if (isVersionRequest(argv)) {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exitCode = 0;
      return;
    }

    if (argv[0] === "guard") {
      if (argv[1] === "install") {
        const clients = parseGuardSetupClients(argv.slice(2));
        if (clients instanceof Error) {
          process.stderr.write(`${clients.message}\n`);
          process.exitCode = 1;
          return;
        }
        const result = await runGuardSetupFlow(process.cwd(), argv, { clients });
        writeCliResult(result, json);
        process.exitCode = result.exitCode;
        return;
      }

      if (isGuardClient(argv[1])) {
        // The guard hook owns stdio for the hook protocol; diagnostics go to
        // stderr only, so it never flows through writeCliResult.
        process.exitCode = await runGuardHook(argv[1]);
        return;
      }

      process.stderr.write(
        "Usage: safeinstall guard install [--client claude,cursor] | safeinstall guard <claude|cursor>\n"
      );
      process.exitCode = 1;
      return;
    }

    if (argv[0] === "trust") {
      if (!isTrustSubcommand(argv[1])) {
        process.stderr.write(
          "Usage: safeinstall trust lock [--mode warn|strict] | safeinstall trust status [--require-lock] | safeinstall trust approve | safeinstall trust unlock\n"
        );
        process.exitCode = 1;
        return;
      }
      const result = await runTrustFlow(process.cwd(), argv);
      writeCliResult(result, json);
      process.exitCode = result.exitCode;
      return;
    }

    if (argv[0] === "mcp") {
      // The MCP server owns stdio for the JSON-RPC protocol and runs until the
      // client closes the transport. It reports its own failures to stderr, so
      // it never flows through writeCliResult (which would corrupt stdout).
      await runMcpServer(PACKAGE_VERSION);
      return;
    }

    let result: CliResult;

    if (argv[0] === "check") {
      result = await runCheckFlow(process.cwd(), argv, {
        signal: shutdown.signal,
        configPath
      });
      writeCliResult(result, json);
      process.exitCode = result.exitCode;
      return;
    }

    if (argv[0] === "init") {
      result = await runInitFlow(process.cwd(), argv, {
        force: argv.includes("--force")
      });
      writeCliResult(result, json);
      process.exitCode = result.exitCode;
      return;
    }

    result = await runInstallFlow(process.cwd(), argv, {
      jsonMode: json,
      signal: shutdown.signal,
      configPath
    });
    writeCliResult(result, json);
    process.exitCode = result.exitCode;
  } catch (error) {
    const interrupted = error instanceof ShutdownSignalError;
    const result: CliResult = {
      mode:
        argv[0] === "check" ? "check" : argv[0] === "init" ? "init" : argv[0] === "trust" ? "trust" : "install",
      decision: "error",
      exitCode: interrupted ? signalExitCode(error.signalName) : 1,
      exitCodeMeaning: interrupted
        ? `SafeInstall was interrupted by ${error.signalName}.`
        : "SafeInstall failed before it could complete the command.",
      command: argv,
      commandString: formatCommand("safeinstall", argv),
      reasons: [
        {
          code: interrupted ? "interrupted" : "runtime-error",
          message: error instanceof Error ? error.message : String(error)
        }
      ],
      summary: interrupted ? "SafeInstall interrupted." : "SafeInstall failed.",
      warnings: [],
      infos: [],
      affectedPackages: []
    };
    writeCliResult(result, json);
    process.exitCode = result.exitCode;
  } finally {
    shutdown.dispose();
  }
}

void main();
