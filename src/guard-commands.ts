import { FLAGS_WITH_VALUES, normalizeInstallCommand } from "./specs";
import {
  collectWriteTargets,
  findCommandTokenIndex,
  shellBasename as basename,
  splitShellSegments,
  stripRedirections
} from "./guard-shell";
import type { ShellSegment, ShellToken } from "./guard-shell";
import type {
  GuardCommandAnalysis,
  GuardInstallMatch,
  GuardRunnerMatch,
  GuardUnanalyzableSegment
} from "./guard-types";
import type { PackageManagerName } from "./types";

export { splitShellSegments } from "./guard-shell";
export type {
  GuardCommandAnalysis,
  GuardInstallMatch,
  GuardRunnerMatch,
  GuardUnanalyzableSegment
} from "./guard-types";

/**
 * Pure analysis of a raw shell command string (as an agent would execute it)
 * to find package-install invocations. No I/O, no policy evaluation — the
 * guard's job is to detect installs and route them through the SafeInstall
 * CLI, which owns the actual policy decision.
 *
 * The analysis is deliberately fail-closed on the security-relevant path:
 * a segment that clearly involves a package manager but cannot be parsed
 * with confidence (command substitution, nested shells, variable expansion
 * in arguments) is reported as unanalyzable rather than silently allowed.
 */

const PACKAGE_MANAGERS = new Set<string>(["npm", "pnpm", "bun"]);

/**
 * Subcommands that own their remaining arguments and never install project
 * dependencies, so an install alias appearing later in the segment (e.g.
 * `npm run add`) is that subcommand's argument, not a hidden install.
 */
const NON_INSTALL_SUBCOMMANDS = new Set([
  "audit",
  "bugs",
  "build",
  "cache",
  "completion",
  "config",
  "create",
  "dedupe",
  "dlx",
  "docs",
  "doctor",
  "exec",
  "fund",
  "get",
  "help",
  "info",
  "init",
  "licenses",
  "link",
  "list",
  "ll",
  "login",
  "logout",
  "ls",
  "outdated",
  "pack",
  "patch",
  "ping",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "repo",
  "restart",
  "rm",
  "run",
  "run-script",
  "set",
  "show",
  "start",
  "stop",
  "test",
  "uninstall",
  "unlink",
  "update",
  "upgrade",
  "version",
  "view",
  "whoami",
  "why",
  "x"
]);
const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INSTALL_HINT_PATTERN = /\b(npm|pnpm|bun|yarn)\b/i;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Standalone package-runner binaries. */
interface RunnerConfig {
  tool: string;
  alwaysRemote: boolean;
  /** `create`/`init` without a template only prints help or initializes locally. */
  requiresTarget?: boolean;
}

const RUNNER_EXECUTABLES: Record<string, RunnerConfig> = {
  npx: { tool: "npx", alwaysRemote: false },
  pnpx: { tool: "pnpx", alwaysRemote: true },
  bunx: { tool: "bunx", alwaysRemote: false }
};

/** Runner subcommands per package manager. pnpm exec is local-only, so it is not listed. */
const RUNNER_SUBCOMMANDS: Record<string, Record<string, RunnerConfig>> = {
  npm: {
    exec: { tool: "npm exec", alwaysRemote: false },
    x: { tool: "npm exec", alwaysRemote: false },
    create: { tool: "npm create", alwaysRemote: true, requiresTarget: true },
    init: { tool: "npm init", alwaysRemote: true, requiresTarget: true }
  },
  pnpm: {
    dlx: { tool: "pnpm dlx", alwaysRemote: true },
    create: { tool: "pnpm create", alwaysRemote: true, requiresTarget: true }
  },
  bun: {
    x: { tool: "bunx", alwaysRemote: false },
    create: { tool: "bun create", alwaysRemote: true, requiresTarget: true }
  },
  yarn: {
    dlx: { tool: "yarn dlx", alwaysRemote: true },
    create: { tool: "yarn create", alwaysRemote: true, requiresTarget: true }
  }
};

/** Runner flags that consume a value token. */
const RUNNER_FLAGS_WITH_VALUES = new Set(["-p", "--package", "-c", "--call", "--shell", "--cwd"]);

function findSubcommand(tokens: ShellToken[]): ShellToken | undefined {
  // Mirrors splitManagerArgsAndCommand in specs.ts: the subcommand is the
  // first token after the manager that is not a flag, where flags that
  // consume a value (like `-C packages/app`) also skip their value token.
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;

    if (!value.startsWith("-")) {
      return tokens[index];
    }

    if (!value.includes("=") && FLAGS_WITH_VALUES.has(value)) {
      index += 1;
    }
  }
  return undefined;
}

interface SegmentFinding {
  install?: GuardInstallMatch & {
    managerToken: ShellToken;
    subcommandToken: ShellToken;
    /** Present when the manager was invoked through corepack; the rewrite drops it. */
    corepackToken?: ShellToken | undefined;
  };
  runner?: GuardRunnerMatch;
  unanalyzable?: GuardUnanalyzableSegment;
  usesSafeInstall?: boolean;
  writeTargets?: string[];
}

/**
 * Extract the package/binary target of a runner invocation. `-p/--package`
 * explicitly requests a registry package, and a version suffix (pkg@1.2.3)
 * or scope means the runner will resolve against the registry.
 */
function analyzeRunnerTarget(tokens: ShellToken[]): { packageHint?: string; explicitRemote: boolean } {
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;

    if (value === "--") {
      return { packageHint: tokens[index + 1]?.value, explicitRemote: false };
    }

    if (value.startsWith("-")) {
      if (value === "-p" || value === "--package") {
        return { packageHint: tokens[index + 1]?.value, explicitRemote: true };
      }
      if (value.startsWith("--package=")) {
        return { packageHint: value.slice("--package=".length), explicitRemote: true };
      }
      if (!value.includes("=") && RUNNER_FLAGS_WITH_VALUES.has(value)) {
        index += 1;
      }
      continue;
    }

    return { packageHint: value, explicitRemote: false };
  }

  return { explicitRemote: false };
}

function createRunnerFinding(
  config: RunnerConfig,
  argumentTokens: ShellToken[],
  segmentText: string
): SegmentFinding {
  const target = analyzeRunnerTarget(argumentTokens);
  if (config.requiresTarget && !target.packageHint) {
    return {};
  }
  return {
    runner: {
      tool: config.tool,
      packageHint: target.packageHint,
      fetchesRemote: config.alwaysRemote || target.explicitRemote,
      segmentText
    }
  };
}

function analyzeSegment(segment: ShellSegment, command: string): SegmentFinding {
  const finding = analyzeSegmentCore(segment, command);
  const { index } = findCommandTokenIndex(segment.tokens);
  const writeTargets = collectWriteTargets(segment.tokens, index);
  return writeTargets.length > 0 ? { ...finding, writeTargets } : finding;
}

function analyzeSegmentCore(segment: ShellSegment, command: string): SegmentFinding {
  const segmentText = command.slice(segment.start, segment.end).trim();
  const { index: commandIndex, corepackToken, wrapperError } = findCommandTokenIndex(segment.tokens);

  if (wrapperError && INSTALL_HINT_PATTERN.test(segmentText)) {
    return {
      unanalyzable: {
        segmentText,
        reason: `${wrapperError} SafeInstall fails closed because the segment also mentions a package manager.`
      }
    };
  }

  if (commandIndex === -1) {
    if (segment.hasSubstitution && INSTALL_HINT_PATTERN.test(segmentText)) {
      return {
        unanalyzable: {
          segmentText,
          reason: "The segment mixes shell substitution with a package-manager word, so SafeInstall cannot see whether an install is hidden inside the substitution and fails closed. If this is NOT an install (the word is an argument such as a workflow name, or a read-only query like `npm view`), run that part as a separate command without `$(...)` so the guard can tell it apart; if it IS an install, spell out the packages literally."
        }
      };
    }
    return {};
  }

  const commandToken = segment.tokens[commandIndex];
  const executable = basename(commandToken.value);
  const rest = stripRedirections(segment.tokens.slice(commandIndex + 1));

  if (executable === "safeinstall") {
    return { usesSafeInstall: true };
  }

  if (NESTED_SHELLS.has(executable)) {
    const nestedScript = rest.map((token) => token.value).join(" ");
    if (INSTALL_HINT_PATTERN.test(nestedScript)) {
      return {
        unanalyzable: {
          segmentText,
          reason: "The command runs a package manager inside a nested shell, which SafeInstall cannot analyze. Run the install as a plain top-level command instead."
        }
      };
    }
    return {};
  }

  const runnerExecutable = RUNNER_EXECUTABLES[executable];
  if (runnerExecutable) {
    return createRunnerFinding(runnerExecutable, rest, segmentText);
  }

  if (executable === "yarn") {
    const subcommand = findSubcommand(rest);
    const normalized = subcommand?.value.toLowerCase();
    if (normalized && RUNNER_SUBCOMMANDS.yarn[normalized]) {
      return createRunnerFinding(
        RUNNER_SUBCOMMANDS.yarn[normalized],
        rest.slice(rest.indexOf(subcommand as ShellToken) + 1),
        segmentText
      );
    }
    const isInstall =
      normalized === undefined || normalized === "install" || normalized === "add" || normalized === "global";
    if (isInstall) {
      return {
        unanalyzable: {
          segmentText,
          reason: "SafeInstall does not support yarn, so this install cannot be policy-checked. Use npm, pnpm, or bun through SafeInstall instead."
        }
      };
    }
    return {};
  }

  if (!PACKAGE_MANAGERS.has(executable)) {
    if (segment.hasSubstitution && INSTALL_HINT_PATTERN.test(segmentText)) {
      return {
        unanalyzable: {
          segmentText,
          reason: "The segment mixes shell substitution with a package-manager word, so SafeInstall cannot see whether an install is hidden inside the substitution and fails closed. If this is NOT an install (the word is an argument such as a workflow name, or a read-only query like `npm view`), run that part as a separate command without `$(...)` so the guard can tell it apart; if it IS an install, spell out the packages literally."
        }
      };
    }
    return {};
  }

  const manager = executable as PackageManagerName;
  const subcommandToken = findSubcommand(rest);
  if (!subcommandToken) {
    return {};
  }

  const canonical = normalizeInstallCommand(manager, subcommandToken.value);
  if (!canonical) {
    const runnerSubcommand = RUNNER_SUBCOMMANDS[manager]?.[subcommandToken.value.toLowerCase()];
    if (runnerSubcommand) {
      return createRunnerFinding(
        runnerSubcommand,
        rest.slice(rest.indexOf(subcommandToken) + 1),
        segmentText
      );
    }

    if (NON_INSTALL_SUBCOMMANDS.has(subcommandToken.value.toLowerCase())) {
      // A known non-install subcommand owns the rest of its arguments
      // (npm run add, pnpm exec install-tool, ...).
      return {};
    }

    // Fail-closed net: the subcommand position did not resolve to an
    // install, but an install alias appears elsewhere in the segment. That
    // is the signature of a value-taking flag the guard does not know
    // (e.g. `pnpm --unknown-flag x add evil`), which would otherwise slip
    // through unchecked.
    const strayInstall = rest.find(
      (token) => token !== subcommandToken && normalizeInstallCommand(manager, token.value) !== undefined
    );
    if (strayInstall) {
      return {
        unanalyzable: {
          segmentText,
          reason: `SafeInstall could not confidently parse this ${manager} command, but it contains the install keyword ${JSON.stringify(strayInstall.value)}. Rewrite it in the plain form \`${manager} <install|add|ci> [packages]\`.`
        }
      };
    }

    // Not an install flow (npm outdated, bun x, ...).
    return {};
  }

  if (segment.hasSubstitution) {
    return {
      unanalyzable: {
        segmentText,
        reason: "The install command uses shell substitution, so SafeInstall cannot verify what would be installed. Spell out the packages literally instead."
      }
    };
  }

  const afterSubcommand = rest.slice(rest.indexOf(subcommandToken) + 1);
  const expandedArgument = afterSubcommand.find((token) => token.hasExpansion);
  if (expandedArgument) {
    return {
      unanalyzable: {
        segmentText,
        reason: `The install argument ${JSON.stringify(expandedArgument.value)} uses variable expansion, so SafeInstall cannot verify what would be installed. Spell out the packages literally instead.`
      }
    };
  }

  return {
    install: {
      manager,
      command: canonical,
      segmentText,
      managerToken: commandToken,
      subcommandToken,
      corepackToken
    }
  };
}

export function analyzeShellCommand(command: string): GuardCommandAnalysis {
  const segments = splitShellSegments(command);

  const installs: NonNullable<SegmentFinding["install"]>[] = [];
  const runners: GuardRunnerMatch[] = [];
  const unanalyzable: GuardUnanalyzableSegment[] = [];
  const writeTargets: string[] = [];
  let usesSafeInstall = false;

  for (const segment of segments) {
    const finding = analyzeSegment(segment, command);
    if (finding.install) {
      installs.push(finding.install);
    }
    if (finding.runner) {
      runners.push(finding.runner);
    }
    if (finding.unanalyzable) {
      unanalyzable.push(finding.unanalyzable);
    }
    if (finding.writeTargets) {
      writeTargets.push(...finding.writeTargets);
    }
    if (finding.usesSafeInstall) {
      usesSafeInstall = true;
    }
  }

  let rewrittenCommand: string | undefined;
  if (installs.length > 0 && unanalyzable.length === 0) {
    // Apply replacements back-to-front so earlier offsets stay valid:
    // drop any corepack wrapper, replace the manager token with
    // `safeinstall <manager>` (also stripping version suffixes like pnpm@9),
    // and canonicalize alias subcommands (i -> install).
    const replacements = installs
      .flatMap((install) => {
        const parts = [
          { start: install.subcommandToken.start, end: install.subcommandToken.end, text: install.command },
          {
            start: install.managerToken.start,
            end: install.managerToken.end,
            text: `safeinstall ${install.manager}`
          }
        ];
        if (install.corepackToken) {
          parts.push({ start: install.corepackToken.start, end: install.managerToken.start, text: "" });
        }
        return parts;
      })
      .sort((a, b) => b.start - a.start || b.end - a.end);

    rewrittenCommand = command;
    for (const replacement of replacements) {
      rewrittenCommand =
        rewrittenCommand.slice(0, replacement.start) + replacement.text + rewrittenCommand.slice(replacement.end);
    }
  }

  return {
    installs: installs.map(({ manager, command: canonical, segmentText }) => ({
      manager,
      command: canonical,
      segmentText
    })),
    runners,
    unanalyzable,
    usesSafeInstall,
    writeTargets,
    rewrittenCommand
  };
}
