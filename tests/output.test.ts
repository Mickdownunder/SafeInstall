import { describe, expect, it, vi } from "vitest";

import { writeCliResult } from "../src/output";
import type { CliResult } from "../src/types";
import { present } from "./helpers/present";

function createResult(overrides: Partial<CliResult> = {}): CliResult {
  return {
    mode: "check",
    command: ["check"],
    commandString: "safeinstall check",
    decision: "block",
    exitCode: 2,
    exitCodeMeaning: "Check found dependencies that violate the current policy.",
    summary: "Check blocked.",
    reasons: [
      {
        code: "untrusted-source",
        message: "Blocked: untrusted source (git).",
        suggestion: "Use a registry release or allow this source intentionally."
      }
    ],
    warnings: [],
    infos: [],
    affectedPackages: [],
    ...overrides
  };
}

describe("writeCliResult", () => {
  it("writes stable JSON output in json mode", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    writeCliResult(
      createResult({
        details: {
          suppressHumanOutput: true
        }
      }),
      true
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(present(writeSpy.mock.calls[0])[0]));
    expect(payload).toMatchObject({
      mode: "check",
      decision: "block",
      exitCode: 2,
      reasons: [
        {
          code: "untrusted-source"
        }
      ]
    });
    expect(payload.infos).toEqual([]);
    expect(payload.details).toBeUndefined();

    writeSpy.mockRestore();
  });

  it("renders info lines with an Info: prefix in human mode", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    writeCliResult(
      createResult({
        decision: "allow",
        exitCode: 0,
        exitCodeMeaning: "Check passed with no direct dependency policy violations.",
        summary: "Check passed: no direct dependency policy violations found.",
        reasons: [],
        infos: ["axios: provenance verified from axios/axios via .github/workflows/release.yml."],
        configLabel: "built-in defaults"
      }),
      false
    );

    const calls = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(calls.some((line) => line.startsWith("Info: "))).toBe(true);
    expect(calls.some((line) => line.includes("provenance verified"))).toBe(true);
    // Infos must NOT be prefixed with "Warning:"
    expect(calls.some((line) => line.startsWith("Warning:") && line.includes("provenance verified"))).toBe(
      false
    );

    errorSpy.mockRestore();
  });
});
