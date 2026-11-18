import os from "node:os";
import path from "node:path";

import type { GuardCommandAnalysis, WordPart } from "./guard-types";
import { findProtectedWrite } from "./guard-write-match";
import type { ProtectedWrite } from "./guard-write-match";
import { nativeShellPath } from "./shell-drive-paths";
import { findTrustContext } from "./trust-surface";

/**
 * The trust lock is found from the hook event's cwd. A command can still
 * write into another locked project by absolute path, from the home
 * directory, or after a `cd`; that write is judged by the lock of the project
 * it lands in.
 */

/**
 * The spelled-out start of a write target: its text up to the first glob or
 * expansion, with a leading `~` or `$HOME` read as the home directory, and
 * whether that is the whole target.
 */
function literalStart(parts: WordPart[]): { text: string; complete: boolean } {
  let text = "";
  for (const [index, part] of parts.entries()) {
    if (part.kind === "text") {
      text += part.value;
    } else if (index === 0 && (part.kind === "tilde" || (part.kind === "var" && part.name === "HOME"))) {
      text += os.homedir();
    } else {
      return { text, complete: false };
    }
  }
  return { text, complete: true };
}

/**
 * Directories a command writes in, as far as they are spelled out: every
 * working directory it can `cd` to, the directory of every literal target,
 * and the literal directory in front of a glob or expansion (`/p/.mcp.js*`
 * writes in `/p`), each resolved against those working directories.
 */
function reachedDirectories(analysis: GuardCommandAnalysis, cwd: string): Set<string> {
  const directories = new Set<string>();
  for (const operation of analysis.writeOperations) {
    const workingDirectories = operation.cwdVariants.map((changes) =>
      changes.reduce((directory, change) => path.resolve(directory, nativeShellPath(change)), cwd)
    );
    for (const directory of workingDirectories) {
      directories.add(directory);
    }
    for (const parts of operation.words) {
      const start = literalStart(parts);
      const literal = nativeShellPath(start.text);
      const spelled = start.complete ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
      if (spelled === "") continue;
      for (const directory of path.isAbsolute(spelled) ? [cwd] : workingDirectories) {
        const target = path.resolve(directory, spelled);
        if (!start.complete) {
          directories.add(target);
          continue;
        }
        directories.add(path.dirname(target));
        // `rm -r dir` removes what is below the target itself.
        if (operation.recursive) directories.add(target);
      }
    }
  }
  return directories;
}

/** A protected write in a locked project the command reaches, other than `checkedRoot`. */
export async function findProtectedWriteInReachedRoots(
  analysis: GuardCommandAnalysis,
  cwd: string,
  checkedRoot: string | undefined
): Promise<ProtectedWrite | undefined> {
  if (analysis.writeOperations.length === 0) {
    return undefined;
  }
  const roots = new Set<string>();
  for (const directory of reachedDirectories(analysis, cwd)) {
    const context = await findTrustContext(directory);
    for (const root of context?.conflictingRoots ?? (context ? [context.root] : [])) {
      if (root !== checkedRoot) roots.add(root);
    }
  }
  for (const root of roots) {
    const hit = await findProtectedWrite(analysis.writeOperations, { root, cwd });
    if (hit) return hit;
  }
  return undefined;
}
