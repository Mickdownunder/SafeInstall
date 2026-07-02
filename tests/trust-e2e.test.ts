import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, cliPath, createTempDir, ensureBuiltCli, runCli } from "./cli-e2e-helpers";

beforeAll(async () => {
  await ensureBuiltCli();
}, 120_000);

afterAll(async () => {
  await cleanupTempDirs();
});

async function seedLockedProject(): Promise<{ cwd: string; stateDir: string }> {
  const cwd = await createTempDir("safeinstall-trust-e2e-");
  const stateDir = await createTempDir("safeinstall-trust-state-");
  await writeFile(path.join(cwd, "safeinstall.config.json"), "{}\n");
  await mkdir(path.join(cwd, ".cursor"), { recursive: true });
  await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1 }));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));

  const lock = await runCli(["trust", "lock"], { cwd, env: { SAFEINSTALL_STATE_DIR: stateDir } });
  expect(lock.code).toBe(0);
  return { cwd, stateDir };
}

async function runGuardHook(
  client: string,
  stdinPayload: string,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; code: number | null }> {
  const child = spawn(process.execPath, [cliPath, "guard", client], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stdin.write(stdinPayload);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { stdout, code };
}

describe("safeinstall trust (end to end)", () => {
  it("locks, then verifies clean with exit 0", async () => {
    const { cwd, stateDir } = await seedLockedProject();
    const status = await runCli(["trust", "status"], { cwd, env: { SAFEINSTALL_STATE_DIR: stateDir } });
    expect(status.code).toBe(0);
    expect(status.stderr).toContain("verified");
  });

  it("blocks trust status with exit 2 after an enforcement file is tampered", async () => {
    const { cwd, stateDir } = await seedLockedProject();
    await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1, evil: true }));

    const status = await runCli(["trust", "status", "--json"], {
      cwd,
      env: { SAFEINSTALL_STATE_DIR: stateDir }
    });
    expect(status.code).toBe(2);
    const parsed = JSON.parse(status.stdout) as { decision: string; reasons: Array<{ code: string }> };
    expect(parsed.decision).toBe("block");
    expect(parsed.reasons.some((reason) => reason.code === "trust-enforcement-drift")).toBe(true);
  });

  it("blocks the install flow when the trust surface drifted", async () => {
    const { cwd, stateDir } = await seedLockedProject();
    await writeFile(path.join(cwd, "safeinstall.config.json"), '{"minimumReleaseAgeHours":0}\n');

    const install = await runCli(["--json", "npm", "install", "axios"], {
      cwd,
      env: { SAFEINSTALL_STATE_DIR: stateDir }
    });
    expect(install.code).toBe(2);
    const parsed = JSON.parse(install.stdout) as { reasons: Array<{ code: string }> };
    expect(parsed.reasons.some((reason) => reason.code.startsWith("trust-"))).toBe(true);
  });

  it("makes the guard lock down after tampering, via the real hook process", async () => {
    const { cwd, stateDir } = await seedLockedProject();
    await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1, evil: true }));

    const event = JSON.stringify({
      hook_event_name: "beforeShellExecution",
      command: "git status",
      cwd
    });
    const result = await runGuardHook("cursor", event, { SAFEINSTALL_STATE_DIR: stateDir });
    const response = JSON.parse(result.stdout) as { permission: string };
    expect(response.permission).toBe("deny");
  });

  it("refuses trust approve without an interactive terminal", async () => {
    const { cwd, stateDir } = await seedLockedProject();
    await writeFile(path.join(cwd, ".cursor", "hooks.json"), JSON.stringify({ version: 1, evil: true }));

    const approve = await runCli(["trust", "approve"], {
      cwd,
      env: { SAFEINSTALL_STATE_DIR: stateDir, CI: "true" }
    });
    expect(approve.code).toBe(2);
    expect(approve.stderr).toContain("interactive");
  });
});
