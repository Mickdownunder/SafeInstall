import { authorizeDecisions } from "./decision-authorize";
import { formatCommand } from "./output";
import { verifyDecisions } from "./decision-verify";
import type { CliResult } from "./types";

/**
 * CLI surface for decision records: `safeinstall decisions verify` (offline
 * chain/binding integrity) and `safeinstall decisions authorize` (verify plus
 * a fresh policy re-evaluation of the committed head state — the L1 gate).
 *
 * Designed for CI first: explicit refs, no guessing. `--base` is required —
 * the verifier is told the merge base by the workflow; silently inferring one
 * locally would make "verified" mean different things on different machines.
 */

export function isDecisionsSubcommand(value: string | undefined): value is "verify" | "authorize" {
  return value === "verify" || value === "authorize";
}

interface ParsedVerifyArgs {
  baseRef?: string;
  headRef?: string;
  allowedRegistryUrls: string[];
  /** authorize only: write the authorization artifact (canonical JSON) here. */
  outputPath?: string;
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
    } else if (token === "--output" || token.startsWith("--output=")) {
      const value = readValue("--output");
      if (value instanceof Error) return value;
      parsed.outputPath = value;
    } else {
      return new Error(`Unknown decisions verify argument: ${token}`);
    }
  }
  return parsed;
}

const USAGE =
  "Usage: safeinstall decisions <verify|authorize> --base <ref> [--head <ref>] [--allow-registry <url>] [--output <file>]";

export async function runDecisionsFlow(cwd: string, argv: string[]): Promise<CliResult> {
  const base: Omit<CliResult, "decision" | "exitCode" | "exitCodeMeaning" | "reasons" | "summary"> = {
    mode: "decisions",
    command: argv,
    commandString: formatCommand("safeinstall", argv),
    warnings: [],
    infos: [],
    affectedPackages: []
  };

  const subcommand = argv[1];
  if (!isDecisionsSubcommand(subcommand)) {
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
      exitCodeMeaning: `Invalid decisions ${subcommand} arguments.`,
      reasons: [
        {
          code: "decisions-invalid-arguments",
          message: parsed instanceof Error ? parsed.message : "--base <ref> is required.",
          suggestion: USAGE
        }
      ],
      summary: `decisions ${subcommand} failed: invalid arguments.`
    };
  }

  const refOptions = {
    baseRef: parsed.baseRef,
    headRef: parsed.headRef,
    allowedRegistryUrls: parsed.allowedRegistryUrls
  };

  if (subcommand === "authorize") {
    const result = await authorizeDecisions(cwd, refOptions);
    const infos = [...result.infos];

    // The artifact is written for BOTH verdicts (a block is also evidence),
    // in canonical form (D1) so L2 can later sign exactly these bytes.
    if (parsed.outputPath && result.authorization) {
      const { writeFile } = await import("node:fs/promises");
      const { canonicalJsonBytes } = await import("./canonical-json");
      await writeFile(parsed.outputPath, canonicalJsonBytes({ ...result.authorization }));
      infos.push(`Authorization artifact written: ${parsed.outputPath}.`);
    }

    if (!result.ok) {
      return {
        ...base,
        decision: "block",
        exitCode: 2,
        exitCodeMeaning: "Decision authorization failed: the fresh re-evaluation did not reach allow.",
        reasons: result.findings.map((finding) => ({ code: finding.code, message: finding.message })),
        summary: "decisions authorize failed.",
        infos,
        warnings: result.authorization?.warnings ?? [],
        details: result.authorization ? { authorization: result.authorization } : undefined
      };
    }
    return {
      ...base,
      decision: "allow",
      exitCode: 0,
      exitCodeMeaning: "An independent re-evaluation of the committed dependency state reached allow.",
      reasons: [],
      summary: `decisions authorize passed: fresh policy evaluation of ${result.authorization?.headCommit.slice(0, 12)} at ${result.authorization?.evaluatedAt} reached allow.`,
      infos,
      warnings: result.authorization?.warnings ?? [],
      details: result.authorization ? { authorization: result.authorization } : undefined
    };
  }

  const result = await verifyDecisions(cwd, refOptions);

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
