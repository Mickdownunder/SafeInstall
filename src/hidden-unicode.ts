/**
 * Hidden-Unicode detection for the Agent Trust Surface.
 *
 * Invisible code points — zero-width spaces/joiners, bidi controls, the Unicode
 * tags block — are how a payload hides text a human reviewer cannot see in an
 * instruction file (AGENTS.md, CLAUDE.md, rules files) but an agent still reads
 * and obeys. The trust surface always blocks them, regardless of mode. Kept as
 * a self-contained module so the detection ranges are reviewable in isolation.
 */

/**
 * Invisible / direction-override code points with NO legitimate purpose in
 * agent instruction or config files: the implicit and explicit bidi controls
 * Trojan Source abuses, zero-width characters that hide text, and the Unicode
 * tags block that can smuggle invisible instructions. Anything here is a hard
 * finding.
 *
 * Deliberately EXCLUDED to avoid false positives with no override path: soft
 * hyphen (U+00AD, common in prose pasted from Word/PDF) and the line/paragraph
 * separators (U+2028/2029, which JSON.stringify emits raw into config string
 * values). These are formatting characters, not injection vectors; hard-blocking
 * them would lock down a benign file that `lock`/`approve` then refuse to
 * baseline.
 */
const HIDDEN_UNICODE_RANGES: Array<[number, number]> = [
  [0x061c, 0x061c], // ARABIC LETTER MARK (implicit bidi)
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x202a, 0x202e], // explicit bidi embeddings/overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates (LRI/RLI/FSI/PDI)
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
  [0xe0000, 0xe007f] // Unicode tags block
];

function isHiddenCodePoint(codePoint: number): boolean {
  return HIDDEN_UNICODE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Detect hidden Unicode code points in a text. A byte-order mark at offset 0
 * is a legitimate encoding artifact and is not reported (it is still removed
 * by normalization so hashes stay stable).
 */
export function detectHiddenUnicode(text: string): string[] {
  const found = new Set<string>();
  let offset = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (isHiddenCodePoint(codePoint) && !(offset === 0 && codePoint === 0xfeff)) {
      found.add(formatCodePoint(codePoint));
    }
    offset += char.length;
  }
  return [...found].sort();
}

/** Remove all hidden Unicode code points (including a leading BOM). */
export function normalizeHiddenUnicode(text: string): string {
  let result = "";
  for (const char of text) {
    if (!isHiddenCodePoint(char.codePointAt(0) as number)) {
      result += char;
    }
  }
  return result;
}
