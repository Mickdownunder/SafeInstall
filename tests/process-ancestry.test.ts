import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findAncestorMarker, type ProcessInfo } from "../src/process-ancestry";
import { cleanupTempDirs, cliPath, createTempDir, ensureBuiltCli, runCli } from "./cli-e2e-helpers";

const MARKERS = ["CI", "CLAUDECODE", "CODEX_SHELL", "CURSOR_AGENT"];

function readerFor(table: Record<number, ProcessInfo>) {
  return (pid: number): ProcessInfo | undefined => table[pid];
}

describe("findAncestorMarker", () => {
  it("finds a marker several levels up", () => {
    const reader = readerFor({
      30: { parentPid: 20, env: { PATH: "/bin" } },
      20: { parentPid: 10, env: { CLAUDECODE: "1" } },
      10: { parentPid: 1, env: {} }
    });
    expect(findAncestorMarker(MARKERS, 30, reader)).toBe("CLAUDECODE");
  });

  it("returns undefined for a clean chain up to init", () => {
    const reader = readerFor({
      30: { parentPid: 20, env: { PATH: "/bin" } },
      20: { parentPid: 1, env: { HOME: "/home/me" } }
    });
    expect(findAncestorMarker(MARKERS, 30, reader)).toBeUndefined();
  });

  it("treats explicitly disabled markers as absent", () => {
    const reader = readerFor({
      30: { parentPid: 20, env: { CI: "false", CLAUDECODE: "0", CODEX_SHELL: "" } },
      20: { parentPid: 1, env: {} }
    });
    expect(findAncestorMarker(MARKERS, 30, reader)).toBeUndefined();
  });

  it("skips an ancestor whose environment cannot be read and keeps walking", () => {
    const reader = readerFor({
      30: { parentPid: 20, env: undefined },
      20: { parentPid: 1, env: { CURSOR_AGENT: "1" } }
    });
    expect(findAncestorMarker(MARKERS, 30, reader)).toBe("CURSOR_AGENT");
  });

  it("stops on a parent cycle instead of looping", () => {
    const reader = readerFor({
      30: { parentPid: 20, env: {} },
      20: { parentPid: 30, env: {} }
    });
    expect(findAncestorMarker(MARKERS, 30, reader)).toBeUndefined();
  });

  it("does nothing on a platform without a process reader", () => {
    expect(findAncestorMarker(MARKERS, 30, undefined)).toBeUndefined();
  });
});

const inspectsAncestors =
  (process.platform === "linux" && existsSync("/proc/self/environ")) || process.platform === "darwin";

describe.skipIf(!inspectsAncestors)("human gate against a dropped marker (end to end)", () => {
  beforeAll(async () => {
    await ensureBuiltCli();
  }, 120_000);

  afterAll(async () => {
    await cleanupTempDirs();
  });

  async function seedLockedProject(): Promise<{ cwd: string; stateDir: string }> {
    const cwd = await createTempDir("safeinstall-ancestry-e2e-");
    const stateDir = await createTempDir("safeinstall-ancestry-state-");
    await writeFile(path.join(cwd, "safeinstall.config.json"), "{}\n");
    await mkdir(path.join(cwd, ".cursor"), { recursive: true });
    await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1 }));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
    const lock = await runCli(["trust", "lock"], { cwd, env: { SAFEINSTALL_STATE_DIR: stateDir } });
    expect(lock.code).toBe(0);
    return { cwd, stateDir };
  }

  // An intermediate process that carries the marker and starts the CLI with
  // the marker removed from the child's environment — what `env -u` does.
  const launcher = `
    const { spawnSync } = require("node:child_process");
    const env = { ...process.env };
    for (const name of ${JSON.stringify(MARKERS)}) delete env[name];
    const result = spawnSync(process.execPath, process.argv.slice(1), { env, encoding: "utf8" });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  `;

  for (const subcommand of ["unlock", "approve"]) {
    it(`refuses trust ${subcommand} when only a parent process carries the marker`, async () => {
      const { cwd, stateDir } = await seedLockedProject();
      // `approve` only reaches the human gate when there is drift to approve.
      await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 2 }));
      const env: NodeJS.ProcessEnv = { ...process.env, SAFEINSTALL_STATE_DIR: stateDir };
      for (const name of MARKERS) {
        delete env[name];
      }
      env.CODEX_SHELL = "1";

      const result = spawnSync(process.execPath, ["-e", launcher, cliPath, "trust", subcommand], {
        cwd,
        env,
        encoding: "utf8"
      });

      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("a parent process has CODEX_SHELL set");
      expect(existsSync(path.join(cwd, ".safeinstall", "trust-surface.lock"))).toBe(true);
    });
  }
});
