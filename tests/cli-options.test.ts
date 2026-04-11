import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/cli-options";

describe("parseCliOptions", () => {
  it("extracts --json and preserves other args", () => {
    expect(parseCliOptions(["--json", "pnpm", "add", "axios"])).toEqual({
      json: true,
      args: ["pnpm", "add", "axios"]
    });
  });

  it("allows --json after the command", () => {
    expect(parseCliOptions(["check", "--json"])).toEqual({
      json: true,
      args: ["check"]
    });
  });
});
