import { PassThrough, Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runGuardHook } from "../src/guard-flow";

/**
 * A hook that ends with an exception exits with an error the client does not
 * read as a denial, and the command runs unscreened. Any failure inside the
 * decision has to come back as a denial instead.
 */

vi.mock("../src/guard-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/guard-commands")>()),
  analyzeShellCommand: () => {
    throw new SyntaxError("Invalid regular expression");
  }
}));

async function hook(client: "claude" | "cursor", event: object): Promise<{ code: number; output: unknown }> {
  const stdout = new PassThrough();
  let written = "";
  stdout.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  const code = await runGuardHook(client, Readable.from([JSON.stringify(event)]), stdout);
  return { code, output: JSON.parse(written) };
}

describe("guard hook when the analysis throws", () => {
  it("denies the command for Claude Code instead of failing open", async () => {
    const { code, output } = await hook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install evil" },
      cwd: process.cwd()
    });
    expect(code).toBe(0);
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" }
    });
    expect(JSON.stringify(output)).toContain("Invalid regular expression");
  });

  it("denies the command for Cursor instead of failing open", async () => {
    const { output } = await hook("cursor", {
      hook_event_name: "beforeShellExecution",
      command: "npm install evil",
      cwd: process.cwd()
    });
    expect(output).toMatchObject({ permission: "deny" });
  });
});
