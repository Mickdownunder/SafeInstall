import { describe, expect, it } from "vitest";

import { CanonicalJsonError, canonicalJsonBytes, canonicalizeJson, isCanonicalJson } from "../src/canonical-json";

describe("canonicalizeJson", () => {
  it("serializes primitives and containers without insignificant whitespace", () => {
    expect(canonicalizeJson({ b: [1, null, true], a: "x" })).toBe('{"a":"x","b":[1,null,true]}');
  });

  it("sorts object keys by UTF-16 code units, not code points", () => {
    // The signature JCS ordering case: an emoji's high surrogate (0xD83D)
    // sorts BEFORE U+FB33 even though its code point (0x1F600) is larger.
    const canonical = canonicalizeJson({ "דּ": 1, "😀": 2, "€": 3 });
    expect(canonical).toBe('{"€":3,"😀":2,"דּ":1}');
  });

  it("sorts uppercase before lowercase (plain code-unit order)", () => {
    expect(canonicalizeJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}');
  });

  it("escapes strings exactly like JSON.stringify", () => {
    expect(canonicalizeJson({ a: "line\nbreak \"quoted\" \\ " })).toBe(
      '{"a":"line\\nbreak \\"quoted\\" \\\\ \\u0007"}'
    );
  });

  it("prints -0 as 0 and accepts the full safe-integer range", () => {
    expect(canonicalizeJson([-0, 0, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])).toBe(
      "[0,0,9007199254740991,-9007199254740991]"
    );
  });

  it.each([
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53]
  ])("rejects %s (integer-only profile)", (_label, value) => {
    expect(() => canonicalizeJson({ n: value })).toThrow(CanonicalJsonError);
  });

  it("rejects lone surrogates in strings and property names", () => {
    expect(() => canonicalizeJson({ a: "broken \uD800 surrogate" })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ "\uDC00": 1 })).toThrow(CanonicalJsonError);
    expect(canonicalizeJson({ a: "😀" })).toBe('{"a":"😀"}');
  });

  it("rejects undefined property values instead of dropping them silently", () => {
    expect(() => canonicalizeJson({ a: undefined })).toThrow(/use null for explicit absence/);
  });

  it("rejects non-plain objects so producers must convert deliberately", () => {
    expect(() => canonicalizeJson({ at: new Date(0) })).toThrow(/Non-plain object/);
  });

  it("names the offending path in errors", () => {
    expect(() => canonicalizeJson({ outer: { inner: [1, 1.5] } })).toThrow("$.outer.inner[1]");
  });
});

describe("isCanonicalJson", () => {
  it("accepts exactly the canonical bytes", () => {
    expect(isCanonicalJson(canonicalJsonBytes({ b: 1, a: [true, "x"] }))).toBe(true);
  });

  it.each([
    ["pretty-printed JSON", Buffer.from('{\n  "a": 1\n}', "utf8")],
    ["unsorted keys", Buffer.from('{"b":1,"a":2}', "utf8")],
    ["a trailing newline", Buffer.from('{"a":1}\n', "utf8")],
    ["a BOM prefix", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', "utf8")])],
    ["a float (profile violation)", Buffer.from('{"a":1.5}', "utf8")],
    ["scientific notation", Buffer.from('{"a":1e2}', "utf8")],
    ["duplicate keys", Buffer.from('{"a":1,"a":2}', "utf8")],
    ["not JSON at all", Buffer.from("nope", "utf8")]
  ])("rejects %s", (_label, bytes) => {
    expect(isCanonicalJson(bytes)).toBe(false);
  });
});
