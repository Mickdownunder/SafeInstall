import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { GuardWriteOperation, WordPart } from "./guard-types";
import { nativeShellPath, shellDrivePrefix } from "./shell-drive-paths";
import { isTrustSurfacePath, trustSurfaceProtectedPaths } from "./trust-surface";

/**
 * Decides whether a recognized shell write could land on the Agent Trust
 * Surface. A write target is a word that may hold globs and run-time
 * expansions, evaluated from a tracked working directory that may itself be
 * uncertain. The word becomes a small pattern (literal characters, `*`, `?`,
 * `[..]`, and "unknown" wildcards) that is matched against the protected paths.
 *
 * - A fully literal target in a known directory is checked exactly, through
 *   both its lexical and its real (symlink-resolved) location.
 * - A pattern is anchored at its literal directory prefix and must be able to
 *   match a protected path under it.
 * - A pattern that starts with an unknown expansion, or any relative target
 *   under an unknown cwd, can start in any directory: it must match a suffix of
 *   a protected path.
 * - A pattern containing unknown expansions additionally needs a literal path
 *   component that names a protected component, so `> $OUT` stays allowed while
 *   `> $DIR/settings.json` does not.
 */

type PatternCell =
  | { t: "lit"; ch: string }
  | { t: "any" }
  | { t: "star" }
  | { t: "cls"; test: RegExp }
  | { t: "wild" };

export interface WriteMatchContext {
  /** Trust root reported by the trust lock. */
  root: string;
  /** Working directory of the hook event. */
  cwd: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProtectedWrite {
  operation: GuardWriteOperation;
  /** True when the target is one concrete protected path; false when it only could be. */
  exact: boolean;
}

interface ProtectedModel {
  files: string[];
  subtrees: string[];
  nestedNames: string[];
  nestedSubtree: string[];
  /** Directories that contain protected paths, including the subtrees' parents. */
  ancestors: Set<string>;
  components: Set<string>;
}

let cachedModel: ProtectedModel | undefined;

function protectedModel(): ProtectedModel {
  if (cachedModel) return cachedModel;
  const { files, subtrees, nestedNames, nestedSubtree } = trustSurfaceProtectedPaths();
  const ancestors = new Set<string>();
  const components = new Set<string>();
  for (const entry of [...files, ...subtrees]) {
    const segments = entry.split("/");
    segments.forEach((segment) => components.add(segment));
    for (let length = 1; length < segments.length; length += 1) {
      ancestors.add(segments.slice(0, length).join("/"));
    }
  }
  cachedModel = { files, subtrees, nestedNames, nestedSubtree, ancestors, components };
  return cachedModel;
}

function suffixes(entry: string): string[] {
  const segments = entry.split("/");
  return segments.map((_, index) => segments.slice(index).join("/"));
}

function classCell(value: string): PatternCell {
  let body = value.slice(1, -1);
  if (body.includes("[:") || body.includes("[=") || body.includes("[.")) return { t: "any" };
  let negate = false;
  if (body.startsWith("!") || body.startsWith("^")) {
    negate = true;
    body = body.slice(1);
  }
  try {
    return { t: "cls", test: new RegExp(`^[${negate ? "^" : ""}${body.replace(/[\\\]^[]/g, "\\$&")}]$`) };
  } catch {
    return { t: "any" };
  }
}

interface ResolvedWord {
  cells: PatternCell[];
  /** True when an expansion could not be resolved. */
  unresolved: boolean;
  /** True when the word contains globs. */
  globbed: boolean;
}

function literalCells(text: string): PatternCell[] {
  return [...text].map((ch) => ({ t: "lit", ch }) as const);
}

function resolveWord(
  parts: WordPart[],
  cwd: string | undefined,
  home: string,
  env: NodeJS.ProcessEnv
): ResolvedWord {
  const cells: PatternCell[] = [];
  let unresolved = false;
  let globbed = false;
  const known = (value: string | undefined): void => {
    if (value === undefined || value === "") {
      cells.push({ t: "wild" });
      unresolved = true;
    } else {
      // Home and environment values are native paths: `C:\Users\x` on Windows.
      cells.push(...literalCells(process.platform === "win32" ? value.replace(/\\/g, "/") : value));
    }
  };
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        cells.push(...literalCells(part.value));
        break;
      case "glob":
        globbed = true;
        cells.push(part.value === "*" ? { t: "star" } : part.value === "?" ? { t: "any" } : classCell(part.value));
        break;
      case "tilde":
        known(home);
        break;
      case "var":
        known(part.name === "HOME" ? home : part.name === "PWD" ? cwd : part.name === "TMPDIR" ? env.TMPDIR : undefined);
        break;
      case "unknown":
        cells.push({ t: "wild" });
        unresolved = true;
        break;
    }
  }
  return { cells: withNativeDrive(cells), unresolved, globbed };
}

/**
 * On Windows, a target that starts the way Git Bash or Cygwin spell a drive
 * (`/c/...`, `/cygdrive/c/...`) is rewritten to `C:/...`, where the shell
 * writes it.
 */
function withNativeDrive(cells: PatternCell[]): PatternCell[] {
  let prefix = "";
  for (const cell of cells) {
    if (cell.t !== "lit") break;
    prefix += cell.ch;
  }
  const drive = shellDrivePrefix(prefix);
  // `/c` names the drive only as a whole component: not in `/c*`.
  if (!drive || (drive.length === prefix.length && !prefix.endsWith("/") && cells.length > prefix.length)) {
    return cells;
  }
  return [...literalCells(`${drive.letter}:/`), ...cells.slice(drive.length)];
}

/** On Windows, the drive root of a `C:/...` pattern and the cells after it. */
function driveRooted(cells: PatternCell[]): { root: string; rest: PatternCell[] } | undefined {
  if (process.platform !== "win32") return undefined;
  const [letter, colon, slash] = cells;
  if (letter?.t !== "lit" || !/^[A-Za-z]$/.test(letter.ch)) return undefined;
  if (colon?.t !== "lit" || colon.ch !== ":" || slash?.t !== "lit" || slash.ch !== "/") return undefined;
  return { root: `${letter.ch.toUpperCase()}:\\`, rest: cells.slice(3) };
}

function matchCells(cells: PatternCell[], text: string, prefix: boolean): boolean {
  const memo = new Map<number, boolean>();
  const width = text.length + 1;
  const visit = (ci: number, si: number): boolean => {
    const key = ci * width + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    if (prefix && si === text.length) {
      result = true;
    } else if (ci === cells.length) {
      result = si === text.length;
    } else {
      const cell = cells[ci] as PatternCell;
      const atStart = si === 0 || text[si - 1] === "/";
      const character = text[si];
      const plain = character !== undefined && character !== "/" && !(atStart && character === ".");
      if (cell.t === "lit") {
        result = character === cell.ch && visit(ci + 1, si + 1);
      } else if (cell.t === "any") {
        result = plain && visit(ci + 1, si + 1);
      } else if (cell.t === "cls") {
        result = plain && cell.test.test(character as string) && visit(ci + 1, si + 1);
      } else if (cell.t === "star") {
        result = visit(ci + 1, si);
        for (let end = si; !result && plain && end < text.length && text[end] !== "/"; end += 1) {
          result = visit(ci + 1, end + 1);
        }
      } else {
        result = visit(ci + 1, si) || (si < text.length && visit(ci, si + 1));
      }
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function splitComponents(cells: PatternCell[]): PatternCell[][] {
  const components: PatternCell[][] = [];
  let current: PatternCell[] = [];
  for (const cell of cells) {
    if (cell.t === "lit" && cell.ch === "/") {
      if (current.length > 0) components.push(current);
      current = [];
    } else {
      current.push(cell);
    }
  }
  if (current.length > 0) components.push(current);
  return components;
}

function literalName(component: PatternCell[]): string | undefined {
  let name = "";
  for (const cell of component) {
    if (cell.t !== "lit") return undefined;
    name += cell.ch;
  }
  return name;
}

function joinComponents(components: PatternCell[][]): PatternCell[] {
  const cells: PatternCell[] = [];
  components.forEach((component, index) => {
    if (index > 0) cells.push({ t: "lit", ch: "/" });
    cells.push(...component);
  });
  return cells;
}

function hasProtectedLiteralComponent(cells: PatternCell[]): boolean {
  const { components } = protectedModel();
  return splitComponents(cells).some((component) => {
    const name = literalName(component);
    return name !== undefined && components.has(name);
  });
}

/**
 * Could `cells` name an instruction file at any depth (`AGENTS.md`, `CLAUDE.md`,
 * `.cursorrules`, anything under a `.cursor/rules`)? Only the final components
 * count, and a glob only counts when the component starts with a literal
 * character, so `packages/*` or `rm *` are not read as nested-file targets while
 * `packages/*\/AGENTS.md` and `AGENTS.m?` are. Nothing under `node_modules` or
 * `.git` is protected.
 */
function matchesNestedInstruction(cells: PatternCell[], recursive: boolean): boolean {
  const { nestedNames, nestedSubtree } = protectedModel();
  const components = splitComponents(cells);
  if (components.length === 0) return false;
  if (components.some((component) => ["node_modules", ".git"].includes(literalName(component) ?? ""))) return false;
  const startsLiteral = (component: PatternCell[]): boolean => component[0]?.t === "lit";
  const last = components[components.length - 1] as PatternCell[];
  if (startsLiteral(last) && nestedNames.some((name) => matchCells(last, name, false))) return true;
  const [parent, child] = nestedSubtree as [string, string];
  return components.some((component, index) => {
    if (literalName(component) !== parent) return false;
    const next = components[index + 1];
    if (next === undefined) return recursive;
    return startsLiteral(next) && matchCells(next, child, false);
  });
}

/** Could `cells`, relative to the trust root, name a protected path? */
function matchesProtectedFromRoot(cells: PatternCell[], recursive: boolean): boolean {
  const model = protectedModel();
  if (model.files.some((file) => matchCells(cells, file, false))) return true;
  if (model.subtrees.some((dir) => matchCells(cells, dir, false) || matchCells(cells, `${dir}/`, true))) return true;
  return recursive && [...model.ancestors].some((dir) => matchCells(cells, dir, false));
}

/** Could `cells`, starting in some unknown directory, name a protected path? */
function matchesProtectedFromAnywhere(cells: PatternCell[], recursive: boolean): boolean {
  const model = protectedModel();
  const components = splitComponents(cells);
  while (components.length > 0) {
    const name = literalName(components[0] as PatternCell[]);
    if (name === "." || name === "..") components.shift();
    else break;
  }
  if (components.length === 0) return recursive;
  const variants: PatternCell[][] = [joinComponents(components)];
  const first = components[0] as PatternCell[];
  if (first.length === 1 && first[0]?.t === "wild") {
    // `$DIR/rest`: the unknown part stands for any directory prefix.
    variants.push(components.length > 1 ? joinComponents(components.slice(1)) : []);
  }
  return variants.some((variant) => {
    if (variant.length === 0) return true;
    return (
      model.files.some((file) => suffixes(file).some((suffix) => matchCells(variant, suffix, false))) ||
      model.subtrees.some((dir) =>
        suffixes(dir).some((suffix) => matchCells(variant, suffix, false) || matchCells(variant, `${suffix}/`, true))
      ) ||
      (recursive &&
        [...model.ancestors].some((dir) => suffixes(dir).some((suffix) => matchCells(variant, suffix, false))))
    );
  });
}

function isOutside(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export async function findProtectedWrite(
  operations: GuardWriteOperation[],
  context: WriteMatchContext
): Promise<ProtectedWrite | undefined> {
  if (operations.length === 0) return undefined;
  const home = context.home ?? os.homedir();
  const env = context.env ?? process.env;
  const realCache = new Map<string, string>();

  const realDeepest = async (absolute: string): Promise<string> => {
    const cached = realCache.get(absolute);
    if (cached !== undefined) return cached;
    let current = absolute;
    const tail: string[] = [];
    let result = absolute;
    for (;;) {
      try {
        result = path.join(await realpath(current), ...tail.reverse());
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) break;
        tail.push(path.basename(current));
        current = parent;
      }
    }
    realCache.set(absolute, result);
    return result;
  };

  const root = await realDeepest(path.resolve(context.root));

  const isProtectedAbsolute = (absolute: string, recursive: boolean): boolean => {
    const relative = path.relative(root, absolute);
    if (isOutside(relative)) {
      // A recursive removal or move of the root itself or of one of its parents.
      return recursive && !isOutside(path.relative(absolute, root));
    }
    if (isTrustSurfacePath(root, absolute)) return true;
    if (!recursive) return false;
    const posix = toPosix(relative);
    if (relative === "" || protectedModel().ancestors.has(posix)) return true;
    // A recursive removal of a nested `.cursor` directory takes its rules with it.
    const segments = posix.split("/");
    return (
      segments[segments.length - 1] === protectedModel().nestedSubtree[0] &&
      !segments.some((segment) => segment === "node_modules" || segment === ".git")
    );
  };

  const literalHit = async (absolute: string, recursive: boolean): Promise<boolean> =>
    isProtectedAbsolute(absolute, recursive) || isProtectedAbsolute(await realDeepest(absolute), recursive);

  /** Walk the leading literal components onto `start`; returns the directory reached and the rest. */
  const walkLiteralPrefix = (
    start: string,
    components: PatternCell[][]
  ): { directory: string; rest: PatternCell[][] } => {
    let directory = start;
    let index = 0;
    for (; index < components.length; index += 1) {
      const name = literalName(components[index] as PatternCell[]);
      if (name === undefined) break;
      if (name === ".") continue;
      directory = name === ".." ? path.dirname(directory) : path.join(directory, name);
    }
    return { directory, rest: components.slice(index) };
  };

  const evaluate = async (
    operation: GuardWriteOperation,
    cwd: string | undefined
  ): Promise<ProtectedWrite | undefined> => {
    const check = async (
      cells: PatternCell[],
      guard: boolean,
      exactWhenLiteral: boolean
    ): Promise<ProtectedWrite | undefined> => {
      if (cells.length === 0) return undefined;
      const drive = driveRooted(cells);
      const absolute = drive !== undefined || (cells[0]?.t === "lit" && cells[0].ch === "/");
      const floating = cells[0]?.t === "wild" || (!absolute && cwd === undefined);
      const guarded = (matched: boolean): boolean => matched && (!guard || hasProtectedLiteralComponent(cells));

      if (floating) {
        return guarded(
          matchesProtectedFromAnywhere(cells, operation.recursive) ||
            matchesNestedInstruction(cells, operation.recursive)
        )
          ? { operation, exact: false }
          : undefined;
      }

      const components = splitComponents(drive ? drive.rest : cells);
      const starts = drive ? [drive.root] : absolute ? ["/"] : [cwd as string, await realDeepest(cwd as string)];
      for (const start of new Set(starts)) {
        const { directory, rest } = walkLiteralPrefix(start, components);
        if (rest.length === 0) {
          if (await literalHit(directory, operation.recursive)) return { operation, exact: exactWhenLiteral };
          continue;
        }
        for (const candidate of new Set([directory, await realDeepest(directory)])) {
          const relative = path.relative(root, candidate);
          if (isOutside(relative)) continue;
          const prefix = relative === "" ? [] : [literalCells(toPosix(relative))];
          const restCells = joinComponents(
            rest.map((component) => (literalName(component) === ".." ? [{ t: "wild" } as PatternCell] : component))
          );
          const joined = joinComponents([...prefix, restCells]);
          if (
            guarded(
              matchesProtectedFromRoot(joined, operation.recursive) ||
                matchesNestedInstruction(joined, operation.recursive)
            )
          ) {
            return { operation, exact: false };
          }
        }
      }
      return undefined;
    };

    for (const parts of operation.words) {
      const word = resolveWord(parts, cwd, home, env);
      if (cwd !== undefined && !word.globbed && !word.unresolved) {
        // A fully literal target is also resolved the way the platform does it
        // (drive letters, backslashes), so the pattern walk below can only add
        // denials to this check and never remove one.
        const literal = word.cells.map((cell) => (cell.t === "lit" ? cell.ch : "")).join("");
        if (literal !== "" && (await literalHit(path.resolve(cwd, literal), operation.recursive))) {
          return { operation, exact: true };
        }
      }
      const hit = await check(word.cells, word.unresolved, !word.globbed && !word.unresolved);
      if (hit) return hit;
      if (word.unresolved) {
        // An expansion can be empty: `.mcp.json$X` or `.claude/$X/settings.json`
        // name a protected path whenever the expansion expands to nothing.
        const emptied = await check(
          word.cells.filter((cell) => cell.t !== "wild"),
          false,
          false
        );
        if (emptied) return emptied;
      }
    }
    return undefined;
  };

  let possible: ProtectedWrite | undefined;
  for (const operation of operations) {
    const cwds = new Set<string>();
    for (const changes of operation.cwdVariants) {
      cwds.add(changes.reduce((directory, change) => path.resolve(directory, nativeShellPath(change)), context.cwd));
    }
    const hits: (ProtectedWrite | undefined)[] = [];
    for (const cwd of cwds) hits.push(await evaluate(operation, path.resolve(cwd)));
    if (operation.cwdUncertain) hits.push(await evaluate(operation, undefined));
    for (const hit of hits) {
      if (hit?.exact) return hit;
      possible ??= hit;
    }
  }
  return possible;
}
