import { describe, expect, it, vi } from "vitest";

import { writeCliResult } from "../src/output";
import type { CliResult } from "../src/types";

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
    const payload = JSON.parse(String(writeSpy.mock.calls[0][0]));
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
    expect(payload.details).toBeUndefined();

    writeSpy.mockRestore();
  });
});
