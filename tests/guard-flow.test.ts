import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { decideGuard, parseGuardEvent, renderGuardResponse } from "../src/guard-flow";
import { runTrustLockFlow } from "../src/trust-flow";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";

afterAll(async () => {
  await cleanupTempDirs();
});

beforeEach(async () => {
  process.env.SAFEINSTALL_STATE_DIR = await createTempDir("safeinstall-state-");
});

describe("parseGuardEvent", () => {
  it("extracts the command and cwd from a Claude Code PreToolUse Bash event", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/tmp/project",
      tool_input: { command: "npm install axios", description: "Install axios" }
    };
    expect(parseGuardEvent(event, "claude")).toEqual({
      kind: "shell-command",
      command: "npm install axios",
      cwd: "/tmp/project"
    });
  });

  it("skips Claude events for other tools", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x", content: "npm install evil" }
    };
    expect(parseGuardEvent(event, "claude")).toMatchObject({ kind: "not-applicable" });
  });

  it("skips Claude events for other hook events", () => {
    const event = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
    expect(parseGuardEvent(event, "claude")).toMatchObject({ kind: "not-applicable" });
  });

  it("extracts the command and cwd from a Codex PreToolUse Bash event", () => {
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      cwd: "/tmp/project",
      tool_input: { command: "pnpm add zod" }
    };
    expect(parseGuardEvent(event, "codex")).toEqual({
      kind: "shell-command",
      command: "pnpm add zod",
      cwd: "/tmp/project"
    });
  });

  it("extracts the command and cwd from a Cursor beforeShellExecution event", () => {
    const event = {
      hook_event_name: "beforeShellExecution",
      command: "pnpm add zod",
      cwd: "/tmp/project"
    };
    expect(parseGuardEvent(event, "cursor")).toEqual({
      kind: "shell-command",
      command: "pnpm add zod",
      cwd: "/tmp/project"
    });
  });

  it("tolerates Cursor events without hook_event_name", () => {
    expect(parseGuardEvent({ command: "ls" }, "cursor")).toEqual({
      kind: "shell-command",
      command: "ls",
      cwd: undefined
    });
  });

  it("reports non-object payloads as not applicable", () => {
    expect(parseGuardEvent("nonsense", "cursor")).toMatchObject({ kind: "not-applicable" });
    expect(parseGuardEvent(null, "claude")).toMatchObject({ kind: "not-applicable" });
  });

  it("reports missing command fields as not applicable", () => {
    expect(parseGuardEvent({ hook_event_name: "beforeShellExecution" }, "cursor")).toMatchObject({
      kind: "not-applicable"
    });
    expect(
      parseGuardEvent({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "claude")
    ).toMatchObject({ kind: "not-applicable" });
  });
});

describe("decideGuard", () => {
  it("allows non-install commands", async () => {
    expect(await decideGuard("git status")).toEqual({ action: "allow" });
    expect(await decideGuard("npm test")).toEqual({ action: "allow" });
  });

  it("allows installs already routed through safeinstall", async () => {
    expect(await decideGuard("safeinstall npm install axios")).toEqual({ action: "allow" });
  });

  it("denies raw installs and hands the agent the rewritten command", async () => {
    const decision = await decideGuard("npm i axios && npm test");
    expect(decision.action).toBe("deny");
    expect(decision.updatedCommand).toBe("safeinstall npm install axios && npm test");
    expect(decision.agentMessage).toContain("safeinstall npm install axios && npm test");
    expect(decision.agentMessage).toContain("lifecycle scripts stay disabled");
    expect(decision.userMessage).toBeTruthy();
  });

  it("denies unanalyzable install segments with the analysis reason", async () => {
    const decision = await decideGuard("npm install $PKG");
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).toContain("could not verify");
    expect(decision.agentMessage).toContain("variable expansion");
  });

  it("denies yarn installs with an explanation", async () => {
    const decision = await decideGuard("yarn add axios");
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).toContain("yarn");
  });

  it("asks for npx of a binary that is not installed locally", async () => {
    const cwd = await createTempDir("safeinstall-guard-npx-");
    const decision = await decideGuard("npx create-next-app", cwd);
    expect(decision.action).toBe("ask");
    expect(decision.userMessage).toContain('"create-next-app"');
    expect(decision.agentMessage).toContain("policy-checked");
  });

  it("allows npx of a locally installed binary", async () => {
    const cwd = await createTempDir("safeinstall-guard-npx-local-");
    const binDir = path.join(cwd, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "tsc"), "#!/bin/sh\n", { mode: 0o755 });

    expect(await decideGuard("npx tsc --noEmit", cwd)).toEqual({ action: "allow" });
  });

  it("finds local binaries by walking upward from a nested cwd", async () => {
    const root = await createTempDir("safeinstall-guard-npx-walkup-");
    const binDir = path.join(root, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "vitest"), "#!/bin/sh\n", { mode: 0o755 });
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    expect(await decideGuard("npx vitest run", nested)).toEqual({ action: "allow" });
  });

  it("asks for dlx-style runners even when a local binary exists", async () => {
    const cwd = await createTempDir("safeinstall-guard-dlx-");
    const binDir = path.join(cwd, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "create-app"), "#!/bin/sh\n", { mode: 0o755 });

    const decision = await decideGuard("pnpm dlx create-app", cwd);
    expect(decision.action).toBe("ask");
  });

  it("asks for version-suffixed npx targets even when the binary exists locally", async () => {
    const cwd = await createTempDir("safeinstall-guard-npx-version-");
    const binDir = path.join(cwd, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "cowsay"), "#!/bin/sh\n", { mode: 0o755 });

    const decision = await decideGuard("npx cowsay@1.5.0 hi", cwd);
    expect(decision.action).toBe("ask");
  });

  it("prefers deny over ask when a command mixes installs and runners", async () => {
    const cwd = await createTempDir("safeinstall-guard-mixed-");
    const decision = await decideGuard("npm install axios && npx create-next-app", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.updatedCommand).toBeUndefined();
  });
});

describe("decideGuard minimumCliVersion", () => {
  it("enriches deny messages when the running CLI is older than the project minimum", async () => {
    const cwd = await createTempDir("safeinstall-guard-cliversion-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "999.0.0" })
    );

    const decision = await decideGuard("npm install axios", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.updatedCommand).toBe("safeinstall npm install axios");
    expect(decision.agentMessage).toContain("safeinstall-cli >= 999.0.0");
    expect(decision.userMessage).toContain("safeinstall-cli >= 999.0.0");
    expect(decision.agentMessage).toContain("npm install -g safeinstall-cli@latest");
  });

  it("enriches ask messages when the running CLI is older than the project minimum", async () => {
    const cwd = await createTempDir("safeinstall-guard-cliversion-ask-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "999.0.0" })
    );

    const decision = await decideGuard("npx create-next-app", cwd);
    expect(decision.action).toBe("ask");
    expect(decision.userMessage).toContain("safeinstall-cli >= 999.0.0");
  });

  it("leaves messages untouched when the running CLI satisfies the minimum", async () => {
    const cwd = await createTempDir("safeinstall-guard-cliversion-ok-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "0.0.1" })
    );

    const decision = await decideGuard("npm install axios", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).not.toContain("safeinstall-cli >=");
  });

  it("keeps the verdict and skips the warning when the config cannot be parsed", async () => {
    const cwd = await createTempDir("safeinstall-guard-cliversion-broken-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "not-a-version" })
    );

    const decision = await decideGuard("npm install axios", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.updatedCommand).toBe("safeinstall npm install axios");
    expect(decision.agentMessage).not.toContain("safeinstall-cli >=");
  });

  it("does not read the config for allowed commands", async () => {
    const cwd = await createTempDir("safeinstall-guard-cliversion-allow-");
    await writeFile(
      path.join(cwd, "safeinstall.config.json"),
      JSON.stringify({ minimumCliVersion: "999.0.0" })
    );

    expect(await decideGuard("git status", cwd)).toEqual({ action: "allow" });
  });
});

describe("decideGuard trust surface", () => {
  async function lockedProject(): Promise<string> {
    const root = await createTempDir("safeinstall-guard-trust-");
    await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1 }));
    await writeFile(path.join(root, "AGENTS.md"), "# rules\n");
    await runTrustLockFlow(root, ["trust", "lock"]);
    return root;
  }

  it("stays out of the way for unlocked projects", async () => {
    const cwd = await createTempDir("safeinstall-guard-unlocked-");
    expect(await decideGuard("git status", cwd)).toEqual({ action: "allow" });
  });

  it("locks down every command when an enforcement file drifted", async () => {
    const root = await lockedProject();
    await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1, tampered: true }));

    const decision = await decideGuard("git status", root);
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).toContain("without approval");
    expect(decision.agentMessage).toContain("safeinstall trust approve");
  });

  it("denies a shell write that targets a protected file", async () => {
    const root = await lockedProject();
    const decision = await decideGuard("echo evil > safeinstall.config.json", root);
    expect(decision.action).toBe("deny");
    expect(decision.userMessage).toContain("safeinstall.config.json");
  });

  it("denies sed -i tampering of an agent rules file", async () => {
    const root = await lockedProject();
    const decision = await decideGuard("sed -i 's/x/y/' AGENTS.md", root);
    expect(decision.action).toBe("deny");
  });

  it("blocks installs when the MCP tool surface changed but leaves other commands alone", async () => {
    const root = await createTempDir("safeinstall-guard-tool-");
    await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"] } } })
    );
    await runTrustLockFlow(root, ["trust", "lock"]);

    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"] },
          evil: { command: "npx", args: ["-y", "evil-mcp"] }
        }
      })
    );

    expect((await decideGuard("npm install axios", root)).action).toBe("deny");
    expect(await decideGuard("git status", root)).toEqual({ action: "allow" });
  });
});

describe("renderGuardResponse", () => {
  it("renders a Claude allow as no output (no opinion)", () => {
    const response = renderGuardResponse({ action: "allow" }, "claude");
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBeUndefined();
  });

  it("renders a Claude deny in the hookSpecificOutput protocol", () => {
    const response = renderGuardResponse(
      { action: "deny", userMessage: "Blocked.", agentMessage: "Run safeinstall instead." },
      "claude"
    );
    expect(response.exitCode).toBe(0);
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Run safeinstall instead."
      }
    });
  });

  it("rewrites a raw install through SafeInstall using Claude updatedInput without a permissionDecision", () => {
    const response = renderGuardResponse(
      {
        action: "deny",
        updatedCommand: "safeinstall npm install axios",
        agentMessage: "Use SafeInstall."
      },
      "claude"
    );
    // No permissionDecision key: the command is replaced in place while the
    // normal Claude permission prompt stays active and shows the rewrite.
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "safeinstall npm install axios" },
        additionalContext: "SafeInstall routed this package-manager command through its policy-enforcing CLI."
      }
    });
  });

  it("keeps a hard deny for Claude when there is no rewrite (mixed runner)", () => {
    const response = renderGuardResponse(
      { action: "deny", userMessage: "Blocked.", agentMessage: "Mixed with a runner." },
      "claude"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Mixed with a runner."
      }
    });
  });

  it("renders a Codex allow as no output (no opinion)", () => {
    const response = renderGuardResponse({ action: "allow" }, "codex");
    expect(response.exitCode).toBe(0);
    expect(response.stdout).toBeUndefined();
  });

  it("rewrites a raw install through SafeInstall using Codex updatedInput", () => {
    const response = renderGuardResponse(
      {
        action: "deny",
        updatedCommand: "safeinstall npm install axios",
        agentMessage: "Use SafeInstall."
      },
      "codex"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "safeinstall npm install axios" },
        additionalContext: "SafeInstall routed this package-manager command through its policy-enforcing CLI."
      }
    });
  });

  it("renders a Codex policy block as deny", () => {
    const response = renderGuardResponse(
      { action: "deny", userMessage: "Blocked.", agentMessage: "Trust surface drifted." },
      "codex"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Trust surface drifted."
      }
    });
  });

  it("fails closed for Codex runner approval because PreToolUse ask is unsupported", () => {
    const response = renderGuardResponse(
      { action: "ask", userMessage: "npx fetches remote code.", agentMessage: "Ask the user." },
      "codex"
    );
    const output = JSON.parse(response.stdout ?? "") as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("cannot request approval yet");
  });

  it("renders a Cursor allow with an explicit permission", () => {
    const response = renderGuardResponse({ action: "allow" }, "cursor");
    expect(JSON.parse(response.stdout ?? "")).toEqual({ permission: "allow" });
  });

  it("renders a Cursor deny with snake_case message fields", () => {
    const response = renderGuardResponse(
      { action: "deny", userMessage: "Blocked.", agentMessage: "Run safeinstall instead." },
      "cursor"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      permission: "deny",
      user_message: "Blocked.",
      agent_message: "Run safeinstall instead."
    });
  });

  it("renders a Claude ask with the user-facing reason", () => {
    const response = renderGuardResponse(
      { action: "ask", userMessage: "npx fetches remote code.", agentMessage: "Ask the user." },
      "claude"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "npx fetches remote code."
      }
    });
  });

  it("renders a Cursor ask with both messages", () => {
    const response = renderGuardResponse(
      { action: "ask", userMessage: "npx fetches remote code.", agentMessage: "Ask the user." },
      "cursor"
    );
    expect(JSON.parse(response.stdout ?? "")).toEqual({
      permission: "ask",
      user_message: "npx fetches remote code.",
      agent_message: "Ask the user."
    });
  });
});
