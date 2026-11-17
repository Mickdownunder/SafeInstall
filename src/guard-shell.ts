/** Shell tokenization and command-position resolution for the shell guard. */

export interface ShellToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
  hasExpansion: boolean;
}

export interface ShellSegment {
  tokens: ShellToken[];
  start: number;
  end: number;
  hasSubstitution: boolean;
  /**
   * True for `$(...)`, backticks and process substitution. Plain `( ... )`
   * grouping sets `hasSubstitution` (fail-closed for installs) but not this.
   */
  hasCommandSubstitution: boolean;
  /** Unquoted parentheses seen in this segment, in order. */
  scopeEvents: ScopeEvent[];
  /** Shell operator joining the previous non-empty segment to this one. */
  connector?: "sequence" | "and" | "or" | "pipe" | "background";
}

export interface ScopeEvent {
  type: "open" | "close";
  /** True for `$(`, `<(` and `>(`; false for a plain subshell or function-body paren. */
  substitution: boolean;
  /** Number of complete tokens that precede the parenthesis in its segment. */
  tokenCount: number;
}

export interface ShellWriteTarget {
  token: ShellToken;
  kind: "redirection" | "argument";
  /** True when a directory operand is removed or moved as a whole (`rm -r`, `mv`). */
  recursive: boolean;
  /** True for `>(...)`: the target is a process, not a path. */
  processSubstitution?: boolean;
}

const REDIRECTION_OPERATORS = ["&>>", "<<<", "<<-", ">>", "<<", "<>", ">|", ">&", "<&", "&>", ">", "<"] as const;
const REDIRECTION_OPERATOR_SET = new Set<string>(REDIRECTION_OPERATORS);
const WRITE_REDIRECTIONS = new Set([">", ">>", "<>", ">|", "&>", "&>>", ">&"]);
const FILE_WRITER_EXECUTABLES = new Set(["tee", "rm", "unlink", "mv", "cp", "truncate", "shred"]);
const WRAPPER_COMMANDS = new Set(["sudo", "command", "nohup", "time", "env", "exec", "corepack"]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Reserved words that precede a command without being one: the command they
 * introduce (`then npm install`, `do npm install`, `! npm install`) runs
 * exactly like a top-level command, so command-position resolution skips them.
 */
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
/** `{a,b}` and `{1..3}` expand into several words before the command runs. */
const BRACE_EXPANSION_PATTERN = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
const PACKAGE_MANAGER_NAMES = new Set(["npm", "pnpm", "bun", "yarn"]);

interface WrapperOptionSpec {
  booleanFlags: ReadonlySet<string>;
  valueFlags: ReadonlySet<string>;
  opaqueValueFlags?: ReadonlySet<string>;
  terminalFlags?: ReadonlySet<string>;
}

const WRAPPER_OPTIONS: Record<string, WrapperOptionSpec> = {
  sudo: {
    booleanFlags: new Set([
      "-A", "--askpass", "-b", "--background", "-E", "--preserve-env", "-H", "--set-home",
      "-n", "--non-interactive", "-S", "--stdin", "-s", "--shell", "-i", "--login"
    ]),
    valueFlags: new Set([
      "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from",
      "-R", "--chroot", "-D", "--chdir", "-T", "--command-timeout", "-r", "--role", "-t", "--type"
    ]),
    terminalFlags: new Set([
      "-V", "--version", "-v", "--validate", "-k", "--remove-timestamp", "-K", "--reset-timestamp",
      "-l", "--list"
    ])
  },
  env: {
    booleanFlags: new Set(["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"]),
    valueFlags: new Set([
      "-u", "--unset", "-C", "--chdir", "--block-signal", "--default-signal", "--ignore-signal"
    ]),
    opaqueValueFlags: new Set(["-S", "--split-string"]),
    terminalFlags: new Set(["--help", "--version"])
  },
  command: {
    booleanFlags: new Set(["-p"]),
    valueFlags: new Set(),
    terminalFlags: new Set(["-v", "-V"])
  },
  time: {
    booleanFlags: new Set(["-a", "--append", "-p", "--portability", "-v", "--verbose"]),
    valueFlags: new Set(["-f", "--format", "-o", "--output"]),
    terminalFlags: new Set(["--help", "--version"])
  },
  nohup: {
    booleanFlags: new Set(),
    valueFlags: new Set(),
    terminalFlags: new Set(["--help", "--version"])
  },
  exec: {
    booleanFlags: new Set(["-c", "-l"]),
    valueFlags: new Set(["-a"])
  },
  corepack: {
    booleanFlags: new Set(),
    valueFlags: new Set(),
    terminalFlags: new Set(["--help", "--version", "-v"])
  }
};

/** Split a shell command into quote-aware pipeline/list segments and tokens. */
export function splitShellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let tokens: ShellToken[] = [];
  let segmentStart = 0;
  let connector: ShellSegment["connector"];
  let hasSubstitution = false;
  let hasCommandSubstitution = false;
  let scopeEvents: ScopeEvent[] = [];
  let tokenValue = "";
  let tokenStart = -1;
  let tokenQuoted = false;
  let tokenHasExpansion = false;
  let tokenHasUnquotedBrace = false;

  const flushToken = (end: number): void => {
    if (tokenStart === -1) return;
    if (tokenHasUnquotedBrace && BRACE_EXPANSION_PATTERN.test(tokenValue)) tokenHasExpansion = true;
    tokenHasUnquotedBrace = false;
    tokens.push({ value: tokenValue, start: tokenStart, end, quoted: tokenQuoted, hasExpansion: tokenHasExpansion });
    tokenValue = "";
    tokenStart = -1;
    tokenQuoted = false;
    tokenHasExpansion = false;
  };

  const flushSegment = (end: number): void => {
    flushToken(end);
    if (tokens.length > 0 || hasSubstitution) {
      segments.push({
        tokens,
        start: segmentStart,
        end,
        hasSubstitution,
        hasCommandSubstitution,
        scopeEvents,
        ...(connector === undefined ? {} : { connector })
      });
    }
    tokens = [];
    hasSubstitution = false;
    hasCommandSubstitution = false;
    scopeEvents = [];
  };

  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (character === "'") {
      if (tokenStart === -1) tokenStart = index;
      tokenQuoted = true;
      index += 1;
      while (index < command.length && command[index] !== "'") tokenValue += command[index++];
      index += 1;
      continue;
    }
    if (character === '"') {
      if (tokenStart === -1) tokenStart = index;
      tokenQuoted = true;
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && command[index + 1] === "\n") {
          // Line continuation: the shell removes both characters.
          index += 2;
          continue;
        }
        if (command[index] === "\\" && index + 1 < command.length) {
          tokenValue += command[index + 1];
          index += 2;
          continue;
        }
        if (command[index] === "$") {
          tokenHasExpansion = true;
          if (command[index + 1] === "(") {
            hasSubstitution = true;
            hasCommandSubstitution = true;
          }
        }
        if (command[index] === "`") {
          hasSubstitution = true;
          hasCommandSubstitution = true;
        }
        tokenValue += command[index++];
      }
      index += 1;
      continue;
    }
    if (character === "\\" && command[index + 1] === "\n") {
      // Line continuation: the shell removes both characters and keeps the
      // current word open, so a manager and its subcommand split across lines
      // are still one command.
      index += 2;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      if (tokenStart === -1) tokenStart = index;
      tokenValue += command[index + 1];
      index += 2;
      continue;
    }
    if (character === "`") {
      hasSubstitution = true;
      hasCommandSubstitution = true;
      if (tokenStart === -1) tokenStart = index;
      tokenValue += character;
      index += 1;
      continue;
    }
    if (character === "$" && command[index + 1] === "'") {
      // ANSI-C quoting: the quoted body is a literal word. Backslash escapes
      // are not decoded; the word is marked dynamic instead, with a `$` kept
      // in its value so command resolution treats the name as unknown.
      if (tokenStart === -1) tokenStart = index;
      tokenQuoted = true;
      index += 2;
      let body = "";
      let escaped = false;
      while (index < command.length && command[index] !== "'") {
        if (command[index] === "\\" && index + 1 < command.length) {
          escaped = true;
          body += command[index + 1];
          index += 2;
          continue;
        }
        body += command[index++];
      }
      index += 1;
      if (escaped) {
        tokenHasExpansion = true;
        tokenValue += `$${body}`;
      } else {
        tokenValue += body;
      }
      continue;
    }
    if (character === "$") {
      if (tokenStart === -1) tokenStart = index;
      tokenHasExpansion = true;
      if (command[index + 1] === "(") {
        hasSubstitution = true;
        hasCommandSubstitution = true;
      }
      tokenValue += character;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t") {
      flushToken(index++);
      continue;
    }
    if (character === "\n" || character === ";") {
      flushSegment(index);
      connector = "sequence";
      segmentStart = ++index;
      continue;
    }

    if ((character === ">" || character === "<") && command[index + 1] === "(") {
      if (tokenStart === -1) tokenStart = index;
      hasSubstitution = true;
      hasCommandSubstitution = true;
      tokenHasExpansion = true;
      tokenValue += character;
      index += 1;
      continue;
    }

    const redirection = REDIRECTION_OPERATORS.find((operator) => command.startsWith(operator, index));
    if (redirection) {
      const hasIoPrefix =
        tokenStart !== -1 &&
        !tokenQuoted &&
        (/^\d+$/.test(tokenValue) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(tokenValue));
      const operatorStart = hasIoPrefix ? tokenStart : index;
      const operatorValue = hasIoPrefix ? `${tokenValue}${redirection}` : redirection;
      if (hasIoPrefix) {
        tokenValue = "";
        tokenStart = -1;
        tokenQuoted = false;
        tokenHasExpansion = false;
        tokenHasUnquotedBrace = false;
      } else {
        flushToken(index);
      }
      tokens.push({
        value: operatorValue,
        start: operatorStart,
        end: index + redirection.length,
        quoted: false,
        hasExpansion: false
      });
      index += redirection.length;
      continue;
    }
    if (character === "&" || character === "|") {
      const pair = command.slice(index, index + 2);
      flushSegment(index);
      index += pair === "&&" || pair === "||" ? 2 : 1;
      connector = pair === "&&" ? "and" : pair === "||" ? "or" : character === "|" ? "pipe" : "background";
      segmentStart = index;
      continue;
    }
    if (character === "(" || character === ")") {
      hasSubstitution = true;
      flushToken(index);
      const previous = command[index - 1];
      scopeEvents.push({
        type: character === "(" ? "open" : "close",
        substitution: character === "(" && (previous === "$" || previous === "<" || previous === ">"),
        tokenCount: tokens.length
      });
      index += 1;
      continue;
    }
    if (tokenStart === -1) tokenStart = index;
    if (character === "{") tokenHasUnquotedBrace = true;
    tokenValue += character;
    index += 1;
  }
  flushSegment(command.length);
  return segments;
}

export function shellBasename(value: string): string {
  let base = value.split(/[\\/]/).pop() ?? value;
  base = base.replace(/\.(cmd|exe|bat|ps1)$/i, "");
  const at = base.indexOf("@", 1);
  return (at > 0 ? base.slice(0, at) : base).toLowerCase();
}

/**
 * The package manager a word names, also through its script entry point
 * (a manager's `-cli.js` or `.cjs` file run by node). Undefined otherwise.
 */
export function packageManagerFromWord(value: string): string | undefined {
  const base = shellBasename(value).replace(/\.[cm]?js$/, "").replace(/-cli$/, "");
  return PACKAGE_MANAGER_NAMES.has(base) ? base : undefined;
}

/**
 * True when the word's command name cannot be read statically: its last path
 * component still contains an expansion. A dynamic directory in front of a
 * literal binary name stays static.
 */
export function hasDynamicCommandName(token: ShellToken): boolean {
  if (!token.hasExpansion) return false;
  const last = token.value.split(/[\\/]/).pop() ?? token.value;
  return /[$`{]/.test(last);
}

function redirectionBase(value: string): string | undefined {
  const base = value.replace(/^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})/, "");
  return REDIRECTION_OPERATOR_SET.has(base) ? base : undefined;
}

function skipRedirection(tokens: ShellToken[], index: number): number | undefined {
  return redirectionBase(tokens[index]?.value ?? "") === undefined
    ? undefined
    : Math.min(tokens.length, index + 2);
}

export function stripRedirections(tokens: ShellToken[]): ShellToken[] {
  const result: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    const end = skipRedirection(tokens, index);
    if (end !== undefined) {
      index = end - 1;
    } else {
      result.push(token);
    }
  }
  return result;
}

function hasAttachedValue(value: string, flags: ReadonlySet<string>): boolean {
  return [...flags].some((flag) =>
    flag.startsWith("--")
      ? value.startsWith(`${flag}=`)
      : value.startsWith(flag) && value.length > flag.length
  );
}

function scanWrapper(tokens: ShellToken[], wrapperIndex: number, wrapper: string): {
  nextIndex: number;
  error?: string;
  terminal?: boolean;
} {
  const spec = WRAPPER_OPTIONS[wrapper];
  if (spec === undefined) {
    // Invariant: scanWrapper is only reached after WRAPPER_COMMANDS.has(wrapper)
    // succeeds, and every WRAPPER_COMMANDS entry has a WRAPPER_OPTIONS spec. A
    // miss means the two tables drifted out of sync — a programming error.
    throw new Error(`No wrapper-option spec registered for wrapper "${wrapper}".`);
  }
  let index = wrapperIndex + 1;
  while (index < tokens.length) {
    const redirectionEnd = skipRedirection(tokens, index);
    if (redirectionEnd !== undefined) {
      index = redirectionEnd;
      continue;
    }
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const value = token.value;
    if (value === "--") return { nextIndex: index + 1 };
    if (!value.startsWith("-") || value === "-") return { nextIndex: index };
    if (spec.terminalFlags?.has(value)) return { nextIndex: -1, terminal: true };
    if (spec.opaqueValueFlags?.has(value) || (spec.opaqueValueFlags && hasAttachedValue(value, spec.opaqueValueFlags))) {
      return { nextIndex: -1, error: `${wrapper} split-string command text requires shell-aware parsing and cannot be inspected safely.` };
    }
    if (spec.booleanFlags.has(value) || hasAttachedValue(value, spec.valueFlags)) {
      index += 1;
      continue;
    }
    if (spec.valueFlags.has(value)) {
      if (index + 1 >= tokens.length) {
        return { nextIndex: -1, error: `${wrapper} option ${JSON.stringify(value)} is missing its value.` };
      }
      index += 2;
      continue;
    }
    return { nextIndex: -1, error: `SafeInstall does not recognize wrapper option ${JSON.stringify(value)} for ${wrapper}.` };
  }
  return { nextIndex: -1 };
}

export interface CommandTokenResolution {
  index: number;
  corepackToken?: ShellToken | undefined;
  wrapperError?: string;
}

export function findCommandTokenIndex(tokens: ShellToken[]): CommandTokenResolution {
  let index = 0;
  let corepackToken: ShellToken | undefined;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const value = token.value;
    const redirectionEnd = skipRedirection(tokens, index);
    if (redirectionEnd !== undefined) {
      index = redirectionEnd;
      continue;
    }
    if (ENV_ASSIGNMENT_PATTERN.test(value)) {
      index += 1;
      continue;
    }
    if (!token.quoted && SHELL_KEYWORDS.has(value)) {
      index += 1;
      continue;
    }
    const wrapper = shellBasename(value);
    if (!WRAPPER_COMMANDS.has(wrapper)) return { index, corepackToken };
    if (wrapper === "corepack") corepackToken = token;
    const scan = scanWrapper(tokens, index, wrapper);
    if (scan.error) return { index: -1, corepackToken, wrapperError: scan.error };
    if (scan.terminal || scan.nextIndex < 0) return { index: -1, corepackToken };
    index = scan.nextIndex;
  }
  return { index: -1, corepackToken };
}

/** Number of `{` group openers that lead the segment (`{ cd x`, `if { ...`). */
export function leadingBraceOpens(tokens: ShellToken[]): number {
  let opens = 0;
  for (const token of tokens) {
    if (token.quoted || !SHELL_KEYWORDS.has(token.value)) break;
    if (token.value === "{") opens += 1;
  }
  return opens;
}

/** True when the segment starts with the `}` that closes a `{ ...; }` group. */
export function startsWithBraceClose(tokens: ShellToken[]): boolean {
  const first = tokens[0];
  return first !== undefined && !first.quoted && first.value === "}";
}

export function collectWriteTargetTokens(tokens: ShellToken[], commandIndex: number): ShellWriteTarget[] {
  const targets: ShellWriteTarget[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    const operator = redirectionBase(token.value);
    if (operator && token.hasExpansion) {
      if (WRITE_REDIRECTIONS.has(operator)) {
        targets.push({ token, kind: "redirection", recursive: false, processSubstitution: true });
      }
      continue;
    }
    if (operator && WRITE_REDIRECTIONS.has(operator)) {
      const target = tokens[index + 1];
      const duplicatesFd =
        (operator === ">&" || operator === "<&") &&
        target !== undefined &&
        !target.hasExpansion &&
        /^-?\d+$/.test(target.value);
      if (target && (target.value !== "/dev/null" || target.hasExpansion) && !duplicatesFd) {
        targets.push({ token: target, kind: "redirection", recursive: false });
      }
      index += 1;
    }
  }
  if (commandIndex < 0 || commandIndex >= tokens.length) return targets;
  const commandToken = tokens[commandIndex];
  if (commandToken === undefined) return targets;
  const executable = shellBasename(commandToken.value);
  const args = stripRedirections(tokens.slice(commandIndex + 1));
  const isInPlaceSed =
    executable === "sed" &&
    args.some(
      (token) => token.value.startsWith("-i") || token.value === "--in-place" || token.value.startsWith("--in-place=")
    );
  if (FILE_WRITER_EXECUTABLES.has(executable) || isInPlaceSed) {
    const recursive =
      executable === "mv" ||
      (executable === "rm" &&
        args.some((token) => /^-[A-Za-z]*[rRd][A-Za-z]*$/.test(token.value) || token.value === "--recursive" || token.value === "--dir"));
    for (const token of args) {
      if (!token.value.startsWith("-")) targets.push({ token, kind: "argument", recursive });
    }
  }
  return targets;
}

/** Backward-compatible best-effort target values used by parser consumers. */
export function collectWriteTargets(tokens: ShellToken[], commandIndex: number): string[] {
  return collectWriteTargetTokens(tokens, commandIndex).map(({ token }) => token.value);
}
