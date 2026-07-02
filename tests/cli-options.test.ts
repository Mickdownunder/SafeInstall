import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/cli-options";

describe("parseCliOptions", () => {
  it("extracts --json and preserves other args", () => {
    expect(parseCliOptions(["--json", "pnpm", "add", "axios"])).toEqual({
      json: true,
      args: ["pnpm", "add", "axios"],
      configPath: undefined
    });
  });

  it("allows --json after the command", () => {
    expect(parseCliOptions(["check", "--json"])).toEqual({
      json: true,
      args: ["check"],
      configPath: undefined
    });
  });

  it("extracts --config with a separate path argument", () => {
    expect(parseCliOptions(["--config", "./ci/safeinstall.config.json", "check"])).toEqual({
      json: false,
      args: ["check"],
      configPath: "./ci/safeinstall.config.json"
    });
  });

  it("extracts --config=path syntax", () => {
    expect(parseCliOptions(["check", "--config=custom.json"])).toEqual({
      json: false,
      args: ["check"],
      configPath: "custom.json"
    });
  });

  it("combines --config and --json anywhere in the command", () => {
    expect(parseCliOptions(["--json", "pnpm", "add", "axios", "--config", "policy.json"])).toEqual({
      json: true,
      args: ["pnpm", "add", "axios"],
      configPath: "policy.json"
    });
  });

  it("rejects --config without a path", () => {
    expect(() => parseCliOptions(["check", "--config"])).toThrow("--config requires a file path argument.");
  });

  it("rejects --config followed by another flag", () => {
    expect(() => parseCliOptions(["--config", "--json", "check"])).toThrow(
      "--config requires a file path argument."
    );
  });

  it("rejects --config= with an empty value", () => {
    expect(() => parseCliOptions(["check", "--config="])).toThrow("--config requires a file path argument.");
  });
});
