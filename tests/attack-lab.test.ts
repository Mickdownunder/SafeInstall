import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  evalCase,
  loadAttackCases,
  summarize,
  validateAttackCase,
  type AttackCase
} from "../src/attack-lab";
import { analyzeShellCommand } from "../src/guard-commands";
import { createTtyHumanGate } from "../src/trust-flow";
import { present } from "./helpers/present";

/**
 * The Attack Lab is eval-system-first: this suite (a) validates every case
 * manifest and its computed eval verdict, (b) proves every referenced
 * regression-test FILE exists, and (c) LIVE-EXECUTES the shipped control for
 * representative defended cases, so `defense: defended` is an executable claim
 * and not a hopeful string. It also pins the two honest limits (approval
 * fatigue, K2 consistent-rewrite) so no future change can quietly relabel them
 * "defended" without a real fix.
 */

const CASES_DIR = path.join(__dirname, "..", "attack-lab", "cases");
const REPO_ROOT = path.join(__dirname, "..");

function byId(cases: AttackCase[]): Map<string, AttackCase> {
  return new Map(cases.map((attackCase) => [attackCase.id, attackCase]));
}

describe("attack lab catalogue", () => {
  it("loads, validates, and has cases across multiple layers", async () => {
    const cases = await loadAttackCases(CASES_DIR);
    expect(cases.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cases.map((attackCase) => attackCase.layer)).size).toBeGreaterThanOrEqual(3);
  });

  it("has no regressions and no discipline errors", async () => {
    const cases = await loadAttackCases(CASES_DIR);
    const report = summarize(cases.map(evalCase));
    // A regression = an unpatched gap sitting green; a discipline error = an
    // unpatched bypass marked public before an advisory. Either must fail CI.
    expect(report.counts.regression, JSON.stringify(report.cases.filter((c) => c.status === "regression"))).toBe(0);
    expect(report.counts["discipline-error"]).toBe(0);
    expect(report.clean).toBe(true);
  });

  it("points every case at a regression-test file that exists", async () => {
    const cases = await loadAttackCases(CASES_DIR);
    for (const attackCase of cases) {
      // The reference is "path[ > test name]" or "repo: path[ case name]";
      // extract the first path-looking token and require the file to exist.
      const token = attackCase.regressionTest.match(/(?:^|\s)((?:tests|safeinstall-verifier)\/[\w./-]+)/);
      expect(token, `${attackCase.id} regressionTest names no file: ${attackCase.regressionTest}`).not.toBeNull();
      const referenced = present(token?.[1]);
      if (referenced.startsWith("safeinstall-verifier/")) {
        // External repo; existence is that repo's CI concern, not this one.
        continue;
      }
      expect(existsSync(path.join(REPO_ROOT, referenced)), `${attackCase.id} → missing ${referenced}`).toBe(true);
    }
  });

  it("rejects an unpatched bypass marked public (disclosure discipline)", () => {
    const bad = {
      schemaVersion: 1,
      id: "hypothetical",
      title: "x",
      layer: "guard-parser",
      attacker: { prerequisites: ["p"], goal: "g" },
      startingState: "s",
      vulnerableVersion: "v",
      defense: "unpatched",
      expectedVerdict: "e",
      regressionTest: "tests/x.test.ts",
      disclosure: "public",
      provenance: "p"
    };
    const evaluation = evalCase(validateAttackCase(bad, "hypothetical"));
    expect(evaluation.status).toBe("discipline-error");
  });
});

describe("attack lab — live defenses", () => {
  it("guard-parser cases: the shipped parser still denies the raw install", async () => {
    const cases = byId(await loadAttackCases(CASES_DIR));
    const inputs: Record<string, string> = {
      "guard-parser-sudo-user-wrapper": "sudo -u root npm install evil-pkg",
      "guard-parser-leading-redirection": ">out npm install evil-pkg"
    };
    for (const [id, input] of Object.entries(inputs)) {
      expect(cases.has(id), `${id} case present`).toBe(true);
      const analysis = analyzeShellCommand(input);
      // Denied: either a detected install or an unanalyzable segment — never
      // an allow, never silently routed as safe.
      expect(
        analysis.installs.length > 0 || analysis.unanalyzable.length > 0,
        `${id} reopened: parser did not flag ${JSON.stringify(input)}`
      ).toBe(true);
      expect(analysis.usesSafeInstall).toBe(false);
    }
  });

  it("human-gate case: the interactive gate still refuses a CODEX_SHELL context", async () => {
    // Exercise the exact refusal primitive the approve flow gates on. Isolate
    // the marker: markers are checked in order, so an ambient CI / CLAUDECODE
    // would otherwise fire first and prove nothing about CODEX_SHELL.
    const markers = ["CI", "CLAUDECODE", "CODEX_SHELL", "CURSOR_AGENT"];
    const saved = Object.fromEntries(markers.map((name) => [name, process.env[name]]));
    try {
      for (const name of markers) delete process.env[name];
      process.env.CODEX_SHELL = "1";
      await expect(createTtyHumanGate().ensureInteractive()).rejects.toThrow(/CODEX_SHELL is set/);
    } finally {
      for (const name of markers) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

describe("attack lab — honest limits", () => {
  it("documents the approval-fatigue limit without claiming a fix", async () => {
    const attackCase = byId(await loadAttackCases(CASES_DIR)).get("incident-approval-fatigue");
    expect(attackCase, "approval-fatigue case present").toBeDefined();
    expect(attackCase!.defense).toBe("documented-limit");
    expect(evalCase(attackCase!).status).toBe("known-gap");
  });

  it("documents the K2 consistent-rewrite limit without claiming a fix", async () => {
    const attackCase = byId(await loadAttackCases(CASES_DIR)).get("workflow-consistent-rewrite-no-mirror");
    expect(attackCase, "K2 case present").toBeDefined();
    expect(attackCase!.defense).toBe("documented-limit");
    expect(attackCase!.layer).toBe("workflow-anchor");
    expect(evalCase(attackCase!).status).toBe("known-gap");
  });
});
