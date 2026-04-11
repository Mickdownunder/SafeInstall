import { describe, expect, it } from "vitest";

import { damerauLevenshtein, detectTypoSquat } from "../src/typo-squat";
import type { TypoSquatConfig } from "../src/types";

function createConfig(overrides: Partial<TypoSquatConfig> = {}): TypoSquatConfig {
  return {
    mode: "warn",
    minNameLength: 4,
    ignore: [],
    ...overrides
  };
}

describe("damerauLevenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(damerauLevenshtein("react", "react")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(damerauLevenshtein("", "react")).toBe(5);
    expect(damerauLevenshtein("react", "")).toBe(5);
  });

  it("counts a single substitution as distance 1", () => {
    expect(damerauLevenshtein("raact", "react")).toBe(1);
  });

  it("counts a single insertion as distance 1", () => {
    expect(damerauLevenshtein("reactt", "react")).toBe(1);
  });

  it("counts a single deletion as distance 1", () => {
    expect(damerauLevenshtein("reac", "react")).toBe(1);
  });

  it("counts an adjacent-character transposition as distance 1", () => {
    expect(damerauLevenshtein("raect", "react")).toBe(1);
    expect(damerauLevenshtein("lodahs", "lodash")).toBe(1);
    expect(damerauLevenshtein("axois", "axios")).toBe(1);
  });

  it("treats non-adjacent transpositions as multiple edits", () => {
    // swapping first and last character of "react" = "teacr" which is
    // 2 substitutions, not 1 transposition
    expect(damerauLevenshtein("teacr", "react")).toBeGreaterThan(1);
  });

  it("returns cutoff+1 when the distance exceeds the cutoff", () => {
    expect(damerauLevenshtein("a", "xyzabc", 2)).toBe(3);
  });

  it("handles length differences that immediately exceed the cutoff", () => {
    expect(damerauLevenshtein("ab", "abcdef", 2)).toBe(3);
  });
});

describe("detectTypoSquat", () => {
  const targets = ["react", "lodash", "axios", "express", "typescript", "eslint"];

  it("returns undefined for an exact match to a popular package", () => {
    expect(detectTypoSquat("react", createConfig(), targets)).toBeUndefined();
    expect(detectTypoSquat("lodash", createConfig(), targets)).toBeUndefined();
  });

  it("returns undefined for a name shorter than minNameLength", () => {
    expect(detectTypoSquat("rct", createConfig({ minNameLength: 4 }), targets)).toBeUndefined();
    expect(detectTypoSquat("rct", createConfig({ minNameLength: 2 }), targets)).toBeDefined();
  });

  it("returns undefined for names on the ignore list", () => {
    const config = createConfig({ ignore: ["raect"] });
    expect(detectTypoSquat("raect", config, targets)).toBeUndefined();
  });

  it("normalizes ignore comparisons to lowercase", () => {
    const config = createConfig({ ignore: ["raect"] });
    expect(detectTypoSquat("RAECT", config, targets)).toBeUndefined();
  });

  it("flags common single-substitution typos", () => {
    const result = detectTypoSquat("raact", createConfig(), targets);
    expect(result).toBeDefined();
    expect(result?.suspectedTarget).toBe("react");
    expect(result?.editDistance).toBe(1);
  });

  it("flags common transposition typos", () => {
    const result = detectTypoSquat("axois", createConfig(), targets);
    expect(result).toBeDefined();
    expect(result?.suspectedTarget).toBe("axios");
    expect(result?.editDistance).toBe(1);
  });

  it("flags single-character insertions", () => {
    const result = detectTypoSquat("reactt", createConfig(), targets);
    expect(result).toBeDefined();
    expect(result?.suspectedTarget).toBe("react");
    expect(result?.editDistance).toBe(1);
  });

  it("flags single-character deletions on longer names", () => {
    const result = detectTypoSquat("typscript", createConfig(), targets);
    expect(result).toBeDefined();
    expect(result?.suspectedTarget).toBe("typescript");
    expect(result?.editDistance).toBe(1);
  });

  it("does not flag names that are too different from any target", () => {
    expect(detectTypoSquat("completely-unrelated-package", createConfig(), targets)).toBeUndefined();
  });

  it("does not flag names whose length differs by more than 2 from every target", () => {
    expect(detectTypoSquat("reactjsx", createConfig(), targets)).toBeUndefined();
  });

  it("normalizes requested names to lowercase before comparison", () => {
    const result = detectTypoSquat("RAECT", createConfig(), targets);
    expect(result).toBeDefined();
    expect(result?.suspectedTarget).toBe("react");
  });

  it("preserves original casing in the suspicion.requested field", () => {
    const result = detectTypoSquat("RAECT", createConfig(), targets);
    expect(result?.requested).toBe("RAECT");
  });

  it("returns the closest match when multiple targets are within cutoff", () => {
    // "loadsh" is distance 1 from "lodash" (transposition) but is also
    // within cutoff of no other target of similar length. The detector
    // should pick lodash.
    const result = detectTypoSquat("loadsh", createConfig(), targets);
    expect(result?.suspectedTarget).toBe("lodash");
    expect(result?.editDistance).toBe(1);
  });
});
