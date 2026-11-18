import {
  collectWriteTargetTokens,
  findCommandTokenIndex,
  hasDynamicCommandName,
  leadingBraceOpens,
  shellBasename as basename,
  startsWithBraceClose,
  stripRedirections
} from "./guard-shell";
import type { ScopeEvent, ShellSegment, ShellToken } from "./guard-shell";
import { literalDirectoryWord, parseWordAlternatives } from "./guard-words";
import type { GuardWriteOperation, WordPart } from "./guard-types";

/**
 * The file writes of a shell command, each with the working directories it
 * can run in. `cd`, `pushd`, subshells, groups, pipelines and wrappers such as
 * `env -C` change where a relative target lands; the trust-surface check in
 * guard-write-match.ts resolves the targets against these directories.
 */

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

export function collectWriteOperations(segments: ShellSegment[], command: string): GuardWriteOperation[] {
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
