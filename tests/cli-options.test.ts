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
    expect(parseCliOptions(["--config=custom.json", "check"])).toEqual({
      json: false,
      args: ["check"],
      configPath: "custom.json"
    });
  });

  it("combines leading --config with --json after the command", () => {
    expect(parseCliOptions(["--config", "policy.json", "pnpm", "add", "axios", "--json"])).toEqual({
      json: true,
      args: ["pnpm", "add", "axios"],
      configPath: "policy.json"
    });
  });

  it.each([
    ["separate install option", ["pnpm", "add", "axios", "--config", "policy.json"]],
    ["equals install option", ["npm", "install", "axios", "--config=policy.json"]],
    ["manager option", ["pnpm", "--config", "policy.json", "add", "axios"]],
    ["positional separator", ["npm", "install", "--", "--config=policy.json"]],
    ["check option", ["check", "--config=policy.json"]]
  ])("rejects a trailing --config in the %s form", (_label, argv) => {
    expect(() => parseCliOptions(argv)).toThrow("--config must appear before the SafeInstall command.");
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
