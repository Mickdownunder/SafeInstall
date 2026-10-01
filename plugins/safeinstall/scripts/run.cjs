"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "runtime");
const engine = (module) => require(path.join(runtime, "dist", module));

function projectPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("projectPath must be an absolute local project directory.");
  }
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("projectPath is not a directory.");
  return resolved;
}

function deny(message) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: message
  } }) + "\n");
}

async function guard() {
  // Bound both bytes and time. A malformed shell event is never a no-op.
  const raw = await new Promise((resolve, reject) => {
    let input = "";
    const timer = setTimeout(() => reject(new Error("Hook input timed out.")), 5000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > 262144) reject(new Error("Hook input exceeds 256 KiB."));
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => { clearTimeout(timer); resolve(input); });
  });
  const event = JSON.parse(raw);
  if (!event || event.hook_event_name !== "PreToolUse" ||
      typeof event.tool_input?.command !== "string") {
    throw new Error("Unrecognized shell hook event; command was not evaluated.");
  }
  const cwd = projectPath(event.cwd);
  const decision = await engine("guard-flow.js").decideGuard(event.tool_input.command, cwd);
  if (decision.action !== "allow") {
    // Deliberately do not emit allow/updatedInput: no implicit permission grant
    // and no dependency on an arbitrary `safeinstall` executable on PATH.
    deny((decision.userMessage || "SafeInstall blocked this command.") +
      " Use the safeinstall-install skill and the bundled scripts/run.cjs cli entry. " +
      "Never bypass a policy block or run trust approve from a tool.");
  }
}

async function mcp() {
  const req = createRequire(path.join(runtime, "package.json"));
  const { Server } = req("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = req("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = req("@modelcontextprotocol/sdk/types.js");
  const version = engine("cli-version.js").PACKAGE_VERSION;
  const properties = { projectPath: { type: "string", description: "Absolute local project directory; selects its actual policy." } };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const tools = [
    { ...engine("mcp.js").CHECK_PACKAGE_TOOL, annotations,
      inputSchema: { ...engine("mcp.js").CHECK_PACKAGE_TOOL.inputSchema,
        properties: { ...engine("mcp.js").CHECK_PACKAGE_TOOL.inputSchema.properties, ...properties },
        required: ["name", "projectPath"] } },
    { name: "protection_status", description: "Read project policy and trust-surface status. Cannot observe whether the host has trusted the plugin hook.",
      annotations: { ...annotations, openWorldHint: false },
      inputSchema: { type: "object", properties, required: ["projectPath"], additionalProperties: false } }
  ];
  const server = new Server({ name: "safeinstall", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = tools.find((item) => item.name === request.params.name);
      if (!tool) throw new Error("Unknown SafeInstall tool.");
      const args = request.params.arguments || {};
      if (Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties, key))) {
        throw new Error("Unexpected tool argument.");
      }
      const cwd = projectPath(args.projectPath);
      let result;
      if (tool.name === "check_package") {
        if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must be a non-empty string.");
        if (args.version !== undefined && typeof args.version !== "string") throw new Error("version must be a string.");
        if (args.manager !== undefined && !["npm", "pnpm", "bun"].includes(args.manager)) throw new Error("Invalid manager.");
        result = await engine("mcp.js").checkPackage(cwd, args);
      } else {
        const policy = await engine("mcp.js").resolveMcpConfig(cwd);
        result = { engineVersion: version, projectPath: cwd,
          policyPath: policy.configPath || null, securePreset: policy.usedSecurePreset,
          hookActivation: "unknown: review the host's hook trust UI",
          trust: await engine("trust-flow.js").runTrustStatusFlow(cwd, ["trust", "status"]) };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

function cli(args) {
  // This plugin never approves trust drift, unlocks protection, or registers
  // a second project hook dependent on a global CLI. Human CLI remains intact.
  const parsed = engine("cli-options.js").parseCliOptions(args).args;
  if (parsed[0] === "trust" && parsed[1] !== "status") throw new Error("Plugin CLI supports trust status only. Trust changes require your own terminal.");
  if (parsed[0] === "guard") throw new Error("Plugin hooks are managed by the host, not guard install.");
  if (parsed[0] === "init" && (!parsed.includes("--no-guard") || parsed.includes("--force") || parsed.includes("--no-lock"))) {
    throw new Error("Plugin setup requires init --no-guard without --force or --no-lock.");
  }
  process.argv = [process.execPath, path.join(runtime, "dist", "cli.js"), ...args];
  engine("cli.js");
}

const mode = process.argv[2];
Promise.resolve().then(() => {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("SafeInstall requires Node.js 20 or newer.");
  if (mode === "guard") return guard();
  if (mode === "mcp") return mcp();
  if (mode === "cli") return cli(process.argv.slice(3));
  throw new Error("Usage: node scripts/run.cjs <mcp|guard|cli> [CLI arguments]");
}).catch((error) => {
  if (mode === "guard") {
    const message = "SafeInstall hook failed closed: " + error.message;
    deny(message);
    process.stderr.write(message + "\n");
    process.exit(2);
  }
  process.stderr.write("SafeInstall plugin: " + error.message + "\n");
  process.exitCode = 1;
});
