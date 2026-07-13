import { createDefaultConfig, loadConfig } from "./config";
import { evaluateRequestedPackages } from "./evaluations";
import { RegistryClient } from "./registry";
import { parseManifestDependency } from "./specs";
import type { PackageEvaluation, SafeInstallConfig } from "./types";

/**
 * The check_package tool result, returned to the calling agent as JSON text.
 * `verdict` is "block" when the engine produced any blocked reason, otherwise
 * "allow". `sourceRepository` and `ageHours` are surfaced from the same
 * evaluation the CLI runs, so an agent gets the full supply-chain context.
 */
export interface CheckPackageVerdict {
  verdict: "allow" | "block";
  name: string;
  version: string | null;
  reasons: Array<{ code: string; message: string; suggestion?: string }>;
  warnings: string[];
  infos: string[];
  sourceRepository: string | null;
  ageHours: number | null;
}

export interface CheckPackageInput {
  /** Package name, e.g. "axios" or "@scope/pkg". */
  name: string;
  /** Version or range; defaults to "latest". */
  version?: string;
  /** Package manager hint; informational only. */
  manager?: string;
}

const MILLISECONDS_PER_HOUR = 1000 * 60 * 60;

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Pure mapping from the engine's PackageEvaluation to the machine-readable
 * verdict the MCP tool returns. Kept free of I/O and clocks (the `now` used
 * for the age calculation is injected) so it can be unit-tested without a
 * network or a live MCP client.
 */
export function evaluationToVerdict(
  evaluation: PackageEvaluation,
  now: Date
): CheckPackageVerdict {
  const resolved = evaluation.resolvedRegistryPackage;
  const ageHours = resolved
    ? roundHours((now.getTime() - resolved.publishedAt.getTime()) / MILLISECONDS_PER_HOUR)
    : null;

  return {
    verdict: evaluation.blockedReasons.length > 0 ? "block" : "allow",
    name: evaluation.requested.name,
    version: resolved?.resolvedVersion ?? null,
    reasons: evaluation.blockedReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      ...(reason.suggestion ? { suggestion: reason.suggestion } : {})
    })),
    warnings: [...evaluation.warnings],
    infos: [...evaluation.infos],
    sourceRepository: evaluation.sourceRepository ?? null,
    ageHours
  };
}

export interface ResolvedMcpConfig {
  config: SafeInstallConfig;
  configPath?: string;
  usedSecurePreset: boolean;
}

/**
 * Resolve the policy for an MCP check. When a project config file is found it
 * is respected exactly. When none is found, fall back to a recommended secure
 * preset: the built-in defaults with typo-squat and provenance-continuity
 * promoted to "block", because the agent use case wants maximum signal rather
 * than the conservative off-by-default the CLI ships for human-driven runs.
 */
export async function resolveMcpConfig(cwd: string): Promise<ResolvedMcpConfig> {
  const loaded = await loadConfig(cwd);
  if (loaded.path) {
    return { config: loaded.config, configPath: loaded.path, usedSecurePreset: false };
  }

  const config = createDefaultConfig();
  config.typoSquat.mode = "block";
  config.continuity.mode = "block";
  return { config, usedSecurePreset: true };
}

export interface CheckPackageDependencies {
  registryClient?: RegistryClient;
  now?: Date;
}

/**
 * Run a single package through the real SafeInstall engine (release age,
 * install scripts, untrusted sources, typo-squat, provenance, and provenance
 * continuity) and return its verdict. Reuses evaluateRequestedPackages so the
 * MCP server and the CLI share one decision path.
 */
export async function checkPackage(
  cwd: string,
  input: CheckPackageInput,
  deps: CheckPackageDependencies = {}
): Promise<CheckPackageVerdict> {
  const { config } = await resolveMcpConfig(cwd);
  const requested = parseManifestDependency(input.name, input.version ?? "latest");
  const registryClient =
    deps.registryClient ?? new RegistryClient({ registryUrl: config.registryUrl });

  const [evaluation] = await evaluateRequestedPackages(cwd, [requested], registryClient, config);
  if (evaluation === undefined) {
    // Invariant: evaluateRequestedPackages returns one evaluation per input
    // package, and we passed exactly one. A miss would be an engine bug.
    throw new Error("evaluateRequestedPackages returned no evaluation for the requested package.");
  }
  return evaluationToVerdict(evaluation, deps.now ?? new Date());
}

// --- MCP stdio server -------------------------------------------------------

export const CHECK_PACKAGE_TOOL = {
  name: "check_package",
  description:
    "Check whether installing an npm package would be blocked by SafeInstall's " +
    "supply-chain policy (release age, install scripts, untrusted sources, " +
    "typo-squatting, Sigstore provenance, and provenance continuity). Call this " +
    "BEFORE suggesting or running any package install.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'The package name, e.g. "axios" or "@scope/pkg".'
      },
      version: {
        type: "string",
        description: "A version or range; defaults to latest."
      },
      manager: {
        type: "string",
        enum: ["npm", "pnpm", "bun"],
        description: "The package manager (informational only)."
      }
    },
    required: ["name"],
    additionalProperties: false
  }
} as const;

const MCP_SDK_MISSING_MESSAGE =
  "The MCP server requires the optional '@modelcontextprotocol/sdk' package. " +
  "Install it with: npm install @modelcontextprotocol/sdk\n";

// The MCP SDK is dual-published (ESM + CommonJS). These specifiers resolve via
// the package's `exports` "require" condition to the CommonJS build, so the
// dynamic import works on every supported Node version without depending on
// `require(esm)`. They are `const` strings (not inline literals) so TypeScript
// emits a runtime `require()` and does not attempt to resolve the optional
// dependency at build time — mirroring the lazy sigstore import in provenance.ts.
const MCP_SERVER_MODULE = "@modelcontextprotocol/sdk/server";
const MCP_STDIO_MODULE = "@modelcontextprotocol/sdk/server/stdio.js";
const MCP_TYPES_MODULE = "@modelcontextprotocol/sdk/types.js";

interface McpRequest {
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface JsonRpcServer {
  setRequestHandler(schema: unknown, handler: (request: McpRequest) => Promise<unknown>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface LoadedMcpSdk {
  Server: new (
    info: { name: string; version: string },
    options: { capabilities: { tools: Record<string, never> } }
  ) => JsonRpcServer;
  StdioServerTransport: new () => unknown;
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
}

async function loadMcpSdk(): Promise<LoadedMcpSdk> {
  const serverModule = (await import(MCP_SERVER_MODULE)) as {
    Server: LoadedMcpSdk["Server"];
  };
  const stdioModule = (await import(MCP_STDIO_MODULE)) as {
    StdioServerTransport: LoadedMcpSdk["StdioServerTransport"];
  };
  const typesModule = (await import(MCP_TYPES_MODULE)) as {
    ListToolsRequestSchema: unknown;
    CallToolRequestSchema: unknown;
  };

  return {
    Server: serverModule.Server,
    StdioServerTransport: stdioModule.StdioServerTransport,
    ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
    CallToolRequestSchema: typesModule.CallToolRequestSchema
  };
}

function toolError(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handleCheckPackage(request: McpRequest): Promise<McpToolResult> {
  const params = request.params ?? {};
  if (params.name !== CHECK_PACKAGE_TOOL.name) {
    return toolError(`Unknown tool: ${String(params.name)}`);
  }

  const args = params.arguments ?? {};
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return toolError("The 'name' argument is required and must be a non-empty string.");
  }

  const version =
    typeof args.version === "string" && args.version.trim() ? args.version.trim() : undefined;
  const manager = typeof args.manager === "string" ? args.manager : undefined;

  try {
    const verdict = await checkPackage(process.cwd(), { name, version, manager });
    return { content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }] };
  } catch (error) {
    return toolError(
      `SafeInstall could not evaluate ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Start the SafeInstall MCP server over stdio. Lazily loads the optional MCP
 * SDK; if it is not installed, prints an actionable message to stderr and exits
 * non-zero (never writes to stdout, which carries the JSON-RPC protocol). The
 * returned promise resolves once the transport is connected; the process then
 * stays alive on stdin until the client closes the connection.
 */
export async function runMcpServer(version: string): Promise<void> {
  let sdk: LoadedMcpSdk;
  try {
    sdk = await loadMcpSdk();
  } catch {
    process.stderr.write(MCP_SDK_MISSING_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const server = new sdk.Server(
    { name: "safeinstall", version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: [CHECK_PACKAGE_TOOL]
  }));

  server.setRequestHandler(sdk.CallToolRequestSchema, handleCheckPackage);

  try {
    const transport = new sdk.StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.stderr.write(
      `SafeInstall MCP server failed to start: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
