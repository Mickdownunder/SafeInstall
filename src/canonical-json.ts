/**
 * RFC 8785 (JSON Canonicalization Scheme) restricted to the RFC-001 §14 D1
 * producer profile: every number is an integer in the IEEE-754 exact range,
 * timestamps are RFC 3339 strings, and strings are well-formed Unicode
 * (I-JSON — no lone surrogates).
 *
 * The profile is what keeps every implementation trivial: JCS's only hard
 * requirement — ECMAScript number serialization — collapses to plain integer
 * printing, so a conforming producer is a recursive key sort (by UTF-16 code
 * units, which is exactly `Array.prototype.sort` on strings) plus standard
 * JSON string escaping. Digests over records are sha256 over these bytes, and
 * the record FILE is exactly these bytes — one byte truth, no
 * pretty-file/canonical-digest split (RFC-001 §5.1).
 *
 * Violations throw instead of being silently coerced: a record that cannot be
 * canonicalized must never be written, and a record whose bytes are not
 * canonical must never verify.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path})`);
    this.name = "CanonicalJsonError";
  }
}

/**
 * I-JSON well-formedness: every UTF-16 surrogate must be part of a pair.
 * (Equivalent to String.prototype.isWellFormed, implemented locally so the
 * project's ES2022 type target stays untouched.)
 */
function isWellFormedUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalizeValue(value: unknown, pathLabel: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number": {
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          `Non-integer or unsafe number ${String(value)}: the record profile allows exact-range integers only`,
          pathLabel
        );
      }
      // String(-0) is "0", matching JCS's ECMAScript serialization rule.
      out.push(String(value));
      return;
    }
    case "string": {
      if (!isWellFormedUnicode(value)) {
        throw new CanonicalJsonError(
          "String contains a lone surrogate; records require well-formed Unicode (I-JSON)",
          pathLabel
        );
      }
      out.push(JSON.stringify(value));
      return;
    }
    case "object":
      break;
    case "bigint":
    case "symbol":
    case "undefined":
    case "function":
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value}`, pathLabel);
  }

  if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        out.push(",");
      }
      canonicalizeValue(value[index], `${pathLabel}[${index}]`, out);
    }
    out.push("]");
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Dates, Maps, class instances: the producer must convert deliberately
    // (e.g. Date -> RFC 3339 string). Implicit coercion here would hide the
    // decision that RFC-001 §14 D1 requires to be explicit.
    throw new CanonicalJsonError("Non-plain object; convert it to JSON data explicitly", pathLabel);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries) {
    if (entryValue === undefined) {
      throw new CanonicalJsonError(
        `Property ${JSON.stringify(key)} is undefined; use null for explicit absence`,
        pathLabel
      );
    }
    if (!isWellFormedUnicode(key)) {
      throw new CanonicalJsonError(
        `Property name ${JSON.stringify(key)} contains a lone surrogate`,
        pathLabel
      );
    }
  }

  // JCS orders properties by UTF-16 code units — the default string sort.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  out.push("{");
  let first = true;
  for (const [key, entryValue] of entries) {
    if (!first) {
      out.push(",");
    }
    first = false;
    out.push(JSON.stringify(key), ":");
    canonicalizeValue(entryValue, `${pathLabel}.${key}`, out);
  }
  out.push("}");
}

/** Canonical JCS text (profile-restricted) for a JSON-compatible value. */
export function canonicalizeJson(value: unknown): string {
  const out: string[] = [];
  canonicalizeValue(value, "$", out);
  return out.join("");
}

/** Canonical bytes: UTF-8, no insignificant whitespace, no trailing newline. */
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), "utf8");
}

/**
 * True when `bytes` are exactly the canonical serialization of the JSON value
 * they encode. Verifiers use this to reject records that parse but were not
 * written canonically (re-indented, re-ordered, BOM-prefixed, ...).
 */
export function isCanonicalJson(bytes: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  try {
    return canonicalJsonBytes(parsed).equals(bytes);
  } catch {
    return false;
  }
}
