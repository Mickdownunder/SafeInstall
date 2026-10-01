import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "safeinstall-client-smoke-"));
const env = { ...process.env, CODEX_HOME: path.join(scratch, "codex-home") };
const proofDir = path.join(root, "dist", "plugins-verification");
const proof = { checkedAt: new Date().toISOString(), passed: false };
const marketplacePath = path.resolve(process.env.SAFEINSTALL_TEST_MARKETPLACE_PATH || path.join(root, "dist", "plugins"));
let server;
try {
  await mkdir(env.CODEX_HOME);
  proof.client = (await exec("codex", ["--version"], { env })).stdout.trim();
  proof.marketplace = JSON.parse((await exec("codex", ["plugin", "marketplace", "add", marketplacePath, "--json"], { env, cwd: scratch })).stdout);
  const installed = JSON.parse((await exec("codex", ["plugin", "add", "safeinstall@safeinstall-local", "--json"], { env, cwd: scratch })).stdout);
  proof.installedVersion = installed.version;
  const config = JSON.parse((await exec("codex", ["mcp", "list", "--json"], { env, cwd: scratch })).stdout).find(item => item.name === "safeinstall");
  assert(config?.enabled);
  assert(config.transport.args[0].startsWith(installed.installedPath));
  const pending = new Map();
  let id = 0;
  let buffer = "";
  server = spawn("codex", ["app-server", "--stdio"], { env, cwd: scratch, stdio: "pipe" });
  server.stderr.on("data", () => {}); // No auth/config diagnostics in the public proof.
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  });
  function rejectPending(error) {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }
  server.on("error", rejectPending);
  server.on("exit", code => rejectPending(new Error(`Codex app-server exited ${code}.`)));
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = id++;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out.`)); }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      server.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    });
  }
  await call("initialize", { clientInfo: { name: "safeinstall-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  server.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const status = await call("mcpServerStatus/list", { serverName: "safeinstall" });
  const found = status.data.find(item => item.name === "safeinstall");
  assert(found, "Codex must discover the plugin MCP server.");
  assert(!found.toolsError, found.toolsError);
  proof.tools = Object.keys(found.tools);
  assert(proof.tools.some(name => name.includes("check_package")), "check_package must be discovered by Codex.");
  assert(proof.tools.some(name => name.includes("protection_status")), "protection_status must be discovered by Codex.");
  const skillResult = await call("skills/list", { cwds: [scratch], forceReload: true });
  const skillText = JSON.stringify(skillResult);
  proof.skills = ["safeinstall-setup", "safeinstall-check", "safeinstall-install", "safeinstall-status"].filter(name => skillText.includes(name));
  assert.equal(proof.skills.length, 4);
  proof.hookTrustGranted = false;
  const archive = path.resolve(process.env.SAFEINSTALL_TEST_ARCHIVE_PATH || path.join(root, "dist", `safeinstall-plugin-${installed.version}.tgz`));
  proof.archiveSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  proof.passed = true;
} catch (error) {
  proof.error = error.message;
  process.exitCode = 1;
} finally {
  if (server) {
    server.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill("SIGTERM"); resolve(); }, 1500);
      server.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  await mkdir(proofDir, { recursive: true });
  await writeFile(path.join(proofDir, "codex-client.json"), JSON.stringify(proof, null, 2) + "\n");
  await rm(scratch, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(proof, null, 2) + "\n");
}
