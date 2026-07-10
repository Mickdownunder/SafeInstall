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

  it.each([
    ["case-insensitive manager", "NPM install evil-pkg"],
    ["leading fd redirection", "2>err npm install evil-pkg"],
    ["wrapper value option", "sudo -u root npm install evil-pkg"]
  ])("denies the previously bypassable %s form", async (_label, command) => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command }
    });

    const result = await runGuardHook("claude", event);
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("safeinstall");
  });

  it("asks before npm create downloads and executes a template", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm create vite@latest" }
    });

    const result = await runGuardHook("claude", event);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("fetch and execute");
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

  it("rewrites a raw install through SafeInstall from a Codex event", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install axios" },
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("codex", event);
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: { command: string } };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(response.hookSpecificOutput.updatedInput.command).toBe("safeinstall npm install axios");
  });

  it.each([
    ["case-insensitive manager", "NPM.CMD install evil-pkg"],
    ["leading fd redirection", "2>err npm install evil-pkg"],
    ["wrapper value option", "sudo -u root npm install evil-pkg"]
  ])("rewrites the previously bypassable %s form for Codex", async (_label, command) => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("codex", event);
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput: { command: string } };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(response.hookSpecificOutput.updatedInput.command).toContain("safeinstall");
  });

  it("fails closed before Codex runs a remote registry scaffold", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm create vite@latest" },
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("codex", event);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain("cannot request approval yet");
  });

  it("denies a mixed install and registry-runner command instead of partially rewriting it", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install axios && npx create-next-app" },
      cwd: "/tmp/project"
    });

    const result = await runGuardHook("codex", event);
    const response = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; updatedInput?: { command: string } };
    };
    expect(response.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(response.hookSpecificOutput.updatedInput).toBeUndefined();
  });

  it("stays silent for a harmless Codex Bash command", async () => {
    const event = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" }
    });

    const result = await runGuardHook("codex", event);
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
    // Three client registrations plus the "run trust lock next" hint.
    expect(payload.infos).toHaveLength(4);
    expect(payload.infos.some((info) => info.includes("safeinstall trust lock"))).toBe(true);

    const claudeRaw = await readFile(path.join(cwd, ".claude", "settings.json"), "utf8");
    const codexRaw = await readFile(path.join(cwd, ".codex", "hooks.json"), "utf8");
    const cursorRaw = await readFile(path.join(cwd, ".cursor", "hooks.json"), "utf8");
    expect(claudeRaw).toContain("safeinstall guard claude");
    expect(codexRaw).toContain("safeinstall guard codex");
    expect(cursorRaw).toContain("safeinstall guard cursor");
  });

  it("installs the Codex hook idempotently through the real CLI", async () => {
    const cwd = await createTempDir("safeinstall-guard-install-codex-e2e-");

    const first = await runCli(["guard", "install", "--client", "codex", "--json"], { cwd });
    const second = await runCli(["guard", "install", "--client", "codex", "--json"], { cwd });

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as { infos: string[]; warnings: string[] };
    expect(payload.infos.join(" ")).toContain("already registered");
    expect(payload.warnings.join(" ")).toContain("/hooks");

    const raw = await readFile(path.join(cwd, ".codex", "hooks.json"), "utf8");
    expect(raw.match(/safeinstall guard codex/g)).toHaveLength(1);
  });
});
