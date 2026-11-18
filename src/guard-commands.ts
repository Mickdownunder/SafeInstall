import { FLAGS_WITH_VALUES, normalizeInstallCommand } from "./specs";
import {
  collectWriteTargetTokens,
  collectWriteTargets,
  findCommandTokenIndex,
  hasDynamicCommandName,
  leadingBraceOpens,
  packageManagerFromWord,
  shellBasename as basename,
  splitShellSegments,
  startsWithBraceClose,
  stripRedirections
} from "./guard-shell";
import type { ScopeEvent, ShellSegment, ShellToken } from "./guard-shell";
import { findHiddenShellInput } from "./guard-shell-input";
import { literalDirectoryWord, parseWordAlternatives } from "./guard-words";
import type {
  GuardCommandAnalysis,
  GuardInstallMatch,
  GuardRunnerMatch,
  GuardUnanalyzableSegment,
  GuardWriteOperation,
  WordPart
} from "./guard-types";
import type { PackageManagerName } from "./types";

export { splitShellSegments } from "./guard-shell";
export type {
  GuardCommandAnalysis,
  GuardInstallMatch,
  GuardRunnerMatch,
  GuardUnanalyzableSegment,
  GuardWriteOperation
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
 * Quoting a single word does not change what the shell runs: `'npm'` is the
 * command npm. Only a quoted token with whitespace in it is certainly text
 * (`"npm install"` as one argument).
 */
function isCommandWord(token: ShellToken): boolean {
  return !token.quoted || !/\s/.test(token.value);
}

/**
 * Find a package manager that is run as an argument of another command
 * (`timeout 60 npm install x`, `xargs npm install`, `pnpm exec npm i x`,
 * `node .../npm-cli.js install x`): a manager word followed by one of its
 * install or update subcommands.
 */
function findWrappedInstall(
  tokens: ShellToken[],
  runsCommand: boolean
): { manager: string; keyword: string } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !isCommandWord(token)) continue;
    const manager = packageManagerFromWord(token.value);
    if (!manager) continue;
    const keyword = tokens
      .slice(index + 1)
      .find((candidate) => isCommandWord(candidate) && isFetchingSubcommand(manager, candidate.value));
    if (keyword) return { manager, keyword: keyword.value };
  }
  return runsCommand ? findComputedInstall(tokens) : undefined;
}

/**
 * Commands whose purpose is to run the command that follows their own options
 * (`timeout 60 CMD`, `nice -n 10 CMD`, `xargs CMD`). Only behind these is a
 * word's command position known well enough to judge a computed name.
 */
const COMMAND_RUNNERS = new Set([
  "timeout", "gtimeout", "nice", "ionice", "chrt", "taskset", "stdbuf", "xargs", "watch", "doas",
  "strace", "ltrace", "setsid", "flock", "script", "unbuffer", "caffeinate", "parallel"
]);
/** Command runners plus the wrappers the shell layer resolves, for a runner nested in a runner. */
const NESTED_COMMAND_RUNNERS = new Set([...COMMAND_RUNNERS, "sudo", "env", "nohup", "time", "exec", "command"]);
/** A count or duration in front of the command (`60`, `10s`, `1.5m`). */
const NUMERIC_ARGUMENT = /^\d+(?:\.\d+)?[a-z]*$/i;
/** `NAME=value` in front of the command. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * `timeout 60 $NPM install x`: the command a runner executes is only known
 * after expansion. As for a computed top-level command, only its subcommand
 * position decides, so `$PYTHON -m pip install x` stays untouched. Arguments
 * of other programs are not commands: `make PREFIX="$PREFIX" install`,
 * `cmake --build "$DIR" --target install` and `mvn $OPTS install` are builds.
 */
function findComputedInstall(tokens: ShellToken[]): { manager: string; keyword: string } | undefined {
  // The command a runner executes: the first word that is not an option, a
  // count or duration, or an environment assignment (`env A=1 CMD`).
  const commandPosition = (from: number): number => {
    for (let position = from; position < tokens.length; position += 1) {
      const value = tokens[position]?.value ?? "";
      if (!value.startsWith("-") && !NUMERIC_ARGUMENT.test(value) && !ASSIGNMENT_WORD.test(value)) return position;
    }
    return -1;
  };
  let index = commandPosition(0);
  while (index >= 0) {
    const token = tokens[index];
    if (token === undefined || !isCommandWord(token)) return undefined;
    if (!hasDynamicCommandName(token)) {
      // `timeout 60 nice $NPM install x`: a runner that runs another runner.
      // Any other literal word owns the remaining arguments.
      if (!NESTED_COMMAND_RUNNERS.has(basename(token.value))) return undefined;
      index = commandPosition(index + 1);
      continue;
    }
    const following = tokens.slice(index + 1);
    const subcommand = findSubcommand(following);
    if (subcommand === undefined || !isCommandWord(subcommand)) return undefined;
    if (["npm", "pnpm", "bun", "yarn"].some((manager) => isFetchingSubcommand(manager, subcommand.value))) {
      return { manager: token.value, keyword: subcommand.value };
    }
    // `timeout $SECS $NPM install x`: a computed argument in front of the command.
    index = index + 1 + following.indexOf(subcommand);
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

/**
 * Find a package runner that is run as an argument of another command
 * (`timeout 60 npx pkg`, `xargs npx pkg`, `nice pnpm dlx pkg`). A standalone
 * runner word with nothing to run after it is an argument, not an invocation
 * (`brew install npx`, `chmod +x ./npx`).
 */
function findWrappedRunner(tokens: ShellToken[]): { config: RunnerConfig; args: ShellToken[] } | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !isCommandWord(token)) continue;
    const following = tokens.slice(index + 1);
    const standalone = RUNNER_EXECUTABLES[basename(token.value)];
    if (standalone) {
      if (analyzeRunnerTarget(following).packageHint !== undefined) return { config: standalone, args: following };
      continue;
    }
    const manager = packageManagerFromWord(token.value);
    if (!manager) continue;
    const subcommand = findSubcommand(following);
    if (subcommand === undefined || !isCommandWord(subcommand)) continue;
    const config = RUNNER_SUBCOMMANDS[manager]?.[subcommand.value.toLowerCase()];
    if (config) return { config, args: following.slice(following.indexOf(subcommand) + 1) };
  }
  return undefined;
}

/**
 * The local-runner fast path is safe only for one direct invocation whose
 * package target is positional. Earlier shell segments, substitutions,
 * wrappers, and pre-target options can change state or package resolution
 * before execution.
 */
function hasStableLocalRunnerResolution(
  segments: ShellSegment[],
  runners: GuardRunnerMatch[]
): boolean {
  if (segments.length !== 1 || runners.length !== 1 || segments[0]?.hasSubstitution) {
    return false;
  }

  const segment = segments[0];
  const runner = runners[0];
  if (segment === undefined || runner === undefined) {
    return false;
  }

  const { index: commandIndex } = findCommandTokenIndex(segment.tokens);
  if (commandIndex !== 0) {
    return false;
  }

  const commandToken = segment.tokens[commandIndex];
  if (commandToken === undefined) {
    return false;
  }
  const executable = basename(commandToken.value);
  const rest = stripRedirections(segment.tokens.slice(commandIndex + 1));

  let targetTokens: ShellToken[];
  if (RUNNER_EXECUTABLES[executable]) {
    targetTokens = rest;
  } else {
    const subcommand = findSubcommand(rest);
    if (subcommand === undefined || rest.indexOf(subcommand) !== 0) {
      return false;
    }
    const config = RUNNER_SUBCOMMANDS[executable]?.[subcommand.value.toLowerCase()];
    if (config?.alwaysRemote !== false) {
      return false;
    }
    targetTokens = rest.slice(1);
  }

  if (targetTokens[0]?.value === "--") {
    targetTokens = targetTokens.slice(1);
  }
  return runner.packageHint !== undefined && targetTokens[0]?.value === runner.packageHint;
}

function analyzeSegment(segment: ShellSegment, command: string): SegmentFinding {
  const finding = analyzeSegmentCore(segment, command);
  const { index } = findCommandTokenIndex(segment.tokens);
  const writeTargets = collectWriteTargets(segment.tokens, index);
  return writeTargets.length > 0 ? { ...finding, writeTargets } : finding;
}

interface ShellState {
  cwdChanges: string[];
  cwdUncertain: boolean;
  succeeded: boolean;
}

interface CwdEffect {
  changes: string[];
  uncertain: boolean;
}

const ENV_VALUE_OPTIONS = new Set([
  "-u", "--unset", "-C", "--chdir", "--block-signal", "--default-signal", "--ignore-signal"
]);
const NON_PERSISTENT_WRAPPERS = new Set(["sudo", "nohup", "env", "exec", "corepack"]);
/**
 * Commands whose effect on the shell's working directory the guard does not
 * follow. `alias`, `case` and `function` can hide a `cd` in text that runs
 * later or in an arm that may or may not run.
 */
const UNMODELED_CWD_COMMANDS = new Set(["pushd", "popd", "eval", "source", ".", "alias", "case", "function"]);
/** Words that change the directory wherever they appear, e.g. inside a function body. */
const CWD_WORDS = new Set(["cd", "pushd", "popd", "chdir"]);
const MAX_CWD_VARIANTS = 32;
const MAX_CWD_CHANGES = 64;

function commandCwdEffect(command: string, tokens: ShellToken[], commandIndex: number): CwdEffect {
  const changes: string[] = [];
  let uncertain = false;
  const addChange = (directory: string): void => {
    if (changes.length >= MAX_CWD_CHANGES) uncertain = true;
    else changes.push(directory);
  };

  for (let wrapperIndex = 0; wrapperIndex < commandIndex; wrapperIndex += 1) {
    const wrapper = tokens[wrapperIndex];
    if (wrapper === undefined) continue;
    const executable = basename(wrapper.value);

    if (executable === "sudo") {
      for (let index = wrapperIndex + 1; index < commandIndex; index += 1) {
        const value = tokens[index]?.value ?? "";
        if (
          value === "-D" ||
          value === "--chdir" ||
          value.startsWith("-D") ||
          value.startsWith("--chdir=") ||
          value === "-R" ||
          value === "--chroot" ||
          value.startsWith("-R") ||
          value.startsWith("--chroot=")
        ) {
          uncertain = true;
        }
      }
      continue;
    }

    if (executable !== "env") continue;
    for (let index = wrapperIndex + 1; index < commandIndex;) {
      const token = tokens[index];
      if (token === undefined) break;
      const value = token.value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        index += 1;
        continue;
      }
      if (value === "--") break;
      if (value === "-C" || value === "--chdir") {
        const directory = tokens[index + 1];
        const resolved = directory === undefined ? undefined : literalDirectoryWord(command, directory.start);
        if (resolved === undefined) uncertain = true;
        else addChange(resolved);
        index += 2;
        continue;
      }
      if (value.startsWith("--chdir=")) {
        const prefix = "--chdir=";
        const resolved = command.startsWith(prefix, token.start)
          ? literalDirectoryWord(command, token.start + prefix.length)
          : undefined;
        if (resolved === undefined) uncertain = true;
        else addChange(resolved);
        index += 1;
        continue;
      }
      if (value.startsWith("-C") && value.length > 2) {
        const resolved = command.startsWith("-C", token.start)
          ? literalDirectoryWord(command, token.start + 2)
          : undefined;
        if (resolved === undefined) uncertain = true;
        else addChange(resolved);
        index += 1;
        continue;
      }
      if (value.startsWith("-")) {
        index += ENV_VALUE_OPTIONS.has(value) ? 2 : 1;
        continue;
      }
      break;
    }
  }

  return { changes, uncertain };
}

function commandCanMutateParentCwd(tokens: ShellToken[], commandIndex: number): boolean {
  return !tokens
    .slice(0, commandIndex)
    .some((token) => NON_PERSISTENT_WRAPPERS.has(basename(token.value)));
}

function persistentCwdEffect(command: string, segment: ShellSegment): CwdEffect | undefined {
  const { index: commandIndex } = findCommandTokenIndex(segment.tokens);
  if (commandIndex < 0) {
    return segment.tokens.some((token) => token.value.startsWith("CDPATH="))
      ? { changes: [], uncertain: true }
      : undefined;
  }

  const commandToken = segment.tokens[commandIndex];
  if (commandToken === undefined || !commandCanMutateParentCwd(segment.tokens, commandIndex)) {
    return undefined;
  }
  if (hasDynamicCommandName(commandToken)) {
    // `$c .claude`, `cd${IFS}.claude`, `$(echo cd) .claude`: the word may be `cd`.
    return { changes: [], uncertain: true };
  }
  const executable = basename(commandToken.value);
  const args = stripRedirections(segment.tokens.slice(commandIndex + 1));

  if (executable === "cd") {
    if (segment.hasCommandSubstitution) {
      return { changes: [], uncertain: true };
    }
    if (segment.tokens.slice(0, commandIndex).some((token) => basename(token.value) === "time")) {
      return { changes: [], uncertain: true };
    }
    if (segment.tokens.slice(0, commandIndex).some((token) => token.value.startsWith("CDPATH="))) {
      return { changes: [], uncertain: true };
    }
    let optionsEnded = false;
    const directories: ShellToken[] = [];
    for (const token of args) {
      if (!optionsEnded && token.value === "--") {
        optionsEnded = true;
      } else if (!optionsEnded && /^-[LPe@]+$/.test(token.value)) {
        continue;
      } else {
        directories.push(token);
      }
    }
    const directory = directories[0];
    const resolved =
      directories.length !== 1 || directory === undefined || directory.value === "-"
        ? undefined
        : literalDirectoryWord(command, directory.start);
    if (resolved === undefined) return { changes: [], uncertain: true };
    return { changes: [resolved], uncertain: false };
  }

  if (
    UNMODELED_CWD_COMMANDS.has(executable) ||
    (executable === "builtin" && args.some((token) => token.value === "cd" || UNMODELED_CWD_COMMANDS.has(token.value))) ||
    (executable === "export" && args.some((token) => token.value.startsWith("CDPATH=")))
  ) {
    return { changes: [], uncertain: true };
  }
  return undefined;
}

function stateKey(state: ShellState): string {
  return JSON.stringify([state.cwdChanges, state.cwdUncertain, state.succeeded]);
}

function uniqueStates(states: ShellState[]): ShellState[] {
  const byKey = new Map<string, ShellState>();
  for (const state of states) {
    byKey.set(stateKey(state), state);
    if (byKey.size > MAX_CWD_VARIANTS) {
      return [
        { cwdChanges: [], cwdUncertain: true, succeeded: true },
        { cwdChanges: [], cwdUncertain: true, succeeded: false }
      ];
    }
  }
  return [...byKey.values()];
}

function completedStates(states: ShellState[], effect: CwdEffect | undefined): ShellState[] {
  return states.flatMap((state) => {
    if (effect === undefined) {
      return [
        { ...state, succeeded: true },
        { ...state, succeeded: false }
      ];
    }
    const cwdChanges = [...state.cwdChanges, ...effect.changes];
    const exceededLimit = cwdChanges.length > MAX_CWD_CHANGES;
    return [
      {
        cwdChanges: exceededLimit ? [] : cwdChanges,
        cwdUncertain: state.cwdUncertain || effect.uncertain || exceededLimit,
        succeeded: true
      },
      { ...state, succeeded: false }
    ];
  });
}

/**
 * The file name of a source word: its parts after the last literal `/`.
 * Undefined when the word names a directory's contents (`dir/`, `dir/.`),
 * which a copy spreads over the destination instead of placing one file.
 */
function fileNameParts(parts: WordPart[]): WordPart[] | undefined {
  let name = parts;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.kind !== "text") continue;
    const slash = part.value.lastIndexOf("/");
    if (slash === -1) continue;
    const tail = part.value.slice(slash + 1);
    name = [...(tail.length > 0 ? [{ kind: "text" as const, value: tail }] : []), ...parts.slice(index + 1)];
    break;
  }
  if (name.length === 0) return undefined;
  if (name.length === 1 && name[0]?.kind === "text" && (name[0].value === "." || name[0].value === "..")) {
    return undefined;
  }
  // A name the shell computes at run time can be any name.
  return name.map((part) => (part.kind === "text" || part.kind === "glob" ? part : { kind: "unknown" as const }));
}

/** `directory` with its trailing slashes removed, so a name can be appended. */
function withoutTrailingSlash(directory: WordPart[]): WordPart[] {
  const last = directory[directory.length - 1];
  if (last?.kind !== "text") return directory;
  const trimmed = last.value.replace(/\/+$/, "");
  if (trimmed.length === last.value.length) return directory;
  if (trimmed.length > 0) return [...directory.slice(0, -1), { kind: "text", value: trimmed }];
  // The word was only slashes after its other parts: `/` itself stays the root.
  return directory.length === 1 ? [{ kind: "text", value: "" }] : directory.slice(0, -1);
}

/** Every `<directory>/<file name of source>` a copy or move into a directory can write. */
function placedInto(directories: WordPart[][], sources: WordPart[][]): WordPart[][] {
  const words: WordPart[][] = [];
  for (const directory of directories) {
    for (const source of sources) {
      const name = fileNameParts(source);
      if (name) words.push([...withoutTrailingSlash(directory), { kind: "text", value: "/" }, ...name]);
    }
  }
  return words;
}

function operationForTarget(
  command: string,
  target: ReturnType<typeof collectWriteTargetTokens>[number],
  states: ShellState[],
  commandEffect: CwdEffect
): GuardWriteOperation | undefined {
  const usesCommandCwd = target.kind === "argument";
  const variants = states
    .filter((state) => !state.cwdUncertain)
    .map((state) => [
      ...state.cwdChanges,
      ...(usesCommandCwd && !commandEffect.uncertain ? commandEffect.changes : [])
    ]);
  const uniqueVariants = [...new Map(variants.map((variant) => [JSON.stringify(variant), variant])).values()];
  const ownWords: WordPart[][] = target.processSubstitution
    ? [[{ kind: "unknown" }]]
    : parseWordAlternatives(command, target.token.start);
  const words = target.source
    ? placedInto(ownWords, parseWordAlternatives(command, target.source.start))
    : ownWords;
  if (words.length === 0) return undefined;
  return {
    target: target.source
      ? `${target.token.value.replace(/\/+$/, "")}/${target.source.value.split("/").pop() ?? ""}`
      : target.token.value,
    hasExpansion: target.token.hasExpansion || (target.source?.hasExpansion ?? false),
    words,
    kind: target.kind,
    recursive: target.recursive,
    cwdVariants: uniqueVariants,
    cwdUncertain:
      states.some((state) => state.cwdUncertain) || (usesCommandCwd && commandEffect.uncertain)
  };
}

interface SegmentScope {
  /** Subshell parentheses that open the segment and close in a later one. */
  leadingOpens: number;
  /** `{` group openers at the start of the segment. */
  braceOpens: number;
  /** Substitutions opened after the first token and closed in a later segment. */
  midOpens: number;
  /** Parentheses that close a scope opened in an earlier segment. */
  closes: number;
  braceClose: boolean;
  /** The whole segment sits inside its own `( ... )`: its cd does not escape. */
  wrapped: boolean;
  /** `name() ...`: the segment defines a function. */
  functionDefinition: boolean;
}

function segmentScope(segment: ShellSegment): SegmentScope {
  const scope: SegmentScope = {
    leadingOpens: 0,
    braceOpens: leadingBraceOpens(segment.tokens),
    midOpens: 0,
    closes: 0,
    braceClose: startsWithBraceClose(segment.tokens),
    wrapped: false,
    functionDefinition: false
  };
  const open: ScopeEvent[] = [];
  for (const event of segment.scopeEvents) {
    if (event.type === "open") {
      open.push(event);
      continue;
    }
    const matching = open.pop();
    if (matching === undefined) {
      scope.closes += 1;
    } else if (matching.tokenCount === 0) {
      scope.wrapped = true;
    } else if (!matching.substitution && matching.tokenCount === event.tokenCount) {
      scope.functionDefinition = true;
    }
  }
  for (const event of open) {
    if (event.tokenCount === 0) scope.leadingOpens += 1;
    else scope.midOpens += 1;
  }
  return scope;
}

interface OpenScope {
  kind: "paren" | "brace";
  /** States to return to when the scope ends. */
  saved: ShellState[];
  /** True when the group opened as part of a pipeline or background job. */
  isolatedAtOpen: boolean;
}

function bothOutcomes(states: ShellState[]): ShellState[] {
  return states.flatMap((state) => [
    { ...state, succeeded: true },
    { ...state, succeeded: false }
  ]);
}

function collectWriteOperations(segments: ShellSegment[], command: string): GuardWriteOperation[] {
  const operations: GuardWriteOperation[] = [];
  let states: ShellState[] = [{ cwdChanges: [], cwdUncertain: false, succeeded: true }];
  const scopes: OpenScope[] = [];
  const scopeInfo = segments.map(segmentScope);
  // A function body may `cd` when it is called; once any function is defined
  // and the command changes directory anywhere, the cwd is no longer known.
  const changesDirectory = segments.some(
    (segment) =>
      persistentCwdEffect(command, segment) !== undefined ||
      segment.tokens.some((token) => CWD_WORDS.has(basename(token.value)))
  );

  for (let groupStart = 0; groupStart < segments.length;) {
    let groupEnd = groupStart;
    while (segments[groupEnd + 1]?.connector === "pipe") groupEnd += 1;

    const connector = segments[groupStart]?.connector;
    const executed =
      connector === "and"
        ? states.filter((state) => state.succeeded)
        : connector === "or"
          ? states.filter((state) => !state.succeeded)
          : states;
    const skipped =
      connector === "and"
        ? states.filter((state) => !state.succeeded)
        : connector === "or"
          ? states.filter((state) => state.succeeded)
          : [];

    const inPipeline = groupEnd > groupStart;
    const nextConnector = segments[groupEnd + 1]?.connector;

    for (let index = groupStart; index <= groupEnd; index += 1) {
      const segment = segments[index];
      const info = scopeInfo[index];
      if (segment === undefined || info === undefined) continue;
      // Scopes that open at the start of a segment cover its own commands.
      for (let opened = 0; opened < info.leadingOpens; opened += 1) {
        scopes.push({ kind: "paren", saved: states, isolatedAtOpen: false });
      }
      for (let opened = 0; opened < info.braceOpens; opened += 1) {
        scopes.push({ kind: "brace", saved: states, isolatedAtOpen: inPipeline || nextConnector === "background" });
      }
      if (executed.length === 0) continue;
      const { index: commandIndex } = findCommandTokenIndex(segment.tokens);
      const commandEffect = commandCwdEffect(command, segment.tokens, commandIndex);
      for (const target of collectWriteTargetTokens(segment.tokens, commandIndex)) {
        const operation = operationForTarget(command, target, executed, commandEffect);
        if (operation) operations.push(operation);
      }
    }

    // A pipeline's commands run in subshells, so their `cd` does not reach the
    // parent shell. The last one still sets the directory for the rest of a
    // `( ... )` or `{ ...; }` group it opens (`echo x | (cd d && tee f)`).
    const lastInfo = scopeInfo[groupEnd] as SegmentScope;
    const opensScope = lastInfo.leadingOpens + lastInfo.braceOpens > 0;
    const persistent =
      nextConnector !== "background" && (!inPipeline || opensScope) && !lastInfo.wrapped;
    let effect = persistent ? persistentCwdEffect(command, segments[groupEnd] as ShellSegment) : undefined;
    if (persistent && lastInfo.functionDefinition && changesDirectory) {
      effect = { changes: effect?.changes ?? [], uncertain: true };
    }
    const completed = persistent ? completedStates(executed, effect) : bothOutcomes(executed);
    states = uniqueStates([...skipped, ...completed]);

    for (let index = groupStart; index <= groupEnd; index += 1) {
      const info = scopeInfo[index] as SegmentScope;
      for (let opened = 0; opened < info.midOpens; opened += 1) {
        scopes.push({ kind: "paren", saved: states, isolatedAtOpen: false });
      }
      for (let closed = 0; closed < info.closes; closed += 1) {
        if (scopes[scopes.length - 1]?.kind === "paren") {
          states = uniqueStates(bothOutcomes((scopes.pop() as OpenScope).saved));
        }
      }
      if (info.braceClose && scopes[scopes.length - 1]?.kind === "brace") {
        const scope = scopes.pop() as OpenScope;
        if (scope.isolatedAtOpen || inPipeline || nextConnector === "background") {
          states = uniqueStates(bothOutcomes(scope.saved));
        } else {
          states = uniqueStates(bothOutcomes(states));
        }
      }
    }
    groupStart = groupEnd + 1;
  }

  return operations;
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
      const wrapped = findWrappedInstall(rest, COMMAND_RUNNERS.has(executable));
      if (wrapped) {
        return wrappedInstallFinding(executable, wrapped, segmentText);
      }
      const wrappedRunner = findWrappedRunner(rest);
      if (wrappedRunner) {
        return createRunnerFinding(wrappedRunner.config, wrappedRunner.args, segmentText);
      }
    }
    return {};
  }

  const manager = executable as PackageManagerName;
  const subcommandToken = findSubcommand(rest);
  if (!subcommandToken) {
    return {};
  }

  // `npm in*` becomes `npm install` when a file named `install` exists.
  if (subcommandToken.hasExpansion || subcommandToken.hasGlob) {
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
      const wrapped = findWrappedInstall(rest.slice(rest.indexOf(subcommandToken) + 1), true);
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
  const writeOperations = collectWriteOperations(segments, command);

  const installs: NonNullable<SegmentFinding["install"]>[] = [];
  const runners: GuardRunnerMatch[] = [];
  const unanalyzable: GuardUnanalyzableSegment[] = [];
  const writeTargets: string[] = [];
  let usesSafeInstall = false;

  for (const [index, segment] of segments.entries()) {
    const finding = analyzeSegment(segment, command);
    if (finding.install) {
      installs.push(finding.install);
    }
    if (finding.runner) {
      runners.push(finding.runner);
    }
    const unseen = finding.unanalyzable ?? findHiddenShellInput(segments, index, command);
    if (unseen) {
      unanalyzable.push(unseen);
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
    localRunnerResolutionSafe: hasStableLocalRunnerResolution(segments, runners),
    unanalyzable,
    usesSafeInstall,
    writeTargets,
    writeOperations,
    rewrittenCommand
  };
}
