import { readFile, writeFile } from "node:fs/promises";

import { authorizeDecisions } from "./decision-authorize";
import { buildAuthorizationStatement, verifyAuthorizationStatement, AttestationError } from "./decision-attest";
import { formatCommand } from "./output";
import { verifyDecisions } from "./decision-verify";
import type { CliResult } from "./types";

/**
 * CLI surface for decision records:
 * - `decisions verify` — offline chain/binding integrity.
 * - `decisions authorize` — verify plus a fresh policy re-evaluation of the
 *   committed head state (the L1 gate).
 * - `decisions attest` / `verify-attestation` — build and check the signable
 *   L2 in-toto statement over an authorization artifact.
 *
 * Designed for CI first: explicit refs, no guessing. `--base` is required for
 * verify/authorize — the verifier is told the merge base by the workflow;
 * silently inferring one locally would make "verified" mean different things
 * on different machines.
 */

type DecisionsSubcommand = "verify" | "authorize" | "attest" | "verify-attestation";

export function isDecisionsSubcommand(value: string | undefined): value is DecisionsSubcommand {
  return (
    value === "verify" || value === "authorize" || value === "attest" || value === "verify-attestation"
  );
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
    if (token === undefined) {
      continue;
    }
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
  "Usage: safeinstall decisions <verify|authorize> --base <ref> [--head <ref>] [--allow-registry <url>] [--output <file>]\n" +
  "       safeinstall decisions attest --authorization <file> [--output <statement.json>]\n" +
  "       safeinstall decisions verify-attestation --authorization <file> --statement <file>";

/** `--flag value` / `--flag=value` reader over an argv slice. */
function readFlags(argv: string[], flags: string[]): Record<string, string> | Error {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    const flag = flags.find((name) => token === name || token.startsWith(`${name}=`));
    if (!flag) {
      return new Error(`Unknown argument: ${token}`);
    }
    const value = token === flag ? argv[(index += 1)] : token.slice(flag.length + 1);
    if (!value) {
      return new Error(`${flag} requires a value.`);
    }
    out[flag.replace(/^--/, "")] = value;
  }
  return out;
}

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

  if (subcommand === "attest" || subcommand === "verify-attestation") {
    return runAttestSubcommand(base, subcommand, argv.slice(2));
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

type DecisionsBase = Omit<CliResult, "decision" | "exitCode" | "exitCodeMeaning" | "reasons" | "summary">;

/**
 * `decisions attest` / `verify-attestation` — the signable L2 statement layer.
 * Signing itself (Sigstore keyless, needs an OIDC identity) is the release/CI
 * step; these build and check the in-toto statement the signature covers.
 */
async function runAttestSubcommand(
  base: DecisionsBase,
  subcommand: "attest" | "verify-attestation",
  argv: string[]
): Promise<CliResult> {
  const flags = readFlags(argv, ["--authorization", "--statement", "--output"]);
  if (flags instanceof Error || !flags.authorization) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: `Invalid decisions ${subcommand} arguments.`,
      reasons: [
        {
          code: "decisions-invalid-arguments",
          message: flags instanceof Error ? flags.message : "--authorization <file> is required.",
          suggestion: USAGE
        }
      ],
      summary: `decisions ${subcommand} failed: invalid arguments.`
    };
  }

  let authorizationBytes: Buffer;
  try {
    authorizationBytes = await readFile(flags.authorization);
  } catch (error) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Could not read the authorization artifact.",
      reasons: [{ code: "decisions-artifact-unreadable", message: String(error) }],
      summary: `decisions ${subcommand} failed.`
    };
  }

  if (subcommand === "attest") {
    let canonicalBytes: Buffer;
    try {
      ({ canonicalBytes } = buildAuthorizationStatement(authorizationBytes));
    } catch (error) {
      return {
        ...base,
        decision: "error",
        exitCode: 1,
        exitCodeMeaning: "Could not build the authorization statement.",
        reasons: [
          {
            code: "decisions-attest-failed",
            message: error instanceof AttestationError ? error.message : String(error)
          }
        ],
        summary: "decisions attest failed."
      };
    }
    const infos: string[] = [
      "This is the signable statement (the DSSE payload). Sign it with Sigstore keyless in a CI workflow " +
        "(OIDC identity required); the statement alone is not a signature."
    ];
    if (flags.output) {
      await writeFile(flags.output, canonicalBytes);
      infos.push(`Statement written: ${flags.output}.`);
    } else {
      process.stdout.write(`${canonicalBytes.toString("utf8")}\n`);
    }
    return {
      ...base,
      decision: "allow",
      exitCode: 0,
      exitCodeMeaning: "Built the signable authorization statement.",
      reasons: [],
      summary: "decisions attest: signable statement built.",
      infos
    };
  }

  // verify-attestation
  if (!flags.statement) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Invalid decisions verify-attestation arguments.",
      reasons: [
        { code: "decisions-invalid-arguments", message: "--statement <file> is required.", suggestion: USAGE }
      ],
      summary: "decisions verify-attestation failed: invalid arguments."
    };
  }
  let statementBytes: Buffer;
  try {
    statementBytes = await readFile(flags.statement);
  } catch (error) {
    return {
      ...base,
      decision: "error",
      exitCode: 1,
      exitCodeMeaning: "Could not read the statement file.",
      reasons: [{ code: "decisions-statement-unreadable", message: String(error) }],
      summary: "decisions verify-attestation failed."
    };
  }

  const verification = verifyAuthorizationStatement(statementBytes, authorizationBytes);
  if (!verification.ok) {
    return {
      ...base,
      decision: "block",
      exitCode: 2,
      exitCodeMeaning: "The statement does not bind the authorization artifact.",
      reasons: verification.reasons.map((message) => ({ code: "decisions-statement-mismatch", message })),
      summary: "decisions verify-attestation failed.",
      warnings: [
        "This checks that the statement binds this artifact — it does NOT verify a cryptographic signature. " +
          "Signature verification against a workflow identity is the Sigstore-bundle step."
      ]
    };
  }
  return {
    ...base,
    decision: "allow",
    exitCode: 0,
    exitCodeMeaning: "The statement binds the authorization artifact.",
    reasons: [],
    summary: `decisions verify-attestation: statement binds the ${verification.verdict} authorization for ${verification.headCommit?.slice(0, 12)}.`,
    warnings: [
      "Binding verified, NOT a signature. A real L2 signature is verified against the workflow identity via " +
        "the Sigstore bundle (release/CI-gated)."
    ]
  };
}
