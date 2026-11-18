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
import { present } from "./helpers/present";

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
    expect(present(hooks.PreToolUse)[0]).toMatchObject({ matcher: "Write" });
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
    expect(present(hooks.beforeShellExecution)[0]).toEqual({ command: "./hooks/audit.sh" });
  });

  it("is idempotent when the guard is already registered", () => {
    const once = mergeCursorHooks({});
    expect(once).toBeDefined();
    expect(mergeCursorHooks(once as Record<string, unknown>)).toBeUndefined();
  });
});

// An entry that is there but never runs, or runs without effect, is not an
// installed guard: setup must add a working one instead of reporting success.
describe("entries that look like the guard but do not guard", () => {
  const claude = (group: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...extra,
    hooks: { PreToolUse: [group] }
  });
  const hook = (command: string, fields: Record<string, unknown> = {}) => ({ type: "command", command, ...fields });

  it.each([
    ["a matcher for other tools", claude({ matcher: "Edit", hooks: [hook("safeinstall guard claude")] })],
    ["a matcher that only names Bash in part", claude({ matcher: "BashOutput", hooks: [hook("safeinstall guard claude")] })],
    ["a command that ignores the guard's verdict", claude({ matcher: "Bash", hooks: [hook("safeinstall guard claude || true")] })],
    ["a command that runs something else", claude({ matcher: "Bash", hooks: [hook("/bin/true /safeinstall guard claude")] })],
    ["a comment", claude({ matcher: "Bash", hooks: [hook("true # safeinstall guard claude")] })],
    ["a hook type other than command", claude({ matcher: "Bash", hooks: [{ type: "prompt", command: "safeinstall guard claude" }] })],
    ["a timeout too short to answer", claude({ matcher: "Bash", hooks: [hook("safeinstall guard claude", { timeout: 0 })] })]
  ])("adds the Claude guard next to %s", (_label, existing) => {
    const merged = mergeClaudeSettings(existing);
    expect(merged).toBeDefined();
    expect(mergeClaudeSettings(merged as Record<string, unknown>)).toBeUndefined();
  });

  it.each([
    ["Bash", "safeinstall guard claude"],
    ["*", "safeinstall guard claude"],
    ["Bash|Write", "/usr/local/bin/safeinstall guard claude"],
    ["Bash", "C:\\Users\\dev\\AppData\\Roaming\\npm\\safeinstall.cmd guard claude"],
    ["Bash", '"C:\\Program Files\\nodejs\\safeinstall.cmd" guard claude']
  ])("accepts a working entry with matcher %j and command %j", (matcher, command) => {
    expect(mergeClaudeSettings(claude({ matcher, hooks: [hook(command, { timeout: 60 })] }))).toBeUndefined();
  });

  it("refuses to report success when the settings switch every hook off", () => {
    const existing = claude({ matcher: "Bash", hooks: [hook("safeinstall guard claude")] }, { disableAllHooks: true });
    expect(() => mergeClaudeSettings(existing)).toThrow("disableAllHooks");
  });

  it("adds the Codex guard next to an entry for other tools", () => {
    const existing = { hooks: { PreToolUse: [{ matcher: "apply_patch", hooks: [hook("safeinstall guard codex")] }] } };
    expect(mergeCodexHooks(existing)).toBeDefined();
  });

  it.each([
    ["without failClosed", { command: "safeinstall guard cursor", timeout: 60 }],
    ["with failClosed off", { command: "safeinstall guard cursor", timeout: 60, failClosed: false }],
    ["behind || true", { command: "safeinstall guard cursor || true", failClosed: true }]
  ])("adds the Cursor guard next to an entry %s", (_label, entry) => {
    const merged = mergeCursorHooks({ version: 1, hooks: { beforeShellExecution: [entry] } });
    expect(merged).toBeDefined();
    expect(mergeCursorHooks(merged as Record<string, unknown>)).toBeUndefined();
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
    expect(result.infos.join(" ")).toContain("safeinstall trust lock");
    expect(result.infos.join(" ")).not.toContain("safeinstall trust approve");
  });

  it("requires review and approval when a guard changes an existing trust surface", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-locked-");
    await mkdir(path.join(cwd, ".safeinstall"), { recursive: true });
    await writeFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "{}\n", "utf8");

    const result = await runGuardSetupFlow(cwd, ["guard", "install", "--client", "codex"], {
      clients: ["codex"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.infos.join(" ")).toContain("safeinstall trust status");
    expect(result.infos.join(" ")).toContain("safeinstall trust approve");
    expect(result.infos.join(" ")).not.toContain("safeinstall trust lock");
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

  it("does not request re-baselining when a locked guard is already installed", async () => {
    const cwd = await createTempDir("safeinstall-guard-setup-locked-idem-");
    await runGuardSetupFlow(cwd, ["guard", "install", "--client", "codex"], {
      clients: ["codex"]
    });
    await mkdir(path.join(cwd, ".safeinstall"), { recursive: true });
    await writeFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "{}\n", "utf8");

    const result = await runGuardSetupFlow(cwd, ["guard", "install", "--client", "codex"], {
      clients: ["codex"]
    });

    expect(result.infos.join(" ")).toContain("already registered");
    expect(result.infos.join(" ")).toContain("safeinstall trust status");
    expect(result.infos.join(" ")).toContain("no re-baseline is needed");
    expect(result.infos.join(" ")).not.toContain("safeinstall trust approve");
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
    expect(present(result.reasons[0]).message).toContain("not valid JSON");

    expect(await readFile(configPath, "utf8")).toBe("{ not json");
  });
});
