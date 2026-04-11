import { TYPO_SQUAT_TARGETS } from "./typo-squat-targets";
import type { SafeInstallConfig, TypoSquatConfig } from "./types";

/**
 * Damerau-Levenshtein distance with a bounded cutoff. Returns `cutoff + 1`
 * whenever the true distance exceeds the cutoff so callers can abort early
 * without computing the full matrix.
 *
 * Unlike plain Levenshtein, this variant counts an adjacent-character
 * transposition ("raect" vs "react") as a single edit, which matches the
 * most common real-world typo pattern.
 */
export function damerauLevenshtein(left: string, right: string, cutoff = Infinity): number {
  if (left === right) {
    return 0;
  }

  const leftLength = left.length;
  const rightLength = right.length;

  if (leftLength === 0) {
    return rightLength;
  }
  if (rightLength === 0) {
    return leftLength;
  }

  if (Math.abs(leftLength - rightLength) > cutoff) {
    return cutoff + 1;
  }

  const previousPrevious = new Array<number>(rightLength + 1);
  const previous = new Array<number>(rightLength + 1);
  const current = new Array<number>(rightLength + 1);

  for (let column = 0; column <= rightLength; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= leftLength; row += 1) {
    current[0] = row;
    let minInRow = current[0];

    for (let column = 1; column <= rightLength; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;

      current[column] = Math.min(
        current[column - 1] + 1, // insertion
        previous[column] + 1, // deletion
        previous[column - 1] + substitutionCost // substitution
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        current[column] = Math.min(current[column], previousPrevious[column - 2] + 1);
      }

      if (current[column] < minInRow) {
        minInRow = current[column];
      }
    }

    if (minInRow > cutoff) {
      return cutoff + 1;
    }

    for (let column = 0; column <= rightLength; column += 1) {
      previousPrevious[column] = previous[column];
      previous[column] = current[column];
    }
  }

  return previous[rightLength];
}

export interface TypoSquatSuspicion {
  requested: string;
  suspectedTarget: string;
  editDistance: number;
}

/**
 * Compare a requested package name against the embedded top-N target list.
 * Returns a suspicion when the name is a close-but-not-exact match to one
 * of the known popular packages.
 *
 * Returns `undefined` if:
 *  - the requested name is shorter than the configured minimum
 *  - the requested name is an exact match to a popular package (legitimate)
 *  - the requested name is on the ignore list for this project
 *  - no target is within edit distance 2 (and within ±2 character length)
 */
export function detectTypoSquat(
  requestedName: string,
  config: TypoSquatConfig,
  targets: readonly string[] = TYPO_SQUAT_TARGETS
): TypoSquatSuspicion | undefined {
  const normalized = requestedName.toLowerCase();

  if (normalized.length < config.minNameLength) {
    return undefined;
  }

  if (config.ignore.includes(normalized)) {
    return undefined;
  }

  // Exact match to a popular package = legitimate install, not a typo-squat.
  if (targets.includes(normalized)) {
    return undefined;
  }

  let bestTarget: string | undefined;
  let bestDistance = Infinity;

  for (const target of targets) {
    if (Math.abs(target.length - normalized.length) > 2) {
      continue;
    }

    const distance = damerauLevenshtein(normalized, target, 2);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = target;
      if (distance === 1) {
        break; // cannot do better than a single edit
      }
    }
  }

  if (bestTarget === undefined || bestDistance > 2 || bestDistance === 0) {
    return undefined;
  }

  return {
    requested: requestedName,
    suspectedTarget: bestTarget,
    editDistance: bestDistance
  };
}

export function isTypoSquatModeActive(config: SafeInstallConfig): boolean {
  return config.typoSquat.mode !== "off";
}
