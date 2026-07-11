import { formatCommand } from "./output";
import { verifyDecisions } from "./decision-verify";
import type { CliResult } from "./types";

/**
 * CLI surface for decision records: `safeinstall decisions verify`.
 *
 * Designed for CI first (the offline half of L1): explicit refs, no guessing.
 * `--base` is required — the verifier is told the merge base by the workflow;
 * silently inferring one locally would make "verified" mean different things
 * on different machines.
 */

export function isDecisionsSubcommand(value: string | undefined): value is "verify" {
  return value === "verify";
}

interface ParsedVerifyArgs {
  baseRef?: string;
  headRef?: string;
  allowedRegistryUrls: string[];
}

function parseVerifyArgs(argv: string[]): ParsedVerifyArgs | Error {
  const parsed: ParsedVerifyArgs = { allowedRegistryUrls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const readValue = (flag: string): string | Error => {
      const value = token === flag ? argv[(index += 1)] : token.slice(flag.length + 1);
      if (!value) {
        return new Error(`${flag} requires a value.`);
      }
      return value;
    };

    if (token === "--base" || token.startsWith("--base=")) {
      const value = readValue("--base");
      if (value instanceof Error) return value;
      parsed.baseRef = value;
    } else if (token === "--head" || token.startsWith("--head=")) {
      const value = readValue("--head");
      if (value instanceof Error) return value;
      parsed.headRef = value;
    } else if (token === "--allow-registry" || token.startsWith("--allow-registry=")) {
      const value = readValue("--allow-registry");
      if (value instanceof Error) return value;
      parsed.allowedRegistryUrls.push(value);
    } else {
      return new Error(`Unknown decisions verify argument: ${token}`);
    }
  }
  return parsed;
}

const USAGE =
  "Usage: safeinstall decisions verify --base <ref> [--head <ref>] [--allow-registry <url>]";

export async function runDecisionsFlow(cwd: string, argv: string[]): Promise<CliResult> {
  const base: Omit<CliResult, "decision" | "exitCode" | "exitCodeMeaning" | "reasons" | "summary"> = {
    mode: "decisions",
    command: argv,
    commandString: formatCommand("safeinstall", argv),
    warnings: [],
    infos: [],
    affectedPackages: []
  };

  if (!isDecisionsSubcommand(argv[1])) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Unknown decisions subcommand.",
      reasons: [{ code: "decisions-invalid-arguments", message: USAGE }],
      summary: "decisions: unknown subcommand."
    };
  }

  const parsed = parseVerifyArgs(argv.slice(2));
  if (parsed instanceof Error || !parsed.baseRef) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Invalid decisions verify arguments.",
      reasons: [
        {
          code: "decisions-invalid-arguments",
          message: parsed instanceof Error ? parsed.message : "--base <ref> is required.",
          suggestion: USAGE
        }
      ],
      summary: "decisions verify failed: invalid arguments."
    };
  }

  const result = await verifyDecisions(cwd, {
    baseRef: parsed.baseRef,
    headRef: parsed.headRef,
    allowedRegistryUrls: parsed.allowedRegistryUrls
  });

  if (!result.ok) {
    return {
      ...base,
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "Decision-record verification failed.",
      reasons: result.findings.map((finding) => ({ code: finding.code, message: finding.message })),
      summary: "decisions verify failed.",
      infos: result.infos
    };
  }

  return {
    ...base,
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "Decision-record chains verify against the base..head delta.",
    reasons: [],
    summary:
      result.verifiedPaths.length > 0
        ? `decisions verify passed: ${result.verifiedPaths.join(", ")}.`
        : "decisions verify passed: no lockfile changes required records.",
    infos: result.infos
  };
}
