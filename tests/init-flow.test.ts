import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseInitOptions, runInitFlow } from "../src/init-flow";
import type { InitOptions } from "../src/init-flow";

const tempDirs: string[] = [];

async function createTempDir(prefix = "safeinstall-init-"): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

const defaultOptions: InitOptions = { force: false, guard: true, lock: true };

let previousStateDir: string | undefined;

beforeEach(async () => {
  // The trust lock writes a ledger-head mirror outside the workspace; keep
  // it inside the test sandbox instead of the real ~/.safeinstall.
  previousStateDir = process.env.SAFEINSTALL_STATE_DIR;
  process.env.SAFEINSTALL_STATE_DIR = await createTempDir("safeinstall-init-state-");
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.SAFEINSTALL_STATE_DIR;
  } else {
    process.env.SAFEINSTALL_STATE_DIR = previousStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("parseInitOptions", () => {
  it("defaults to guard and lock enabled with auto-detection", () => {
    expect(parseInitOptions(["init"])).toEqual({ force: false, guard: true, lock: true });
  });

  it("parses opt-outs, forced clients, and the lock mode", () => {
    expect(parseInitOptions(["init", "--force", "--no-guard", "--no-lock"])).toEqual({
      force: true,
      guard: false,
      lock: false
    });
    expect(parseInitOptions(["init", "--client", "cursor,claude", "--client=claude"])).toMatchObject({
      clients: ["cursor", "claude"]
    });
    expect(parseInitOptions(["init", "--client", "codex"])).toMatchObject({ clients: ["codex"] });
    expect(parseInitOptions(["init", "--mode", "strict"])).toMatchObject({ mode: "strict" });
  });

  it("rejects unknown options, bad clients, and bad modes", () => {
    expect(parseInitOptions(["init", "--frce"])).toBeInstanceOf(Error);
    expect(parseInitOptions(["init", "--client", "copilot"])).toBeInstanceOf(Error);
    expect(parseInitOptions(["init", "--client"])).toBeInstanceOf(Error);
    expect(parseInitOptions(["init", "--mode", "loose"])).toBeInstanceOf(Error);
  });
});

describe("runInitFlow", () => {
  it("creates the config, skips the guard without an agent, and locks the trust surface", async () => {
    const cwd = await createTempDir();

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("guard: no agent detected");
    expect(result.summary).toContain("trust surface: locked");

    const configText = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    expect(JSON.parse(configText)).toMatchObject({
      minimumReleaseAgeHours: 72,
      registryUrl: "https://registry.npmjs.org"
    });
    await expect(readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8")).resolves.toContain(
      "safeinstall.config.json"
    );
  });

  it("keeps an existing config without --force and still completes", async () => {
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, "safeinstall.config.json"), '{"minimumReleaseAgeHours":1}\n', "utf8");

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
    expect(result.details?.overwritten).toBe(false);
    expect(result.summary).toContain("config: kept");

    const configText = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    expect(JSON.parse(configText).minimumReleaseAgeHours).toBe(1);
  });

  it("overwrites an existing config when --force is provided", async () => {
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, "safeinstall.config.json"), '{"minimumReleaseAgeHours":1}\n', "utf8");

    const result = await runInitFlow(cwd, ["init", "--force"], { ...defaultOptions, force: true });

    expect(result.decision).toBe("allow");
    expect(result.details?.overwritten).toBe(true);

    const configText = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    expect(JSON.parse(configText).minimumReleaseAgeHours).toBe(72);
  });

  it("registers guard hooks for a detected agent before locking, so the lock covers them", async () => {
    const cwd = await createTempDir();
    await mkdir(path.join(cwd, ".claude"));

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("guard: claude");

    const settings = JSON.parse(await readFile(path.join(cwd, ".claude", "settings.json"), "utf8"));
    const hookCommands = JSON.stringify(settings.hooks.PreToolUse);
    expect(hookCommands).toContain("safeinstall guard claude");

    const lockText = await readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8");
    expect(lockText).toContain(path.join(".claude", "settings.json"));
  });

  it("detects Codex via AGENTS.md and writes its hook file before locking", async () => {
    const cwd = await createTempDir();
    await writeFile(path.join(cwd, "AGENTS.md"), "# Agent instructions\n", "utf8");

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("guard: codex");
    const hooks = JSON.parse(await readFile(path.join(cwd, ".codex", "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks.hooks.PreToolUse)).toContain("safeinstall guard codex");
    const lockText = await readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8");
    expect(lockText).toContain(path.join(".codex", "hooks.json"));
  });

  it("honors an explicit --client list instead of detection", async () => {
    const cwd = await createTempDir();

    const result = await runInitFlow(cwd, ["init", "--client", "cursor"], {
      ...defaultOptions,
      clients: ["cursor"]
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("guard: cursor");
    const hooks = JSON.parse(await readFile(path.join(cwd, ".cursor", "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks.hooks.beforeShellExecution)).toContain("safeinstall guard cursor");
  });

  it("is idempotent on a clean re-run and leaves the lock bytes unchanged", async () => {
    const cwd = await createTempDir();
    await mkdir(path.join(cwd, ".claude"));
    await runInitFlow(cwd, ["init"], defaultOptions);
    const lockPath = path.join(cwd, ".safeinstall", "trust-surface.lock");
    const lockBefore = await readFile(lockPath, "utf8");

    const rerun = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(rerun.decision).toBe("allow");
    expect(rerun.exitCode).toBe(0);
    expect(rerun.infos.join("\n")).toContain("already registered");
    expect(rerun.infos.join("\n")).toContain("Baseline unchanged");
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockBefore);
  });

  it("refuses to re-baseline a drifted trust surface", async () => {
    const cwd = await createTempDir();
    await runInitFlow(cwd, ["init"], defaultOptions);
    const lockPath = path.join(cwd, ".safeinstall", "trust-surface.lock");
    const lockBefore = await readFile(lockPath, "utf8");
    // Tamper with a locked enforcement-zone file after the baseline exists.
    await appendFile(path.join(cwd, "safeinstall.config.json"), "\n", "utf8");

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.decision).toBe("error");
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.summary).toContain("Init stopped");
    expect(result.reasons.some((reason) => reason.code.startsWith("trust-"))).toBe(true);
    // The critical guarantee: the drifted state was NOT blessed with a new lock.
    await expect(readFile(lockPath, "utf8")).resolves.toBe(lockBefore);
  });

  it("stops with the guard failure when a hook file is unparseable", async () => {
    const cwd = await createTempDir();
    await mkdir(path.join(cwd, ".claude"));
    await writeFile(path.join(cwd, ".claude", "settings.json"), "{not json", "utf8");

    const result = await runInitFlow(cwd, ["init"], defaultOptions);

    expect(result.decision).toBe("error");
    expect(result.reasons[0]?.code).toBe("guard-setup-failed");
    // The lock must not run over a half-configured surface.
    await expect(readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8")).rejects.toThrow();
  });

  it("skips guard and lock on explicit opt-outs", async () => {
    const cwd = await createTempDir();
    await mkdir(path.join(cwd, ".claude"));

    const result = await runInitFlow(cwd, ["init", "--no-guard", "--no-lock"], {
      force: false,
      guard: false,
      lock: false
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("guard: skipped");
    expect(result.summary).toContain("trust surface: skipped");
    await expect(readFile(path.join(cwd, ".claude", "settings.json"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8")).rejects.toThrow();
  });
});
