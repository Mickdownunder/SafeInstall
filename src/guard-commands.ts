import { FLAGS_WITH_VALUES, normalizeInstallCommand } from "./specs";
import type { PackageManagerName } from "./types";

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

export interface GuardInstallMatch {
  manager: PackageManagerName;
  /** Canonical install subcommand: install, add, or ci. */
  command: string;
  /** The original segment text, e.g. "npm i axios". */
  segmentText: string;
}

export interface GuardUnanalyzableSegment {
  segmentText: string;
  reason: string;
}

/**
 * A package-runner invocation (npx, pnpm dlx, bunx, npm exec): executes a
 * package binary and may download it from the registry first.
 */
export interface GuardRunnerMatch {
  /** Human-readable tool label, e.g. "npx" or "pnpm dlx". */
  tool: string;
  /** The binary/package token the runner would execute, when parseable. */
  packageHint?: string;
  /**
   * True for dlx-style tools that always fetch from the registry, or when
   * an explicit package was requested via -p/--package or a version suffix.
   * False means the runner prefers a locally installed binary.
   */
  fetchesRemote: boolean;
  segmentText: string;
}

export interface GuardCommandAnalysis {
  /** Raw install invocations that must be routed through SafeInstall. */
  installs: GuardInstallMatch[];
  /** Package-runner invocations that may execute registry code. */
  runners: GuardRunnerMatch[];
  /** Install-adjacent segments the guard cannot safely reason about. */
  unanalyzable: GuardUnanalyzableSegment[];
  /** True when at least one segment already runs through `safeinstall`. */
  usesSafeInstall: boolean;
  /**
   * File paths the command writes to or deletes, as far as the analysis can
   * tell: redirection targets (`> file`) and arguments of common in-place
   * writers and removers (tee, sed -i, rm, mv, cp). Used by the trust
   * surface to intercept shell-level tampering with protected files.
   */
  writeTargets: string[];
  /**
   * The full command with every raw install segment prefixed with
   * `safeinstall ` (and alias subcommands canonicalized). Only present when
   * there is at least one install and no unanalyzable segment, i.e. when the
   * rewrite is a complete, safe replacement.
   */
  rewrittenCommand?: string;
}

interface ShellToken {
  /** Dequoted value. */
  value: string;
  /** Offset of the first character of the token in the original command. */
  start: number;
  /** Offset one past the last character of the token. */
  end: number;
  /** True when any part of the token was quoted. */
  quoted: boolean;
  /** True when the token contains `$` outside single quotes. */
  hasExpansion: boolean;
}

interface ShellSegment {
  tokens: ShellToken[];
  start: number;
  end: number;
  /** True when the segment contains $(...) or backtick substitution. */
  hasSubstitution: boolean;
}

const SEGMENT_SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);
const REDIRECTION_OPERATORS = new Set([">", ">>", "<", "<<", "2>", "2>>", "&>", "&>>", ">&", "<<<"]);
/** Redirections that write to (or truncate) their target file. */
const WRITE_REDIRECTIONS = new Set([">", ">>", "2>", "2>>", "&>", "&>>", ">&"]);
/** Executables whose non-flag arguments are files they write to or remove. */
const FILE_WRITER_EXECUTABLES = new Set(["tee", "rm", "unlink", "mv", "cp", "truncate", "shred"]);
const PACKAGE_MANAGERS = new Set<string>(["npm", "pnpm", "bun"]);
const WRAPPER_COMMANDS = new Set(["sudo", "command", "nohup", "time", "env", "exec", "corepack"]);

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
const INSTALL_HINT_PATTERN = /\b(npm|pnpm|bun|yarn)\b/;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Standalone package-runner binaries. */
const RUNNER_EXECUTABLES: Record<string, { tool: string; alwaysRemote: boolean }> = {
  npx: { tool: "npx", alwaysRemote: false },
  pnpx: { tool: "pnpx", alwaysRemote: true },
  bunx: { tool: "bunx", alwaysRemote: false }
};

/** Runner subcommands per package manager. pnpm exec is local-only, so it is not listed. */
const RUNNER_SUBCOMMANDS: Record<string, Record<string, { tool: string; alwaysRemote: boolean }>> = {
  npm: {
    exec: { tool: "npm exec", alwaysRemote: false },
    x: { tool: "npm exec", alwaysRemote: false }
  },
  pnpm: {
    dlx: { tool: "pnpm dlx", alwaysRemote: true }
  },
  bun: {
    x: { tool: "bunx", alwaysRemote: false }
  },
  yarn: {
    dlx: { tool: "yarn dlx", alwaysRemote: true }
  }
};

/** Runner flags that consume a value token. */
const RUNNER_FLAGS_WITH_VALUES = new Set(["-p", "--package", "-c", "--call", "--shell", "--cwd"]);

/**
 * Split a shell command into pipeline/list segments, tokenizing each one.
 * Quote- and escape-aware; subshell grouping `(`/`)` and substitution are
 * detected but not descended into.
 */
export function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];

  let tokens: ShellToken[] = [];
  let segmentStart = 0;
  let hasSubstitution = false;

  let tokenValue = "";
  let tokenStart = -1;
  let tokenQuoted = false;
  let tokenHasExpansion = false;

  const flushToken = (endIndex: number): void => {
    if (tokenStart === -1) {
      return;
    }
    tokens.push({
      value: tokenValue,
      start: tokenStart,
      end: endIndex,
      quoted: tokenQuoted,
      hasExpansion: tokenHasExpansion
    });
    tokenValue = "";
    tokenStart = -1;
    tokenQuoted = false;
    tokenHasExpansion = false;
  };

  const flushSegment = (endIndex: number): void => {
    flushToken(endIndex);
    if (tokens.length > 0 || hasSubstitution) {
      segments.push({ tokens, start: segmentStart, end: endIndex, hasSubstitution });
    }
    tokens = [];
    hasSubstitution = false;
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index];

    if (char === "'") {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      tokenQuoted = true;
      index += 1;
      while (index < command.length && command[index] !== "'") {
        tokenValue += command[index];
        index += 1;
      }
      index += 1; // closing quote (or end of string on unterminated input)
      continue;
    }

    if (char === '"') {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      tokenQuoted = true;
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) {
          tokenValue += command[index + 1];
          index += 2;
          continue;
        }
        if (command[index] === "$") {
          tokenHasExpansion = true;
          if (command[index + 1] === "(") {
            hasSubstitution = true;
          }
        }
        if (command[index] === "`") {
          hasSubstitution = true;
        }
        tokenValue += command[index];
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === "\\" && index + 1 < command.length) {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      tokenValue += command[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      hasSubstitution = true;
      if (tokenStart === -1) {
        tokenStart = index;
      }
      tokenValue += char;
      index += 1;
      continue;
    }

    if (char === "$") {
      if (tokenStart === -1) {
        tokenStart = index;
      }
      tokenHasExpansion = true;
      if (command[index + 1] === "(") {
        hasSubstitution = true;
      }
      tokenValue += char;
      index += 1;
      continue;
    }

    if (char === " " || char === "\t") {
      flushToken(index);
      index += 1;
      continue;
    }

    if (char === "\n" || char === ";") {
      flushSegment(index);
      index += 1;
      segmentStart = index;
      continue;
    }

    if (char === "&" || char === "|") {
      // Distinguish separators (&&, ||, |, &) from redirections (&>, >&).
      const pair = command.slice(index, index + 2);
      if (pair === "&>" || pair === ">&") {
        flushToken(index);
        tokenStart = index;
        tokenValue = pair;
        index += 2;
        flushToken(index);
        continue;
      }
      flushSegment(index);
      index += SEGMENT_SEPARATORS.has(pair) ? 2 : 1;
      segmentStart = index;
      continue;
    }

    if (char === ">" || char === "<") {
      flushToken(index);
      let operator = char;
      let cursor = index + 1;
      while (cursor < command.length && (command[cursor] === ">" || command[cursor] === "<")) {
        operator += command[cursor];
        cursor += 1;
      }
      tokenStart = index;
      tokenValue = operator;
      index = cursor;
      flushToken(index);
      continue;
    }

    if (char === "(" || char === ")") {
      // Subshell grouping: treat contents as part of the surrounding
      // analysis but flag it so install hints inside are not missed.
      hasSubstitution = true;
      flushToken(index);
      index += 1;
      continue;
    }

    if (tokenStart === -1) {
      tokenStart = index;
    }
    tokenValue += char;
    index += 1;
  }

  flushSegment(command.length);
  return segments;
}

function basename(value: string): string {
  // Split on both separators so Windows-style paths resolve too, and strip
  // Windows launcher extensions (npm.cmd, npm.exe).
  let base = value.split(/[\\/]/).pop() ?? value;
  base = base.replace(/\.(cmd|exe|bat|ps1)$/i, "");
  // corepack allows version-suffixed binaries (`corepack pnpm@9 add ...`).
  const atIndex = base.indexOf("@", 1);
  return atIndex > 0 ? base.slice(0, atIndex) : base;
}

/**
 * Skip env-var assignments and common wrapper commands (sudo, env, nohup...)
 * to find the index of the effective command token in a segment. Reports the
 * corepack token separately because a safeinstall rewrite must remove it.
 */
function findCommandTokenIndex(tokens: ShellToken[]): { index: number; corepackToken?: ShellToken } {
  let index = 0;
  let corepackToken: ShellToken | undefined;

  while (index < tokens.length) {
    const value = tokens[index].value;

    if (ENV_ASSIGNMENT_PATTERN.test(value)) {
      index += 1;
      continue;
    }

    if (WRAPPER_COMMANDS.has(basename(value))) {
      if (basename(value) === "corepack") {
        corepackToken = tokens[index];
      }
      index += 1;
      continue;
    }

    return { index, corepackToken };
  }

  return { index: -1, corepackToken };
}

/** Remove redirection operators and their targets from a token list. */
function stripRedirections(tokens: ShellToken[]): ShellToken[] {
  const result: ShellToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (REDIRECTION_OPERATORS.has(value)) {
      index += 1; // skip the redirection target as well
      continue;
    }
    result.push(tokens[index]);
  }

  return result;
}

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
    corepackToken?: ShellToken;
  };
  runner?: GuardRunnerMatch;
  unanalyzable?: GuardUnanalyzableSegment;
  usesSafeInstall?: boolean;
  writeTargets?: string[];
}

/**
 * Collect the files a segment writes to or deletes: targets of write
 * redirections plus the non-flag arguments of common file writers/removers
 * (tee, sed -i, rm, mv, cp). Best effort — the reconciliation layer catches
 * whatever slips past this interception layer.
 */
function collectWriteTargets(tokens: ShellToken[], commandIndex: number): string[] {
  const targets: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (WRITE_REDIRECTIONS.has(tokens[index].value)) {
      const target = tokens[index + 1]?.value;
      if (target && target !== "/dev/null") {
        targets.push(target);
      }
      index += 1;
    }
  }

  if (commandIndex >= 0 && commandIndex < tokens.length) {
    const executable = basename(tokens[commandIndex].value);
    const args = stripRedirections(tokens.slice(commandIndex + 1));
    const isInPlaceSed = executable === "sed" && args.some((token) => token.value === "-i" || token.value.startsWith("-i"));
    if (FILE_WRITER_EXECUTABLES.has(executable) || isInPlaceSed) {
      for (const token of args) {
        if (!token.value.startsWith("-")) {
          targets.push(token.value);
        }
      }
    }
  }

  return targets;
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
  config: { tool: string; alwaysRemote: boolean },
  argumentTokens: ShellToken[],
  segmentText: string
): SegmentFinding {
  const target = analyzeRunnerTarget(argumentTokens);
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
  const { index: commandIndex, corepackToken } = findCommandTokenIndex(segment.tokens);

  if (commandIndex === -1) {
    if (segment.hasSubstitution && INSTALL_HINT_PATTERN.test(segmentText)) {
      return {
        unanalyzable: {
          segmentText,
          reason: "The segment uses shell substitution and mentions a package manager, so SafeInstall cannot verify what would be installed."
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
          reason: "The segment uses shell substitution and mentions a package manager, so SafeInstall cannot verify what would be installed."
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
            text: `safeinstall ${install.corepackToken ? install.manager : command.slice(install.managerToken.start, install.managerToken.end)}`
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
