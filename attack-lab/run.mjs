#!/usr/bin/env node
// Attack Lab runner: load every case manifest, compute its eval verdict, and
// print machine-readable RESULT lines plus a summary. Exit non-zero if any
// case is a regression (an unpatched gap sitting green) or a discipline error
// (an unpatched bypass marked public before an advisory).
//
//   node attack-lab/run.mjs [--json]
//
// The eval logic lives in the built CLI (dist/attack-lab.js) so the runner,
// the regression suite, and the published catalogue can never diverge. Run
// `pnpm build` first.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");
const distModule = path.join(here, "..", "dist", "attack-lab.js");

let lab;
try {
  lab = await import(distModule);
} catch {
  console.error("attack-lab: dist/attack-lab.js not found. Run `pnpm build` first.");
  process.exit(2);
}

const json = process.argv.includes("--json");
const cases = await lab.loadAttackCases(casesDir);
const evals = cases.map((attackCase) => lab.evalCase(attackCase));
const report = lab.summarize(evals);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  for (const evaluation of evals) {
    process.stdout.write(
      `RESULT id=${evaluation.id} layer=${evaluation.layer} defense=${evaluation.defense} status=${evaluation.status} — ${evaluation.detail}\n`
    );
  }
  const { counts } = report;
  process.stdout.write(
    `SUMMARY ok=${counts.ok} known-gap=${counts["known-gap"]} regression=${counts.regression} discipline-error=${counts["discipline-error"]}\n`
  );
}

if (!report.clean) {
  process.stderr.write("attack-lab: regressions or discipline errors present.\n");
  process.exit(1);
}
