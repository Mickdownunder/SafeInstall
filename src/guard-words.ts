import os from "node:os";

import type { WordPart } from "./guard-types";

/**
 * Reads one shell word from the raw command text and splits it into parts the
 * guard can reason about: literal text, unquoted globs, a leading tilde,
 * variable references, and opaque run-time expansions. Quote removal follows
 * the shell, so `"a*b"` keeps its `*` as text while `a*b` yields a glob.
 */

type Cell = { ch: string; live: boolean } | { part: WordPart };

const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const MAX_ALTERNATIVES = 64;
const UNKNOWN: WordPart = { kind: "unknown" };

function isLive(cell: Cell | undefined, ch: string): boolean {
  return cell !== undefined && "ch" in cell && cell.live && cell.ch === ch;
}

/** Index just after the `)` that matches the `(` at `open`. */
function skipBalanced(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) return source.length;
      index = end;
    } else if (character === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** Index just after the `}` that matches the `{` at `open`. */
function skipBraced(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** Handle the `$` at `index`; returns the index after the expansion. */
function expandDollar(source: string, index: number, cells: Cell[]): number {
  const next = source[index + 1];
  if (next === "(") {
    cells.push({ part: UNKNOWN });
    return skipBalanced(source, index + 1);
  }
  if (next === "{") {
    const end = skipBraced(source, index + 1);
    const inner = source.slice(index + 2, end - 1);
    cells.push({ part: /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? { kind: "var", name: inner } : UNKNOWN });
    return end;
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let end = index + 2;
    while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
    cells.push({ part: { kind: "var", name: source.slice(index + 1, end) } });
    return end;
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
    cells.push({ part: UNKNOWN });
    return index + 2;
  }
  cells.push({ ch: "$", live: false });
  return index + 1;
}

function readDoubleQuoted(source: string, start: number, cells: Cell[]): number {
  let index = start + 1;
  while (index < source.length && source[index] !== '"') {
    const character = source[index] as string;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped === "\n") {
        index += 2;
      } else if (escaped !== undefined && /["$`\\]/.test(escaped)) {
        cells.push({ ch: escaped, live: false });
        index += 2;
      } else {
        cells.push({ ch: "\\", live: false });
        index += 1;
      }
    } else if (character === "$") {
      index = expandDollar(source, index, cells);
    } else if (character === "`") {
      cells.push({ part: UNKNOWN });
      index = skipBackticks(source, index);
    } else {
      cells.push({ ch: character, live: false });
      index += 1;
    }
  }
  return index + 1;
}

function skipBackticks(source: string, open: number): number {
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "`") return index + 1;
  }
  return source.length;
}

function readCells(source: string, start: number): Cell[] {
  const cells: Cell[] = [];
  let index = start;
  while (index < source.length) {
    const character = source[index] as string;
    if (WORD_END.has(character)) break;
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped !== undefined && escaped !== "\n") cells.push({ ch: escaped, live: false });
      index += 2;
    } else if (character === "'") {
      const end = source.indexOf("'", index + 1);
      const body = source.slice(index + 1, end === -1 ? source.length : end);
      for (const bodyCharacter of body) cells.push({ ch: bodyCharacter, live: false });
      index = end === -1 ? source.length : end + 1;
    } else if (character === '"') {
      index = readDoubleQuoted(source, index, cells);
    } else if (character === "$" && source[index + 1] === "'") {
      const end = source.indexOf("'", index + 2);
      const body = source.slice(index + 2, end === -1 ? source.length : end);
      if (body.includes("\\")) cells.push({ part: UNKNOWN });
      else for (const bodyCharacter of body) cells.push({ ch: bodyCharacter, live: false });
      index = end === -1 ? source.length : end + 1;
    } else if (character === "$" && source[index + 1] === '"') {
      index = readDoubleQuoted(source, index + 1, cells);
    } else if (character === "$") {
      index = expandDollar(source, index, cells);
    } else if (character === "`") {
      cells.push({ part: UNKNOWN });
      index = skipBackticks(source, index);
    } else if (character === "~" && cells.length === 0) {
      let end = index + 1;
      while (end < source.length && !WORD_END.has(source[end] as string) && source[end] !== "/") end += 1;
      cells.push({ part: end === index + 1 ? { kind: "tilde" } : UNKNOWN });
      index = end;
    } else {
      cells.push({ ch: character, live: true });
      index += 1;
    }
  }
  return cells;
}

/** Expand `{a,b}` into alternatives; `{x..y}` ranges become an opaque expansion. */
function expandBraces(cells: Cell[]): Cell[][] {
  for (let open = 0; open < cells.length; open += 1) {
    if (!isLive(cells[open], "{")) continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < cells.length; index += 1) {
      const cell = cells[index];
      if (isLive(cell, "{")) depth += 1;
      else if (isLive(cell, "}")) {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      } else if (depth === 1 && isLive(cell, ",")) commas.push(index);
    }
    if (close === -1) continue;
    if (commas.length === 0) {
      const inner = cells
        .slice(open + 1, close)
        .map((cell) => ("ch" in cell ? cell.ch : "\u0000"))
        .join("");
      if (!inner.includes("..")) continue;
      return expandBraces([...cells.slice(0, open), { part: UNKNOWN }, ...cells.slice(close + 1)]);
    }
    const bounds = [open, ...commas, close];
    const results: Cell[][] = [];
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const alternative = cells.slice((bounds[index] as number) + 1, bounds[index + 1]);
      results.push(...expandBraces([...cells.slice(0, open), ...alternative, ...cells.slice(close + 1)]));
      if (results.length > MAX_ALTERNATIVES) return [[{ part: UNKNOWN }]];
    }
    return results;
  }
  return [cells];
}

function toParts(cells: Cell[]): WordPart[] {
  const parts: WordPart[] = [];
  const pushText = (value: string): void => {
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.value += value;
    else parts.push({ kind: "text", value });
  };
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index] as Cell;
    if ("part" in cell) {
      parts.push(cell.part);
    } else if (cell.live && (cell.ch === "*" || cell.ch === "?")) {
      const last = parts[parts.length - 1];
      if (!(cell.ch === "*" && last?.kind === "glob" && last.value === "*")) {
        parts.push({ kind: "glob", value: cell.ch });
      }
    } else if (cell.live && cell.ch === "[") {
      let end = index + 1;
      if (isLive(cells[end], "!") || isLive(cells[end], "^")) end += 1;
      if (isLive(cells[end], "]")) end += 1;
      while (end < cells.length && "ch" in (cells[end] as Cell) && !isLive(cells[end], "]")) end += 1;
      if (isLive(cells[end], "]")) {
        const value = cells
          .slice(index, end + 1)
          .map((member) => ("ch" in member ? member.ch : ""))
          .join("");
        parts.push({ kind: "glob", value });
        index = end;
      } else {
        pushText("[");
      }
    } else {
      pushText(cell.ch);
    }
  }
  return parts;
}

/** The word starting at `start` in `source`, as one parts list per brace alternative. */
export function parseWordAlternatives(source: string, start: number): WordPart[][] {
  return expandBraces(readCells(source, start)).map(toParts);
}

/**
 * The literal directory a `cd`-like word names, or undefined when it depends
 * on anything the guard cannot know. A leading `~` or `$HOME` resolves to the
 * home directory, a leading `$PWD` to the current directory (written as a
 * relative path so it composes with the tracked cwd).
 */
export function literalDirectoryWord(source: string, start: number): string | undefined {
  const alternatives = parseWordAlternatives(source, start);
  const parts = alternatives[0];
  if (alternatives.length !== 1 || parts === undefined) return undefined;
  const rest = [...parts];
  let prefix = "";
  const first = rest[0];
  if (first?.kind === "tilde" || (first?.kind === "var" && first.name === "HOME")) {
    prefix = os.homedir();
    rest.shift();
  } else if (first?.kind === "var" && first.name === "PWD") {
    prefix = ".";
    rest.shift();
  }
  let text = "";
  for (const part of rest) {
    if (part.kind !== "text") return undefined;
    text += part.value;
  }
  if (prefix !== "" && text !== "" && !text.startsWith("/")) return undefined;
  const directory = `${prefix}${text}`;
  return directory === "" ? undefined : directory;
}
