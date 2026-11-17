import { FLAGS_WITH_VALUES, normalizeInstallCommand } from "./specs";
import {
  collectWriteTargets,
  findCommandTokenIndex,
  hasDynamicCommandName,
  packageManagerFromWord,
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
  "version",
  "view",
  "whoami",
  "why",
  "x"
]);
/** `eval` re-parses its arguments as shell text, exactly like a nested shell. */
const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval"]);

/**
 * Subcommands that resolve and fetch new package versions but are not install
 * flows the SafeInstall CLI can route. Allowing them raw would skip release
 * age, provenance, and script blocking, so the guard denies them.
 */
const UPDATE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["update", "up", "upgrade", "udpate"]),
  pnpm: new Set(["update", "up", "upgrade"]),
  bun: new Set(["update"]),
  yarn: new Set(["up", "upgrade", "upgrade-interactive"])
};
/** npm install variants that also run the project's tests. */
const NPM_INSTALL_TEST_SUBCOMMANDS = new Set(["install-test", "it", "install-ci-test", "cit"]);

/**
 * Commands whose arguments run somewhere else (a container, another host).
 * A package manager named there does not install into this project.
 */
const REMOTE_EXECUTORS = new Set(["docker", "podman", "nerdctl", "kubectl", "ssh"]);
/**
 * Common commands that only read or print their arguments. A package-manager
 * word among them (`echo npm install is dangerous`, `grep npm install log`)
 * is text, never an invocation.
 */
const ARGUMENT_ONLY_COMMANDS = new Set([
  "echo", "printf", "grep", "egrep", "fgrep", "rg", "cat", "man", "which", "type", "ls", "git"
]);

function isFetchingSubcommand(manager: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (UPDATE_SUBCOMMANDS[manager]?.has(normalized)) return true;
  if (manager === "yarn") return normalized === "install" || normalized === "add" || normalized === "global";
  if (manager === "npm" && NPM_INSTALL_TEST_SUBCOMMANDS.has(normalized)) return true;
  return normalizeInstallCommand(manager as PackageManagerName, normalized) !== undefined;
}

/**
 * Find a package manager that is run as an argument of another command
 * (`timeout 60 npm install x`, `xargs npm install`, `pnpm exec npm i x`,
 * `node .../npm-cli.js install x`): an unquoted manager word followed by one
 * of its install or update subcommands.
 */
function findWrappedInstall(tokens: ShellToken[]): { manager: string; keyword: string } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.quoted) continue;
    const manager = packageManagerFromWord(token.value);
    if (!manager) continue;
    const keyword = tokens
      .slice(index + 1)
      .find((candidate) => !candidate.quoted && isFetchingSubcommand(manager, candidate.value));
    if (keyword) return { manager, keyword: keyword.value };
  }
  return undefined;
}

function wrappedInstallFinding(
  executable: string,
  wrapped: { manager: string; keyword: string },
  segmentText: string
): SegmentFinding {
  return {
    unanalyzable: {
      segmentText,
      reason: `The command runs \`${wrapped.manager} ${wrapped.keyword}\` through \`${executable}\`, which SafeInstall cannot route. Run the install as a plain top-level command instead.`
    }
  };
}
const INSTALL_HINT_PATTERN = /\b(npm|pnpm|bun|yarn)\b/i;

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
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    const value = token.value;

    if (!value.startsWith("-")) {
      return token;
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
function analyzeRunnerTarget(tokens: ShellToken[]): { packageHint?: string | undefined; explicitRemote: boolean } {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    const value = token.value;

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
  if (commandToken === undefined) {
    return {};
  }
  const executable = basename(commandToken.value);
  const rest = stripRedirections(segment.tokens.slice(commandIndex + 1));

  if (executable === "safeinstall") {
    return { usesSafeInstall: true };
  }

  if (hasDynamicCommandName(commandToken)) {
    // `$tool install x`, `{npm,install,x}`: the command word itself is only
    // known after expansion. Fail closed when the segment still looks like an
    // install; any other dynamic command is none of the guard's business.
    // Only the subcommand position counts, so `$PYTHON -m pip install x` and
    // similar non-npm commands stay untouched.
    const subcommand = findSubcommand(rest);
    const looksLikeInstall =
      subcommand !== undefined &&
      ["npm", "pnpm", "bun", "yarn"].some((manager) => isFetchingSubcommand(manager, subcommand.value));
    if (INSTALL_HINT_PATTERN.test(segmentText) || looksLikeInstall) {
      return {
        unanalyzable: {
          segmentText,
          reason: "The command name is produced by shell expansion and the segment looks like a package install, so SafeInstall cannot see what would run and fails closed. Spell out the package-manager command literally."
        }
      };
    }
    return {};
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
    const yarnRunner = normalized ? RUNNER_SUBCOMMANDS.yarn?.[normalized] : undefined;
    if (yarnRunner) {
      return createRunnerFinding(
        yarnRunner,
        rest.slice(rest.indexOf(subcommand as ShellToken) + 1),
        segmentText
      );
    }
    const isInstall = normalized === undefined || isFetchingSubcommand("yarn", normalized);
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
    if (!REMOTE_EXECUTORS.has(executable) && !ARGUMENT_ONLY_COMMANDS.has(executable)) {
      const wrapped = findWrappedInstall(rest);
      if (wrapped) {
        return wrappedInstallFinding(executable, wrapped, segmentText);
      }
    }
    return {};
  }

  const manager = executable as PackageManagerName;
  const subcommandToken = findSubcommand(rest);
  if (!subcommandToken) {
    return {};
  }

  if (subcommandToken.hasExpansion) {
    return {
      unanalyzable: {
        segmentText,
        reason: `The ${manager} subcommand ${JSON.stringify(subcommandToken.value)} is produced by shell expansion, so SafeInstall cannot tell whether it is an install and fails closed. Spell out the subcommand literally.`
      }
    };
  }

  const canonical = normalizeInstallCommand(manager, subcommandToken.value);
  if (!canonical) {
    const subcommand = subcommandToken.value.toLowerCase();
    if (UPDATE_SUBCOMMANDS[manager]?.has(subcommand)) {
      return {
        unanalyzable: {
          segmentText,
          reason: `\`${manager} ${subcommand}\` resolves and fetches new package versions without SafeInstall's policy checks, and the SafeInstall CLI cannot route it. Set the wanted versions explicitly and install them with \`safeinstall ${manager} ${manager === "npm" ? "install" : "add"} <package>@<version>\`, or ask the user to run the update themselves.`
        }
      };
    }
    if (manager === "npm" && NPM_INSTALL_TEST_SUBCOMMANDS.has(subcommand)) {
      return {
        unanalyzable: {
          segmentText,
          reason: `\`npm ${subcommand}\` is an install followed by the test script, which the SafeInstall CLI cannot route as one command. Run the install as \`npm ${subcommand.startsWith("install-ci") || subcommand === "cit" ? "ci" : "install"}\` and the tests as a separate command.`
        }
      };
    }
    if (subcommand === "exec") {
      // pnpm exec runs a local binary; a package manager named there is a
      // raw install one level down.
      const wrapped = findWrappedInstall(rest.slice(rest.indexOf(subcommandToken) + 1));
      if (wrapped) {
        return wrappedInstallFinding(`${manager} exec`, wrapped, segmentText);
      }
    }
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
