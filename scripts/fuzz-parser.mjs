#!/usr/bin/env node
// Standalone deep-run fuzz harness for the shell-command guard parser.
//
// Shares the exact generator, reference detector and invariants used by the CI
// test (tests/helpers/parser-fuzz-core.mjs) — one grammar, no drift. This entry
// point just runs a much larger, configurable campaign for offline hunting and
// prints an invariant report.
//
// Requires a build first (it analyses the compiled parser):
//   pnpm build && node scripts/fuzz-parser.mjs [runs] [seed]
//
// Env/args:
//   runs  (arg 1 or FUZZ_RUNS)  default 1000000
//   seed  (arg 2 or FUZZ_SEED)  default 0xC0FFEE
//
// Exit code is non-zero when any invariant violation is found.

import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "guard-commands.js");
const coreEntry = path.join(here, "..", "tests", "helpers", "parser-fuzz-core.mjs");

let analyzeShellCommand;
try {
  ({ analyzeShellCommand } = await import(distEntry));
} catch (error) {
  console.error(`Could not import ${distEntry}. Run \`pnpm build\` first.`);
  console.error(String(error));
  process.exit(2);
}
const { runCampaign } = await import(coreEntry);

const runs = Number(process.argv[2] ?? process.env.FUZZ_RUNS ?? 1_000_000);
const seed = Number(process.argv[3] ?? process.env.FUZZ_SEED ?? 0xc0ffee);

console.log(`Fuzzing the guard parser: ${runs} commands, seed 0x${seed.toString(16)}`);
const started = Date.now();
const result = runCampaign(analyzeShellCommand, { seed, runs });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const byClass = { "known-case": 0, "known-redirection": 0, new: 0 };
const byInvariant = {};
for (const violation of result.violations) {
  byClass[violation.classification] = (byClass[violation.classification] ?? 0) + 1;
  byInvariant[violation.invariant] = (byInvariant[violation.invariant] ?? 0) + 1;
}

console.log("");
console.log(`Ran ${result.runs} commands in ${elapsed}s`);
console.log(`Reference detector flagged ${result.referenceUnsafe} raw installs (I3 exercised)`);
console.log("Invariant violations by type:", byInvariant);
console.log("Violations by class:", byClass);

if (result.violations.length > 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "safeinstall-fuzz-"));
  const dump = path.join(dir, "new-violations.json");
  writeFileSync(dump, JSON.stringify(result.violations, null, 2));
  console.error("");
  console.error(`FAIL: ${result.violations.length} parser invariant violation(s) — regressions or candidate bypasses.`);
  console.error(`Full dump: ${dump}`);
  for (const violation of result.violations.slice(0, 20)) {
    console.error(`  [${violation.invariant}] ${JSON.stringify(violation.command)} :: ${violation.detail}`);
  }
  process.exit(1);
}

console.log("");
console.log("OK: zero invariant violations; historical bypass classes remain closed.");
