#!/usr/bin/env node

import { parseCliOptions } from "./cli-options";
import { runCheckFlow } from "./check-flow";
import { runInitFlow } from "./init-flow";
import { runInstallFlow } from "./install-flow";
import { runMcpServer } from "./mcp";
import { formatCommand, writeCliResult } from "./output";
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
      "",
      "Commands:",
      "  mcp          Run the MCP server (stdio) so AI coding agents can call",
      "               the check_package tool before installing dependencies.",
      "",
      "Global options:",
      "  --json       Emit machine-readable JSON output.",
      "  --help, -h   Show this help text.",
      "  --version, -v  Show the current SafeInstall version."
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  const [, , ...rawArgv] = process.argv;
  const { args: argv, json } = parseCliOptions(rawArgv);
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
        signal: shutdown.signal
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
      signal: shutdown.signal
    });
    writeCliResult(result, json);
    process.exitCode = result.exitCode;
  } catch (error) {
    const interrupted = error instanceof ShutdownSignalError;
    const result: CliResult = {
      mode: argv[0] === "check" ? "check" : argv[0] === "init" ? "init" : "install",
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
