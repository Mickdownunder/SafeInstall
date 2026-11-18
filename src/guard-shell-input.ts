import { findCommandTokenIndex, shellBasename, stripRedirections } from "./guard-shell";
import type { ShellSegment, ShellToken } from "./guard-shell";
import type { GuardUnanalyzableSegment } from "./guard-types";

/**
 * Commands whose script the guard does not get as arguments of the segment
 * it analyzes:
 * - a shell that reads its commands from a pipe or a here-string
 *   (`echo 'npm install x' | sh`, `sh <<< 'npm install x'`),
 * - a git alias that runs a shell command (`git -c alias.x='!npm install y' x`,
 *   or one stored with `git config alias.x '!...'` for later),
 * - a command word that pathname expansion completes (`np? install x`).
 *
 * Each case fails closed only when the text it can see names a package
 * manager or runner, the same rule the guard applies to `sh -c "..."`. What
 * a script file or a file fed on stdin contains stays out of reach, as
 * documented in the README's guard limitations.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INSTALL_OR_RUNNER_WORD = /\b(?:npm|pnpm|bun|yarn|npx|pnpx|bunx|corepack)\b/i;
/** Command names a completed glob must not be able to produce. */
const GUARDED_COMMAND_NAMES = ["npm", "pnpm", "bun", "yarn", "npx", "pnpx", "bunx", "corepack"];

function unanalyzable(segmentText: string, reason: string): GuardUnanalyzableSegment {
  return { segmentText, reason };
}

/**
 * A shell glob as a regular expression over one path component, or undefined
 * when the shell's syntax has no equivalent here (a reversed range such as
 * `[z-a]`). The caller treats undefined as a glob that can name anything.
 */
function globPattern(glob: string): RegExp | undefined {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] as string;
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else if (character === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      const body = glob.slice(index + 1, close).replace(/^[!^]/, "^").replace(/\\/g, "\\\\");
      source += `[${body}]`;
      index = close;
    } else {
      source += character.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${source}$`, "i");
  } catch {
    return undefined;
  }
}

function globCanNameGuardedCommand(token: ShellToken): boolean {
  if (!token.hasGlob) return false;
  const component = token.value.split(/[\\/]/).pop() ?? token.value;
  const pattern = globPattern(component.replace(/\.(cmd|exe|bat|ps1)$/i, ""));
  return pattern === undefined || GUARDED_COMMAND_NAMES.some((name) => pattern.test(name));
}

/**
 * True when a shell takes its commands from standard input: no `-c` and no
 * script operand (`bash`, `bash -s`, `sh -`).
 */
function readsCommandsFromInput(args: ShellToken[]): boolean {
  for (const arg of stripRedirections(args)) {
    if (arg.value === "-" || arg.value === "-s" || arg.value === "--") return true;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg.value)) return false;
    if (!arg.value.startsWith("-") && !arg.value.startsWith("+")) return false;
  }
  return true;
}

/** The here-string operands of a segment (`<<< 'text'`). */
function hereStrings(tokens: ShellToken[]): string[] {
  const values: string[] = [];
  tokens.forEach((token, index) => {
    if (/^(?:\d+)?<<<$/.test(token.value)) {
      const operand = tokens[index + 1];
      if (operand) values.push(operand.value);
    }
  });
  return values;
}

/** The text of the commands piped into segment `index`. */
function pipedInput(segments: ShellSegment[], index: number, command: string): string {
  const parts: string[] = [];
  for (let current = index; current > 0 && segments[current]?.connector === "pipe"; current -= 1) {
    const previous = segments[current - 1] as ShellSegment;
    parts.push(command.slice(previous.start, previous.end));
  }
  return parts.join("\n");
}

/**
 * The shell commands of git aliases a git invocation defines: `-c alias.x=!cmd`
 * for this call, or `git config [options] alias.x '!cmd'` for later ones.
 */
function gitShellAliases(args: ShellToken[]): string[] {
  const bodies: string[] = [];
  const values = args.map((arg) => arg.value);
  values.forEach((value, index) => {
    const setting = value === "-c" ? values[index + 1] : value.startsWith("-c") ? value.slice(2) : undefined;
    const body = setting?.match(/^alias\.[^=]+=\s*!(.*)$/is)?.[1];
    if (body !== undefined) bodies.push(body);
  });
  const configIndex = values.indexOf("config");
  if (configIndex !== -1) {
    values.slice(configIndex + 1).forEach((value, offset, rest) => {
      const next = rest[offset + 1];
      if (/^alias\./i.test(value) && next?.trimStart().startsWith("!")) bodies.push(next);
    });
  }
  return bodies;
}

/** An install or runner hidden from the analysis of segment `index`, as an unanalyzable finding. */
export function findHiddenShellInput(
  segments: ShellSegment[],
  index: number,
  command: string
): GuardUnanalyzableSegment | undefined {
  const segment = segments[index];
  if (!segment) return undefined;
  const segmentText = command.slice(segment.start, segment.end).trim();
  const { index: commandIndex } = findCommandTokenIndex(segment.tokens);
  const commandToken = segment.tokens[commandIndex];
  if (commandIndex === -1 || !commandToken) return undefined;

  if (globCanNameGuardedCommand(commandToken)) {
    return unanalyzable(
      segmentText,
      "The command name contains a glob that the shell can complete to a package manager or package runner, so SafeInstall cannot see what would run and fails closed. Spell out the command name literally."
    );
  }

  const executable = shellBasename(commandToken.value);
  const args = segment.tokens.slice(commandIndex + 1);

  if (SHELLS.has(executable) && readsCommandsFromInput(args)) {
    const input = [pipedInput(segments, index, command), ...hereStrings(segment.tokens)].join("\n");
    if (INSTALL_OR_RUNNER_WORD.test(input)) {
      return unanalyzable(
        segmentText,
        "A shell reads its commands from a pipe or a here-string that names a package manager or package runner, which SafeInstall cannot analyze. Run the install as a plain top-level command instead."
      );
    }
  }

  if (executable === "git" && gitShellAliases(args).some((body) => INSTALL_OR_RUNNER_WORD.test(body))) {
    return unanalyzable(
      segmentText,
      "A git alias that runs a shell command names a package manager or package runner, which SafeInstall cannot analyze. Run the install as a plain top-level command instead."
    );
  }

  return undefined;
}
