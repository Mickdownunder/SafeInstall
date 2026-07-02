import path from "node:path";

import type { CliReason, CliResult, PackageEvaluation } from "./types";

export function printConfigInfo(configPath?: string): void {
  if (configPath) {
    console.error(`Using config: ${configPath}`);
  } else {
    console.error("Using config: built-in defaults");
  }
}

export function formatCommand(command: string, args: string[]): string {
  return [path.basename(command), ...args].join(" ");
}

export function printWarnings(evaluations: PackageEvaluation[]): void {
  for (const evaluation of evaluations) {
    for (const info of evaluation.infos) {
      console.error(`Info: ${info}`);
    }
    for (const warning of evaluation.warnings) {
      console.error(`Warning: ${warning}`);
    }
  }
}

function printReason(reason: CliReason, indent = ""): void {
  console.error(`${indent}${reason.message}`);
  if (reason.suggestion) {
    console.error(`${indent}Suggestion: ${reason.suggestion}`);
  }
}

function serializeCliResult(result: CliResult): Omit<CliResult, "details"> {
  const { details: _details, ...serialized } = result;
  return serialized;
}

export function writeCliResult(result: CliResult, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(serializeCliResult(result), null, 2)}\n`);
    return;
  }

  if (result.details?.suppressHumanOutput === true) {
    return;
  }

  if (result.configLabel) {
    console.error(`Using config: ${result.configLabel}`);
  } else if (result.configPath) {
    printConfigInfo(result.configPath);
  }

  for (const info of result.infos) {
    console.error(`Info: ${info}`);
  }
  for (const warning of result.warnings) {
    console.error(`Warning: ${warning}`);
  }

  if (result.mode === "init" || result.mode === "guard") {
    if (result.decision === "allow") {
      console.error(result.summary);
      if (typeof result.details?.configPath === "string") {
        console.error(`Created: ${result.details.configPath}`);
      }
      return;
    }

    if (result.mode === "guard") {
      console.error(result.summary);
    }
    for (const reason of result.reasons) {
      printReason(reason);
    }
    return;
  }

  if (result.decision === "allow") {
    console.error(result.summary);
    return;
  }

  if (result.affectedPackages.length > 0) {
    console.error(result.mode === "check" ? "Check blocked." : "Install blocked.");
    for (const affectedPackage of result.affectedPackages) {
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

  console.error(result.mode === "check" ? "Check blocked." : "Install blocked.");
  for (const reason of result.reasons) {
    console.error(`- ${reason.message}`);
    if (reason.suggestion) {
      console.error(`  Suggestion: ${reason.suggestion}`);
    }
  }
}
