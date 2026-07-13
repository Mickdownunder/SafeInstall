import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeShellCommand } from "../src/guard-commands";
import {
  classifyDecision,
  generateCommand,
  makeRng,
  referenceDetect,
  runCampaign,
  stripShellRedirections
} from "./helpers/parser-fuzz-core.mjs";
import type { Violation } from "./helpers/parser-fuzz-core.mjs";

/**
 * Grammar-based fuzz harness for the shell-command guard parser.
 *
 * The generator, reference detector and invariant checkers live in
 * tests/helpers/parser-fuzz-core.mjs (shared verbatim with the deep-run script
 * scripts/fuzz-parser.mjs — one grammar, no drift). This file drives a bounded,
 * seeded campaign as a fast CI gate and asserts four invariants for every
 * generated command:
 *
 *   I1  the parser never throws an unhandled exception,
 *   I2  the decision is deterministic (parsing twice is identical),
 *   I3  fail-closed: an independently detected raw install is never allowed,
 *   I4  a rewrite is idempotent (re-analysing it yields no further rewrite).
 *
 * Every I3 violation is a security regression or a new bypass and fails the
 * run. The historical bypass corpus provides deterministic coverage in
 * addition to this generated campaign.
 */

// Multiple fixed seeds keep the run fully deterministic while widening coverage.
const SEEDS = [0x5afe1, 1, 42];
const RUNS_PER_SEED = 5000;

describe("guard parser fuzz campaign", () => {
  it(`holds all invariants over ${SEEDS.length * RUNS_PER_SEED} seeded commands`, () => {
    const newViolations: Violation[] = [];
    let totalReferenceUnsafe = 0;
    const violations: Violation[] = [];

    for (const seed of SEEDS) {
      const result = runCampaign(analyzeShellCommand, { seed, runs: RUNS_PER_SEED });
      totalReferenceUnsafe += result.referenceUnsafe;
      violations.push(...result.violations);
      newViolations.push(...result.newViolations);
    }

    // Sanity: the generator actually produces raw installs, so I3 is exercised
    // rather than vacuously true.
    expect(totalReferenceUnsafe).toBeGreaterThan(1000);
    if (violations.length > 0) {
      // mkdtemp, not a predictable /tmp filename: a guessable path in the
      // shared temp dir is symlink-attackable (CodeQL js/insecure-temporary-file).
      const dump = path.join(mkdtempSync(path.join(os.tmpdir(), "safeinstall-fuzz-")), "new-violations.json");
      writeFileSync(dump, JSON.stringify(violations, null, 2));
      const preview = violations
        .slice(0, 10)
        .map((v) => `  [${v.invariant}] ${JSON.stringify(v.command)} :: ${v.detail}`)
        .join("\n");
      throw new Error(
        `Fuzzer found ${violations.length} parser invariant violation(s). ` +
          `These are candidate bypasses not in the corpus. Full dump: ${dump}\n${preview}`
      );
    }

    expect(violations).toEqual([]);
    expect(newViolations).toEqual([]);
  });

  it("I1: degenerate and hostile inputs never throw", () => {
    const inputs = [
      "",
      " ",
      "\n\n\n",
      "\t",
      ";;;;",
      "&&&&",
      "|||",
      "'",
      '"',
      "\\",
      "$(",
      "`",
      "((((",
      ")))",
      "npm install '",
      'npm install "',
      "npm install \\",
      "> ",
      "< ",
      "2>",
      "npm install ​‮﻿",
      "\ud83d",
      "npm install " + "x".repeat(20000),
      "a".repeat(50000)
    ];
    for (const input of inputs) {
      expect(() => analyzeShellCommand(input), JSON.stringify(input)).not.toThrow();
    }
  });

  it("I2: parsing is deterministic", () => {
    const rng = makeRng(0xd37e2);
    for (let i = 0; i < 2000; i += 1) {
      const command = generateCommand(rng);
      const a = JSON.stringify(analyzeShellCommand(command));
      const b = JSON.stringify(analyzeShellCommand(command));
      expect(b, JSON.stringify(command)).toBe(a);
    }
  });

  it("I4: rewrites are idempotent for detected installs", () => {
    const commands = [
      "npm install axios",
      "npm i axios; pnpm add zod",
      "cd app && npm install axios && npm test",
      "CI=1 corepack pnpm@9 add axios",
      "npm install axios > install.log 2>&1"
    ];
    for (const command of commands) {
      const first = analyzeShellCommand(command);
      expect(first.rewrittenCommand, command).toBeDefined();
      const second = analyzeShellCommand(first.rewrittenCommand as string);
      expect(second.installs, `reanalysing rewrite of ${command}`).toEqual([]);
      expect(second.rewrittenCommand, `reanalysing rewrite of ${command}`).toBeUndefined();
      expect(second.usesSafeInstall).toBe(true);
    }
  });

  it("reference detector and decision helper agree on canonical cases", () => {
    // Guards the fuzz oracle itself: if these drift, I3 would silently weaken.
    expect(referenceDetect("npm install axios")).toBe("unsafe-install");
    expect(referenceDetect("pnpm add zod")).toBe("unsafe-install");
    expect(referenceDetect("bun a zod")).toBe("unsafe-install");
    expect(referenceDetect("safeinstall npm install axios")).toBe("none");
    expect(referenceDetect("npm run build")).toBe("none");
    expect(referenceDetect("echo npm install here")).toBe("none");
    expect(referenceDetect("npx cowsay")).toBe("none");
    expect(referenceDetect("npm install 'unterminated")).toBe("none");
    // Redirection-aware: the effective command is what counts.
    expect(referenceDetect("< in npm install evil")).toBe("unsafe-install");
    expect(referenceDetect("npm install axios > log")).toBe("unsafe-install");

    expect(classifyDecision(analyzeShellCommand("npm install axios"))).toBe("deny");
    expect(classifyDecision(analyzeShellCommand("npx cowsay"))).toBe("ask");
    expect(classifyDecision(analyzeShellCommand("git status"))).toBe("allow");

    expect(stripShellRedirections("< in npm install evil")).toContain("npm install evil");
    expect(classifyDecision(analyzeShellCommand("NPM install evil"))).toBe("deny");
    expect(classifyDecision(analyzeShellCommand("< in npm install evil"))).toBe("deny");
    expect(classifyDecision(analyzeShellCommand("sudo -u root npm install evil"))).toBe("deny");
  });
});
