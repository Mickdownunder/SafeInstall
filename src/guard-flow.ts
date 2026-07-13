import path from "node:path";

import { cliVersionWarning } from "./cli-version";
import { loadConfig } from "./config";
import { analyzeShellCommand } from "./guard-commands";
import type { GuardRunnerMatch } from "./guard-commands";
import { findNearestUpward } from "./project-discovery";
import { isTrustSurfacePath } from "./trust-surface";
import type { TrustSurfaceStatus } from "./trust-surface";
import { checkTrustSurface, partitionTrustFindings } from "./trust-surface-check";

/**
 * `safeinstall guard <claude|codex|cursor>` — a pre-shell-execution hook for AI
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

export type GuardClient = "claude" | "codex" | "cursor";

export interface GuardDecision {
  action: "allow" | "deny" | "ask";
  /** SafeInstall-routed replacement used by clients that support input rewriting. */
  updatedCommand?: string;
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

  if (client === "claude" || client === "codex") {
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

const TRUST_APPROVE_INSTRUCTION =
  "Tell the user to review the drift with `safeinstall trust status` and, if it is intentional, " +
  "approve it with `safeinstall trust approve` in their own terminal. Do not attempt to run the " +
  "approval yourself — it refuses non-interactive contexts.";

/**
 * Trust-surface reconciliation, evaluated before any command analysis.
 * Inactive projects (no trust lock) return undefined and cost only a few
 * file stats. Deviations turn into decisions:
 * - lockdown findings (enforcement drift, hidden Unicode, broken ledger)
 *   deny every command until a human approves,
 * - tool findings (MCP drift) deny installs and runners only,
 * - shell writes targeting protected files are denied outright.
 */
async function decideTrustSurface(
  command: string,
  cwd: string,
  analysis: ReturnType<typeof analyzeShellCommand>
): Promise<GuardDecision | undefined> {
  let status: TrustSurfaceStatus;
  try {
    status = await checkTrustSurface(cwd);
  } catch (error) {
    // The reconciliation itself failing is an enforcement-surface problem:
    // fail closed rather than silently dropping the trust layer.
    return {
      action: "deny",
      userMessage: "SafeInstall could not verify the Agent Trust Surface.",
      agentMessage: `SafeInstall guard: trust-surface verification failed (${error instanceof Error ? error.message : String(error)}). ${TRUST_APPROVE_INSTRUCTION}`
    };
  }

  if (!status.active || !status.root) {
    return undefined;
  }

  const { lockdown, tool } = partitionTrustFindings(status.findings);

  if (lockdown.length > 0) {
    const details = lockdown.map((finding) => `- ${finding.message}`).join("\n");
    return {
      action: "deny",
      userMessage: "SafeInstall locked down agent commands: the Agent Trust Surface has drifted.",
      agentMessage:
        "SafeInstall guard: the files that configure SafeInstall or this agent were changed without approval:\n" +
        `${details}\n${TRUST_APPROVE_INSTRUCTION}`
    };
  }

  const protectedWrite = analysis.writeTargets.find((target) =>
    isTrustSurfacePath(status.root as string, path.resolve(cwd, target))
  );
  if (protectedWrite) {
    return {
      action: "deny",
      userMessage: `SafeInstall blocked a write to the protected file ${protectedWrite}.`,
      agentMessage:
        `SafeInstall guard: ${JSON.stringify(protectedWrite)} is part of the Agent Trust Surface ` +
        "(SafeInstall policy, agent hooks, rules files, MCP configs). Agents must not modify it. " +
        "If the user wants this change, they can make it themselves and approve it with `safeinstall trust approve`."
    };
  }

  if (tool.length > 0 && (analysis.installs.length > 0 || analysis.runners.length > 0 || analysis.unanalyzable.length > 0)) {
    const details = tool.map((finding) => `- ${finding.message}`).join("\n");
    return {
      action: "deny",
      userMessage: "SafeInstall blocked installs: the agent tool surface (MCP config) changed without approval.",
      agentMessage:
        "SafeInstall guard: the MCP/tool configuration changed without approval, so package installs and " +
        `runners are blocked until a human reviews it:\n${details}\n${TRUST_APPROVE_INSTRUCTION}`
    };
  }

  // Warn-mode instruction drift and unpinned-MCP warnings do not change the
  // verdict, but must not be silent: emit them to stderr (the guard's
  // diagnostic channel; stdout stays the hook protocol).
  if (status.instructionWarnings.length > 0) {
    for (const warning of status.instructionWarnings) {
      process.stderr.write(`safeinstall guard: trust-surface warning: ${warning}\n`);
    }
  }

  return undefined;
}

/**
 * Offline lookup of the project's `minimumCliVersion` claim. A broken config
 * must not change guard verdicts: the guard denies raw installs regardless,
 * and the routed CLI fails closed on the same config — so load failures only
 * produce a stderr diagnostic and never a warning or a different decision.
 */
async function versionMismatchWarning(cwd: string): Promise<string | undefined> {
  try {
    const { config } = await loadConfig(cwd);
    return cliVersionWarning(config.minimumCliVersion);
  } catch (error) {
    process.stderr.write(
      `safeinstall guard: could not evaluate minimumCliVersion (${error instanceof Error ? error.message : String(error)}).\n`
    );
    return undefined;
  }
}

export async function decideGuard(command: string, cwd: string = process.cwd()): Promise<GuardDecision> {
  const decision = await decideGuardCommand(command, cwd);
  if (decision.action === "allow") {
    // Ordinary commands stay on the zero-extra-I/O hotpath: the version check
    // reads the config file, so it runs only once the guard has an opinion.
    return decision;
  }

  const warning = await versionMismatchWarning(cwd);
  if (!warning) {
    return decision;
  }

  // The claude/codex rewrite path renders neither message, so the warning also
  // goes to stderr (the guard's diagnostic channel; stdout stays the protocol).
  process.stderr.write(`safeinstall guard: ${warning}\n`);
  return {
    ...decision,
    userMessage: decision.userMessage ? `${decision.userMessage} ${warning}` : warning,
    agentMessage: decision.agentMessage ? `${decision.agentMessage}\n\n${warning}` : warning
  };
}

async function decideGuardCommand(command: string, cwd: string): Promise<GuardDecision> {
  const analysis = analyzeShellCommand(command);

  const trustDecision = await decideTrustSurface(command, cwd, analysis);
  if (trustDecision) {
    return trustDecision;
  }

  if (analysis.unanalyzable.length > 0) {
    const reasons = analysis.unanalyzable
      .map((segment) => `- ${JSON.stringify(segment.segmentText)}: ${segment.reason}`)
      .join("\n");
    return {
      action: "deny",
      userMessage: "SafeInstall blocked a command it could not safely analyze for package installs.",
      agentMessage:
        "SafeInstall guard blocked this command because it could not verify whether it installs anything:\n" +
        `${reasons}\n` +
        "If it installs packages, rewrite it as a plain, literal package-manager command (npm, pnpm, or bun) and it will be checked and routed. If a package-manager word appears only as an argument (a workflow name, a read-only query), run that part as a separate command without shell substitution so the guard can see it is not an install."
    };
  }

  if (analysis.installs.length > 0) {
    const rewritten = analysis.rewrittenCommand ?? command;
    const mixedWithRunner = analysis.runners.length > 0;
    return {
      action: "deny",
      // Both the Codex and Claude clients can apply this rewrite in place.
      // Keep it limited to pure install commands: a mixed `npm install && npx
      // ...` tool call must be denied so the registry runner cannot survive
      // inside updatedInput.
      updatedCommand: analysis.runners.length === 0 ? rewritten : undefined,
      userMessage: mixedWithRunner
        ? "SafeInstall blocked a command that mixes a package install with registry execution."
        : "SafeInstall requires package installs to run through the SafeInstall CLI.",
      agentMessage: mixedWithRunner
        ? "SafeInstall guard blocked this command because it mixes a package install with a package runner. " +
          "Split the operations: route the install through the SafeInstall CLI and handle the registry runner " +
          "separately. Do not retry the combined command or work around the guard."
        : "SafeInstall guard: package installs must run through the SafeInstall CLI so supply-chain policy " +
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
  if (client === "codex") {
    if (decision.action === "allow") {
      // No hook opinion: Codex still applies its normal sandbox and approval policy.
      return { exitCode: 0 };
    }

    if (decision.action === "deny" && decision.updatedCommand) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { command: decision.updatedCommand },
            additionalContext:
              "SafeInstall routed this package-manager command through its policy-enforcing CLI."
          }
        })
      };
    }

    const reason =
      decision.action === "ask"
        ? `${decision.userMessage ?? decision.agentMessage ?? "Registry execution requires approval."} ` +
          "Codex PreToolUse hooks cannot request approval yet, so SafeInstall blocked the command. " +
          "Do not retry or bypass the guard."
        : decision.agentMessage ?? decision.userMessage ?? "Blocked by SafeInstall guard.";
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      })
    };
  }

  if (client === "claude") {
    if (decision.action === "allow") {
      // No output means "no opinion": the normal permission flow applies.
      // Emitting permissionDecision "allow" would skip the user's permission
      // prompt entirely, which is a weaker posture than doing nothing.
      return { exitCode: 0 };
    }

    if (decision.action === "deny" && decision.updatedCommand) {
      // Rewrite the raw install in place through the SafeInstall CLI, the same
      // UX as the Codex client. Emitting `updatedInput` WITHOUT a
      // permissionDecision replaces the command but keeps the normal permission
      // flow active — and Claude Code shows the user the REWRITTEN command in
      // that prompt (verified end-to-end against Claude Code v2.1.206: the hook
      // returned only updatedInput, permission_mode stayed "default", and the
      // permission dialog displayed the safeinstall-routed command). So the
      // user approves the policy-enforcing command, never a raw install, and
      // the guard never silently bypasses the prompt.
      //
      // Only pure installs reach here: decideGuard leaves updatedCommand
      // undefined when a package runner is mixed in, so those still deny.
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: { command: decision.updatedCommand },
            additionalContext:
              "SafeInstall routed this package-manager command through its policy-enforcing CLI."
          }
        })
      };
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
  return value === "claude" || value === "codex" || value === "cursor";
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
