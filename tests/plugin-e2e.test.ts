import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, createTempDir, projectRoot, startRegistryFixture, writeDefaultConfig, writeJson } from "./cli-e2e-helpers";

const exec = promisify(execFile);
let plugin: string;
let runner: string;
let engineVersion: string;

async function run(args: string[], cwd: string, input?: string, env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function event(command: string, cwd: string) {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
}

function decision(stdout: string) {
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; updatedInput?: unknown } }).hookSpecificOutput;
}

beforeAll(async () => {
  engineVersion = (JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
  await exec(process.execPath, [path.join(projectRoot, "scripts", "build-plugin.mjs")], { cwd: projectRoot, timeout: 90000 });
  const extracted = await createTempDir("safeinstall-plugin-extracted-");
  await exec("tar", ["-xzf", path.join(projectRoot, "dist", "safeinstall-plugin-0.1.0.tgz"), "-C", extracted]);
  plugin = path.join(extracted, "safeinstall");
  runner = path.join(plugin, "scripts", "run.cjs");
}, 100000);
afterAll(cleanupTempDirs);

describe("extracted SafeInstall plugin", () => {
  it("rejects unsupported Node versions before loading the engine, including fail-closed hooks", async () => {
    for (const version of ["20.19.0", "22.22.0", "22.22.1", "23.0.0", "24.14.0", "25.3.0"]) {
      // Run the actual distributed entry with only the reported version changed.
      const script = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); process.argv = [process.execPath, ${JSON.stringify(runner)}, 'cli', '--version']; require(${JSON.stringify(runner)});`;
      await expect(exec(process.execPath, ["-e", script])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("requires Node.js") });
    }
    for (const version of ["22.22.2", "24.15.0", "26.0.0"]) {
      const script = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); process.argv = [process.execPath, ${JSON.stringify(runner)}, 'cli', '--version']; require(${JSON.stringify(runner)});`;
      expect((await exec(process.execPath, ["-e", script])).stdout.trim()).toBe(engineVersion);
    }
    const script = `Object.defineProperty(process.versions, 'node', { value: '22.22.1' }); process.argv = [process.execPath, ${JSON.stringify(runner)}, 'guard']; require(${JSON.stringify(runner)});`;
    await expect(exec(process.execPath, ["-e", script])).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('"permissionDecision":"deny"') });
  });

  it("contains the runtime dependency graph as regular files for host cache copying", async () => {
    const inventory = JSON.parse(await readFile(path.join(plugin, "runtime", "inventory.json"), "utf8")) as {
      cliVersion: string; lockfileSha256: string; packages: Array<{ name: string; path: string; version: string }>;
    };
    expect(inventory.cliVersion).toBe(engineVersion);
    expect(inventory.lockfileSha256).toBe(createHash("sha256").update(await readFile(path.join(projectRoot, "pnpm-lock.yaml"))).digest("hex"));
    expect(inventory.packages.map(item => item.name)).toContain("sigstore");
    expect(inventory.packages.map(item => item.name)).toContain("@modelcontextprotocol/sdk");
    expect(inventory.packages.map(item => item.name)).not.toContain("typescript");
    expect(inventory.packages.map(item => item.name)).not.toContain("vitest");
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir)) {
        const file = path.join(dir, entry);
        const stat = await lstat(file);
        expect(stat.isSymbolicLink(), file).toBe(false);
        if (stat.isDirectory()) await walk(file);
      }
    }
    await walk(plugin);
    const version = await run(["cli", "--version"], plugin);
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(engineVersion);
  });

  it("connects over real stdio MCP and evaluates the requested project's actual policy", async () => {
    const registry = await startRegistryFixture();
    const cwd = await createTempDir("safeinstall-plugin-project-");
    await writeDefaultConfig(cwd, { registryUrl: registry.url });
    const client = new Client({ name: "plugin-test", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner, "mcp"], cwd: plugin }));
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(["check_package", "protection_status"]);
      const result = await client.callTool({ name: "check_package", arguments: { projectPath: cwd, name: "axios", version: "1.14.0", manager: "npm" } });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ verdict: "allow", name: "axios", version: "1.14.0" });
      const invalid = await client.callTool({ name: "check_package", arguments: { projectPath: "relative", name: "axios" } });
      expect(invalid.isError).toBe(true);
      const injection = await client.callTool({ name: "protection_status", arguments: { projectPath: cwd, command: "npm install" } });
      expect(injection.isError).toBe(true);
      const status = await client.callTool({ name: "protection_status", arguments: { projectPath: cwd } });
      const statusContent = status.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(statusContent[0]!.text)).toMatchObject({ projectPath: cwd, securePreset: false, policyPath: path.join(cwd, "safeinstall.config.json"), hookActivation: expect.stringContaining("unknown") });
    } finally { await client.close(); await registry.close(); }
  });

  it("denies raw installs without implicit permission grants or PATH CLI execution", async () => {
    const cwd = await createTempDir("safeinstall-plugin-guard-");
    const fakePath = path.join(cwd, "fake-bin");
    await mkdir(fakePath);
    await writeFile(path.join(fakePath, "safeinstall"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const blocked = await run(["guard"], cwd, event("npm install axios", cwd), { ...process.env, PATH: fakePath });
    expect(blocked.code).toBe(0);
    expect(decision(blocked.stdout)).toMatchObject({ permissionDecision: "deny" });
    expect(decision(blocked.stdout).updatedInput).toBeUndefined();
    const normal = await run(["guard"], cwd, event("git status --short", cwd));
    expect(normal).toMatchObject({ code: 0, stdout: "" });
    const remote = await run(["guard"], cwd, event("npx never-installed-fixture", cwd));
    expect(decision(remote.stdout).permissionDecision).toBe("deny");
  });

  it("fails closed on malformed, oversized and incomplete hook events", async () => {
    const cwd = await createTempDir("safeinstall-plugin-malformed-");
    for (const input of ["{", "x".repeat(262145), JSON.stringify({ hook_event_name: "PreToolUse", cwd })]) {
      const result = await run(["guard"], cwd, input);
      expect(result.code).toBe(2);
      expect(decision(result.stdout).permissionDecision).toBe("deny");
    }
  });

  it("sets up without duplicate hooks, preserves policy, then detects trust drift", async () => {
    const cwd = await createTempDir("safeinstall-plugin-setup-");
    await writeJson(path.join(cwd, "package.json"), { name: "plugin-consumer", version: "1.0.0", private: true });
    const setup = await run(["cli", "init", "--no-guard", "--mode", "strict", "--json"], cwd);
    expect(setup.code, setup.stderr + setup.stdout).toBe(0);
    const config = await readFile(path.join(cwd, "safeinstall.config.json"), "utf8");
    const repeated = await run(["cli", "init", "--no-guard", "--mode", "strict", "--json"], cwd);
    expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0);
    expect(await readFile(path.join(cwd, "safeinstall.config.json"), "utf8")).toBe(config);
    const baseline = await readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8");
    await writeFile(path.join(cwd, "safeinstall.config.json"), config.replace('"minimumReleaseAgeHours": 72', '"minimumReleaseAgeHours": 0'));
    const drift = await run(["cli", "trust", "status", "--json"], cwd);
    expect(drift.code).toBe(2);
    expect(JSON.parse(drift.stdout).summary).toContain("drift");
    const guard = await run(["guard"], cwd, event("npm install axios", cwd));
    expect(decision(guard.stdout).permissionDecision).toBe("deny");
    const reinit = await run(["cli", "init", "--no-guard", "--mode", "strict", "--json"], cwd);
    // Existing trust lock creation reports a refusal as CLI error (1), whereas
    // the read-only status reports policy drift as block (2). Neither blesses it.
    expect(reinit.code, reinit.stdout + reinit.stderr).toBe(1);
    expect(JSON.parse(reinit.stdout).decision).not.toBe("allow");
    expect(await readFile(path.join(cwd, ".safeinstall", "trust-surface.lock"), "utf8")).toBe(baseline);
  });

  it("refuses trust approval and duplicate hook registration even behind global options", async () => {
    const cwd = await createTempDir("safeinstall-plugin-bypass-");
    for (const args of [["--json", "trust", "approve"], ["--json", "guard", "install"], ["init", "--no-guard", "--no-lock"]]) {
      const result = await run(["cli", ...args], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("SafeInstall plugin:");
    }
    const unsupported = await run(["cli", "npm", "install", "github:axios/axios", "--json"], cwd);
    expect(unsupported.code).toBe(2);
    expect(JSON.parse(unsupported.stdout).decision).toBe("block");
  });
});
