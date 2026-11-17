import path from "node:path";

import { redactCliResult, redactSensitiveArgs, redactSensitiveText } from "./redaction";
import type { CliReason, CliResult, PackageEvaluation } from "./types";

export function printConfigInfo(configPath?: string): void {
  if (configPath) {
    console.error(`Using config: ${redactSensitiveText(configPath)}`);
  } else {
    console.error("Using config: built-in defaults");
  }
}

export function formatCommand(command: string, args: string[]): string {
  return [path.basename(command), ...redactSensitiveArgs(args)].join(" ");
}

export function printWarnings(evaluations: PackageEvaluation[]): void {
  for (const evaluation of evaluations) {
    for (const info of evaluation.infos) {
      console.error(`Info: ${redactSensitiveText(info)}`);
    }
    for (const warning of evaluation.warnings) {
      console.error(`Warning: ${redactSensitiveText(warning)}`);
    }
  }
}

function printReason(reason: CliReason, indent = ""): void {
  console.error(`${indent}${redactSensitiveText(reason.message)}`);
  if (reason.suggestion) {
    console.error(`${indent}Suggestion: ${redactSensitiveText(reason.suggestion)}`);
  }
}

function serializeCliResult(result: CliResult): Omit<CliResult, "details"> {
  const { details: _details, ...serialized } = result;
  return serialized;
}

export function writeCliResult(result: CliResult, jsonMode: boolean): void {
  const safeResult = redactCliResult(result);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(serializeCliResult(safeResult), null, 2)}\n`);
    return;
  }

  if (safeResult.details?.suppressHumanOutput === true) {
    return;
  }

  if (safeResult.configLabel) {
    console.error(`Using config: ${safeResult.configLabel}`);
  } else if (safeResult.configPath) {
    printConfigInfo(safeResult.configPath);
  }

  for (const info of safeResult.infos) {
    console.error(`Info: ${info}`);
  }
  for (const warning of safeResult.warnings) {
    console.error(`Warning: ${warning}`);
  }

  if (
    safeResult.mode === "init" ||
    safeResult.mode === "guard" ||
    safeResult.mode === "trust" ||
    safeResult.mode === "decisions"
  ) {
    if (safeResult.decision === "allow") {
      console.error(safeResult.summary);
      if (typeof safeResult.details?.configPath === "string") {
        console.error(`Created: ${redactSensitiveText(safeResult.details.configPath)}`);
      }
      return;
    }

    if (safeResult.mode === "guard" || safeResult.mode === "trust" || safeResult.mode === "decisions") {
      console.error(safeResult.summary);
    }
    for (const reason of safeResult.reasons) {
      printReason(reason);
    }
    return;
  }

  if (safeResult.decision === "allow") {
    console.error(safeResult.summary);
    return;
  }

  if (safeResult.affectedPackages.length > 0) {
    console.error(safeResult.mode === "check" ? "Check blocked." : "Install blocked.");
    for (const affectedPackage of safeResult.affectedPackages) {
      const packageLabel = affectedPackage.resolvedVersion
        ? `${affectedPackage.name}@${affectedPackage.resolvedVersion}`
        : affectedPackage.requested;
      console.error(`- ${packageLabel}`);
      for (const reason of affectedPackage.reasons) {
        printReason(reason, "  ");
      }
    }
    return;
  }

  console.error(safeResult.mode === "check" ? "Check blocked." : "Install blocked.");
  for (const reason of safeResult.reasons) {
    console.error(`- ${reason.message}`);
    if (reason.suggestion) {
      console.error(`  Suggestion: ${reason.suggestion}`);
    }
  }
}
