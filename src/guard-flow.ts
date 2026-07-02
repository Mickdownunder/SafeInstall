import path from "node:path";

import { analyzeShellCommand } from "./guard-commands";
import type { GuardRunnerMatch } from "./guard-commands";
import { findNearestUpward } from "./project-discovery";

/**
 * `safeinstall guard <claude|cursor>` — a pre-shell-execution hook for AI
 * coding agents. It reads the hook event from stdin, detects package-install
 * commands, and answers in the client's hook protocol.
 *
 * The guard never evaluates policy itself. It denies raw install commands
 * and hands the agent the exact same command routed through the SafeInstall
 * CLI, which performs the full policy evaluation (release age, install
 * scripts, provenance, transitive checks) AND runs the package manager with
 * lifecycle scripts disabled. Merely allowing a vetted raw `npm install`
 * would lose that script-blocking half of the policy.
 *
 * Failure posture:
 * - Events that are not shell executions, or that cannot be parsed, produce
 *   "no opinion" (the client's normal permission flow applies). The agent
 *   harness authors the event JSON, so a malformed event is a compatibility
 *   issue, not an attack vector.
 * - Shell commands that involve a package manager but cannot be analyzed
 *   with confidence are denied (fail-closed on the security-relevant path).
 */

export type GuardClient = "claude" | "cursor";

export interface GuardDecision {
  action: "allow" | "deny" | "ask";
  /** Short, human-facing explanation (shown in the client UI). */
  userMessage?: string;
  /** Detailed instruction fed back to the model. */
  agentMessage?: string;
}

export type GuardEventResult =
  | { kind: "shell-command"; command: string; cwd?: string }
  | { kind: "not-applicable"; reason: string };

/** Extract the shell command from a hook event payload, if there is one. */
export function parseGuardEvent(rawEvent: unknown, client: GuardClient): GuardEventResult {
  if (typeof rawEvent !== "object" || rawEvent === null) {
    return { kind: "not-applicable", reason: "Event payload is not a JSON object." };
  }

  const event = rawEvent as Record<string, unknown>;

  if (client === "claude") {
    if (event.hook_event_name !== undefined && event.hook_event_name !== "PreToolUse") {
      return { kind: "not-applicable", reason: `Ignoring hook event ${String(event.hook_event_name)}.` };
    }
    if (event.tool_name !== undefined && event.tool_name !== "Bash") {
      return { kind: "not-applicable", reason: `Ignoring tool ${String(event.tool_name)}.` };
    }
    const toolInput = event.tool_input;
    const command =
      typeof toolInput === "object" && toolInput !== null
        ? (toolInput as Record<string, unknown>).command
        : undefined;
    if (typeof command !== "string") {
      return { kind: "not-applicable", reason: "Event has no tool_input.command string." };
    }
    return {
      kind: "shell-command",
      command,
      cwd: typeof event.cwd === "string" ? event.cwd : undefined
    };
  }

  if (event.hook_event_name !== undefined && event.hook_event_name !== "beforeShellExecution") {
    return { kind: "not-applicable", reason: `Ignoring hook event ${String(event.hook_event_name)}.` };
  }
  if (typeof event.command !== "string") {
    return { kind: "not-applicable", reason: "Event has no command string." };
  }
  return {
    kind: "shell-command",
    command: event.command,
    cwd: typeof event.cwd === "string" ? event.cwd : undefined
  };
}

/** A plain binary name: no scope, no version suffix, no path characters. */
const PLAIN_BINARY_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * True when the runner would resolve a locally installed binary and
 * therefore not download anything: the binary exists in the nearest
 * `node_modules/.bin` (npx, npm exec, and bunx all prefer local binaries).
 */
async function resolvesLocally(runner: GuardRunnerMatch, cwd: string): Promise<boolean> {
  if (runner.fetchesRemote) {
    return false;
  }
  // Scoped or version-suffixed hints (@scope/pkg, pkg@1.2.3) fail the plain
  // check and are treated as registry resolutions.
  if (!runner.packageHint || !PLAIN_BINARY_NAME.test(runner.packageHint)) {
    return false;
  }
  const binPath = await findNearestUpward(cwd, path.join("node_modules", ".bin", runner.packageHint));
  return binPath !== undefined;
}

export async function decideGuard(command: string, cwd: string = process.cwd()): Promise<GuardDecision> {
  const analysis = analyzeShellCommand(command);

  if (analysis.unanalyzable.length > 0) {
    const reasons = analysis.unanalyzable
      .map((segment) => `- ${JSON.stringify(segment.segmentText)}: ${segment.reason}`)
      .join("\n");
    return {
      action: "deny",
      userMessage: "SafeInstall blocked a package install it could not safely analyze.",
      agentMessage:
        "SafeInstall guard blocked this command because it could not verify what would be installed:\n" +
        `${reasons}\n` +
        "Rewrite the install as a plain, literal package-manager command (npm, pnpm, or bun) and it will be checked and routed automatically."
    };
  }

  if (analysis.installs.length > 0) {
    const rewritten = analysis.rewrittenCommand ?? command;
    return {
      action: "deny",
      userMessage: "SafeInstall requires package installs to run through the SafeInstall CLI.",
      agentMessage:
        "SafeInstall guard: package installs must run through the SafeInstall CLI so supply-chain policy " +
        "(release age, install scripts, untrusted sources, provenance) is enforced and lifecycle scripts stay disabled. " +
        "Run this command instead:\n\n" +
        `${rewritten}\n\n` +
        "If SafeInstall blocks it, report the block reasons to the user instead of working around them."
    };
  }

  const remoteRunners: GuardRunnerMatch[] = [];
  for (const runner of analysis.runners) {
    if (!(await resolvesLocally(runner, cwd))) {
      remoteRunners.push(runner);
    }
  }

  if (remoteRunners.length > 0) {
    const targets = remoteRunners
      .map((runner) => `${runner.tool} would fetch and execute ${runner.packageHint ? JSON.stringify(runner.packageHint) : "a package"} from the registry`)
      .join("; ");
    return {
      action: "ask",
      userMessage: `SafeInstall: ${targets} without install-time policy checks. Approve only if you trust it.`,
      agentMessage:
        "SafeInstall guard: this command downloads and executes registry code without install-time policy checks " +
        `(${targets}). The user must approve it. If it is rejected, consider adding the package as a project dependency ` +
        "through safeinstall instead, so it is policy-checked."
    };
  }

  return { action: "allow" };
}

interface GuardResponse {
  /** JSON written to stdout, or undefined for "no output". */
  stdout?: string;
  exitCode: number;
}

export function renderGuardResponse(decision: GuardDecision, client: GuardClient): GuardResponse {
  if (client === "claude") {
    if (decision.action === "allow") {
      // No output means "no opinion": the normal permission flow applies.
      // Emitting permissionDecision "allow" would skip the user's permission
      // prompt entirely, which is a weaker posture than doing nothing.
      return { exitCode: 0 };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.action,
          permissionDecisionReason:
            decision.action === "ask"
              ? decision.userMessage ?? "SafeInstall guard requests confirmation."
              : decision.agentMessage ?? decision.userMessage ?? "Blocked by SafeInstall guard."
        }
      })
    };
  }

  if (decision.action === "allow") {
    return { exitCode: 0, stdout: JSON.stringify({ permission: "allow" }) };
  }

  return {
    exitCode: 0,
    stdout: JSON.stringify({
      permission: decision.action,
      user_message: decision.userMessage ?? "Blocked by SafeInstall guard.",
      agent_message: decision.agentMessage ?? decision.userMessage ?? "Blocked by SafeInstall guard."
    })
  };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let data = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    data += chunk;
  }
  return data;
}

export function isGuardClient(value: string | undefined): value is GuardClient {
  return value === "claude" || value === "cursor";
}

/**
 * Run the guard hook: read the event from stdin, answer on stdout in the
 * client's protocol. Owns stdio (like the MCP server) — diagnostics go to
 * stderr only, so stdout stays parseable for the hook harness.
 */
export async function runGuardHook(
  client: GuardClient,
  stdin: NodeJS.ReadableStream = process.stdin,
  stdout: NodeJS.WritableStream = process.stdout
): Promise<number> {
  let raw: string;
  try {
    raw = await readStream(stdin);
  } catch (error) {
    process.stderr.write(`safeinstall guard: failed to read hook event: ${String(error)}\n`);
    return 1;
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    process.stderr.write("safeinstall guard: hook event was not valid JSON; no opinion.\n");
    return 0;
  }

  const parsed = parseGuardEvent(event, client);
  if (parsed.kind === "not-applicable") {
    process.stderr.write(`safeinstall guard: ${parsed.reason}\n`);
    if (client === "cursor") {
      stdout.write(`${JSON.stringify({ permission: "allow" })}\n`);
    }
    return 0;
  }

  const decision = await decideGuard(parsed.command, parsed.cwd);
  const response = renderGuardResponse(decision, client);
  if (response.stdout) {
    stdout.write(`${response.stdout}\n`);
  }
  return response.exitCode;
}
