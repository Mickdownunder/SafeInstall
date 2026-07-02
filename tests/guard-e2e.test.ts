import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, cliPath, createTempDir, ensureBuiltCli, runCli } from "./cli-e2e-helpers";

beforeAll(async () => {
  await ensureBuiltCli();
}, 120_000);

afterAll(async () => {
  await cleanupTempDirs();
});

async function runGuardHook(
  client: string,
  stdinPayload: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [cliPath, "guard", client], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.stdin.write(stdinPayload);
  child.stdin.end();

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (exitCode) => resolve(exitCode));
  });

  return { stdout, stderr, code };
}

describe("safeinstall guard (hook mode)", () => {
  it("denies a raw npm install from a Claude Code event", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install axios" }
    });

    const result = await runGuardHook("claude", event);
    expect(result.code).toBe(0);

    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("safeinstall npm install axios");
  });

  it("stays silent for a harmless Claude Code command", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" }
    });

    const result = await runGuardHook("claude", event);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("denies a raw pnpm add from a Cursor event", async () => {
    const event = JSON.stringify({
      hook_event_name: "beforeShellExecution",
      command: "pnpm add zod",
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("cursor", event);
    expect(result.code).toBe(0);

    const response = JSON.parse(result.stdout) as {
      permission: string;
      user_message: string;
      agent_message: string;
    };
    expect(response.permission).toBe("deny");
    expect(response.agent_message).toContain("safeinstall pnpm add zod");
  });

  it("allows a harmless Cursor command explicitly", async () => {
    const event = JSON.stringify({
      hook_event_name: "beforeShellExecution",
      command: "ls -la",
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("cursor", event);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
  });

  it("allows installs already routed through safeinstall", async () => {
    const event = JSON.stringify({
      hook_event_name: "beforeShellExecution",
      command: "safeinstall npm install axios",
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("cursor", event);
    expect(JSON.parse(result.stdout)).toEqual({ permission: "allow" });
  });

  it("stays silent on invalid JSON events (no opinion)", async () => {
    const result = await runGuardHook("claude", "not json at all");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not valid JSON");
  });

  it("rejects an unknown guard client with usage help", async () => {
    const result = await runCli(["guard", "windsurf"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: safeinstall guard");
  });
});

describe("safeinstall guard install (e2e)", () => {
  it("registers hooks and reports them in JSON mode", async () => {
    const cwd = await createTempDir("safeinstall-guard-install-e2e-");

    const result = await runCli(["guard", "install", "--json"], { cwd });
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      decision: string;
      mode: string;
      infos: string[];
    };
    expect(payload.decision).toBe("allow");
    expect(payload.mode).toBe("guard");
    expect(payload.infos).toHaveLength(2);

    const claudeRaw = await readFile(path.join(cwd, ".claude", "settings.json"), "utf8");
    const cursorRaw = await readFile(path.join(cwd, ".cursor", "hooks.json"), "utf8");
    expect(claudeRaw).toContain("safeinstall guard claude");
    expect(cursorRaw).toContain("safeinstall guard cursor");
  });
});
