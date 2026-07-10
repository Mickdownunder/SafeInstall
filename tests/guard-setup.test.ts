import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  mergeClaudeSettings,
  mergeCodexHooks,
  mergeCursorHooks,
  parseGuardSetupClients,
  runGuardSetupFlow
} from "../src/guard-setup";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";

afterAll(async () => {
  await cleanupTempDirs();
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("parseGuardSetupClients", () => {
  it("defaults to all clients", () => {
    expect(parseGuardSetupClients([])).toEqual(["claude", "codex", "cursor"]);
  });

  it("accepts a single client", () => {
    expect(parseGuardSetupClients(["--client", "cursor"])).toEqual(["cursor"]);
    expect(parseGuardSetupClients(["--client", "codex"])).toEqual(["codex"]);
    expect(parseGuardSetupClients(["--client=claude"])).toEqual(["claude"]);
  });

  it("accepts a comma-separated list", () => {
    expect(parseGuardSetupClients(["--client", "claude,codex,cursor"])).toEqual([
      "claude",
      "codex",
      "cursor"
    ]);
  });

  it("rejects unknown clients", () => {
    expect(parseGuardSetupClients(["--client", "windsurf"])).toBeInstanceOf(Error);
  });

  it("rejects a missing value", () => {
    expect(parseGuardSetupClients(["--client"])).toBeInstanceOf(Error);
  });
});

describe("mergeCodexHooks", () => {
  it("adds the Codex PreToolUse Bash hook", () => {
    const merged = mergeCodexHooks({});
    expect(merged).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "safeinstall guard codex",
                timeout: 60,
                statusMessage: "Checking package safety"
              }
            ]
          }
        ]
      }
    });
  });

  it("preserves existing Codex hooks and is idempotent", () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "./hooks/verify.sh" }] }],
        PreToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "check-edits" }] }]
      }
    };
    const merged = mergeCodexHooks(existing);
    const hooks = merged?.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toEqual(existing.hooks.Stop);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(mergeCodexHooks(merged as Record<string, unknown>)).toBeUndefined();
  });

  it("does not mistake another client's SafeInstall hook for the Codex guard", () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "safeinstall guard claude" }] }
        ]
      }
    };
    const merged = mergeCodexHooks(existing);
    const hooks = (merged?.hooks as Record<string, unknown[]>).PreToolUse;
    expect(hooks).toHaveLength(2);
  });
});

describe("mergeClaudeSettings", () => {
  it("adds the PreToolUse hook to empty settings", () => {
    const merged = mergeClaudeSettings({});
    expect(merged).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "safeinstall guard claude", timeout: 60 }]
          }
        ]
      }
    });
  });

  it("preserves unrelated settings and hooks", () => {
    const existing = {
      model: "opus",
      hooks: {
        PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }],
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "check-secrets" }] }]
      }
    };
    const merged = mergeClaudeSettings(existing);
    expect(merged?.model).toBe("opus");
    const hooks = merged?.hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toMatchObject({ matcher: "Write" });
  });

  it("is idempotent when the guard is already registered", () => {
    const once = mergeClaudeSettings({});
    expect(once).toBeDefined();
    expect(mergeClaudeSettings(once as Record<string, unknown>)).toBeUndefined();
  });
});

describe("mergeCursorHooks", () => {
  it("adds the beforeShellExecution hook with failClosed", () => {
    const merged = mergeCursorHooks({});
    expect(merged).toEqual({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: "safeinstall guard cursor", timeout: 60, failClosed: true }
        ]
      }
    });
  });

  it("preserves an existing version and unrelated hooks", () => {
    const existing = {
      version: 1,
      hooks: {
        afterFileEdit: [{ command: "./hooks/format.sh" }],
        beforeShellExecution: [{ command: "./hooks/audit.sh" }]
      }
    };
    const merged = mergeCursorHooks(existing);
    expect(merged?.version).toBe(1);
    const hooks = merged?.hooks as Record<string, unknown[]>;
    expect(hooks.afterFileEdit).toHaveLength(1);
    expect(hooks.beforeShellExecution).toHaveLength(2);
    expect(hooks.beforeShellExecution[0]).toEqual({ command: "./hooks/audit.sh" });
  });

  it("is idempotent when the guard is already registered", () => {
    const once = mergeCursorHooks({});
    expect(once).toBeDefined();
    expect(mergeCursorHooks(once as Record<string, unknown>)).toBeUndefined();
  });
});

describe("runGuardSetupFlow", () => {
  it("creates all config files in a fresh project", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-");
    const result = await runGuardSetupFlow(cwd, ["guard", "install"], {
      clients: ["claude", "codex", "cursor"]
    });

    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);

    const claude = await readJson(path.join(cwd, ".claude", "settings.json"));
    const codex = await readJson(path.join(cwd, ".codex", "hooks.json"));
    const cursor = await readJson(path.join(cwd, ".cursor", "hooks.json"));
    expect(JSON.stringify(claude)).toContain("safeinstall guard claude");
    expect(JSON.stringify(codex)).toContain("safeinstall guard codex");
    expect(JSON.stringify(cursor)).toContain("safeinstall guard cursor");
  });

  it("is idempotent on a second run", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-idem-");
    await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["cursor"] });
    const second = await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["cursor"] });

    expect(second.decision).toBe("allow");
    expect(second.infos.join(" ")).toContain("already registered");

    const cursor = await readJson(path.join(cwd, ".cursor", "hooks.json"));
    const hooks = (cursor.hooks as Record<string, unknown[]>).beforeShellExecution;
    expect(hooks).toHaveLength(1);
  });

  it("merges into an existing settings file without losing content", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-merge-");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await writeFile(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }, null, 2)
    );

    const result = await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["claude"] });
    expect(result.decision).toBe("allow");

    const claude = await readJson(path.join(cwd, ".claude", "settings.json"));
    expect(claude.permissions).toEqual({ allow: ["Bash(git *)"] });
    expect(JSON.stringify(claude)).toContain("safeinstall guard claude");
  });

  it("merges Codex hooks non-destructively and stays idempotent", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-codex-");
    await mkdir(path.join(cwd, ".codex"), { recursive: true });
    const configPath = path.join(cwd, ".codex", "hooks.json");
    await writeFile(
      configPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./done.sh" }] }] } }, null, 2)
    );

    const first = await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["codex"] });
    const second = await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["codex"] });

    expect(first.decision).toBe("allow");
    expect(second.infos.join(" ")).toContain("already registered");
    const codex = await readJson(configPath);
    const hooks = codex.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(1);
  });

  it("fails without touching a malformed settings file", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-broken-");
    await mkdir(path.join(cwd, ".cursor"), { recursive: true });
    const configPath = path.join(cwd, ".cursor", "hooks.json");
    await writeFile(configPath, "{ not json");

    const result = await runGuardSetupFlow(cwd, ["guard", "install"], { clients: ["cursor"] });
    expect(result.decision).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.reasons[0].message).toContain("not valid JSON");

    expect(await readFile(configPath, "utf8")).toBe("{ not json");
  });
});
