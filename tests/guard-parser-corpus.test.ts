import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeShellCommand } from "../src/guard-commands";

/**
 * Permanent security-regression corpus for the shell-command guard parser.
 *
 * Every documented finding (and every future bypass report) lives as one JSON
 * file in tests/fixtures/bypass-corpus/. Each entry pins the parser's current
 * secure behaviour on a formerly dangerous input. Schema (see any *.json for
 * an example):
 *
 *   {
 *     "id":            unique slug (also the filename),
 *     "category":      "case-sensitivity" | "redirection-prefix"
 *                        | "wrapper-flag" | "remote-exec-subcommand" | ...,
 *     "severity":      "bypass" | "suspicious" | "cosmetic",
 *     "input":         the raw shell command,
 *     "shellBehavior": what a real shell actually does with `input`,
 *     "parserToday":   { decision, installs, runners, unanalyzable, usesSafeInstall },
 *     "expectedSecureDecision": the decision a fixed parser should return,
 *     "note":          root cause / fix guidance,
 *     "discoveredBy":  provenance
 *   }
 *
 * This test asserts the parser still behaves as `parserToday` records and that
 * every formerly dangerous command receives its secure decision. A refactor
 * that reopens a bypass therefore fails immediately.
 *
 * To file a new bypass report: drop a JSON file with the schema above into the
 * fixtures directory. No code change needed here.
 */

interface CorpusEntry {
  id: string;
  category: string;
  severity: "bypass" | "suspicious" | "cosmetic";
  input: string;
  shellBehavior: string;
  parserToday: {
    decision: "allow" | "deny" | "ask";
    installs: number;
    runners: number;
    unanalyzable: number;
    usesSafeInstall: boolean;
  };
  expectedSecureDecision: "allow" | "deny" | "ask";
  note: string;
  discoveredBy: string;
}

const CORPUS_DIR = path.join(__dirname, "fixtures", "bypass-corpus");

function derivedDecision(analysis: ReturnType<typeof analyzeShellCommand>): "allow" | "deny" | "ask" {
  if (analysis.unanalyzable.length > 0) return "deny";
  if (analysis.installs.length > 0) return "deny";
  if (analysis.runners.length > 0) return "ask";
  return "allow";
}

function loadCorpus(): CorpusEntry[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const entry = JSON.parse(readFileSync(path.join(CORPUS_DIR, name), "utf8")) as CorpusEntry;
      expect(entry.id, `${name} id must match filename`).toBe(name.replace(/\.json$/, ""));
      return entry;
    });
}

describe("guard parser bypass corpus", () => {
  const corpus = loadCorpus();

  it("has entries", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it.each(corpus.map((entry) => [entry.id, entry] as const))(
    "%s: parser preserves the secure regression decision",
    (_id, entry) => {
      const analysis = analyzeShellCommand(entry.input);
      const observed = {
        decision: derivedDecision(analysis),
        installs: analysis.installs.length,
        runners: analysis.runners.length,
        unanalyzable: analysis.unanalyzable.length,
        usesSafeInstall: analysis.usesSafeInstall
      };
      expect(observed, `Corpus entry ${entry.id} drifted from its patched behaviour.`).toEqual(
        entry.parserToday
      );
      expect(observed.decision, `Corpus entry ${entry.id} reopened its security gap.`).toBe(
        entry.expectedSecureDecision
      );
    }
  );

  it("every historical finding is closed", () => {
    const reopened = corpus.filter((entry) => entry.parserToday.decision !== entry.expectedSecureDecision);
    expect(reopened.map((entry) => entry.id)).toEqual([]);
  });

  it("every entry is fully populated", () => {
    for (const entry of corpus) {
      expect(entry.input.length, `${entry.id} input`).toBeGreaterThan(0);
      expect(entry.category.length, `${entry.id} category`).toBeGreaterThan(0);
      expect(["bypass", "suspicious", "cosmetic"], `${entry.id} severity`).toContain(entry.severity);
      expect(entry.shellBehavior.length, `${entry.id} shellBehavior`).toBeGreaterThan(10);
      expect(entry.note.length, `${entry.id} note`).toBeGreaterThan(10);
    }
  });
});
