import { describe, expect, it } from "vitest";

import {
  REDACTED_CREDENTIAL,
  containsSensitiveArgs,
  containsSensitiveCredentials,
  redactSensitiveArgs,
  redactSensitiveText
} from "../src/redaction";

describe("credential redaction", () => {
  it.each([
    ["https://user:top-secret@example.test/pkg.tgz", "https://[REDACTED]@example.test/pkg.tgz"],
    ["https://user:top@secret@example.test/pkg.tgz", "https://[REDACTED]@example.test/pkg.tgz"],
    ["git+https://token@example.test/repo.git", "git+https://[REDACTED]@example.test/repo.git"],
    ["https://example.test/pkg.tgz?access_token=top-secret&download=1", "https://example.test/pkg.tgz?access_token=[REDACTED]&download=1"],
    ["https://example.test/pkg.tgz?%74oken=top-secret", "https://example.test/pkg.tgz?%74oken=[REDACTED]"],
    ["https://example.test/pkg.tgz?X-Amz-Signature=top-secret", "https://example.test/pkg.tgz?X-Amz-Signature=[REDACTED]"],
    ["ssh://user:top-secret@example.test/repo.git", "ssh://[REDACTED]@example.test/repo.git"],
    ["Authorization: Bearer top-secret", "Authorization: Bearer [REDACTED]"]
  ])("redacts credential-bearing URL text", (input, expected) => {
    expect(containsSensitiveCredentials(input)).toBe(true);
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it("redacts inline and split credential arguments", () => {
    const args = [
      "npm",
      "install",
      "--_authToken=top-secret",
      "--//registry.example.test/:_auth=third-secret",
      "--password",
      "second-secret"
    ];

    expect(containsSensitiveArgs(args)).toBe(true);
    expect(redactSensitiveArgs(args)).toEqual([
      "npm",
      "install",
      `--_authToken=${REDACTED_CREDENTIAL}`,
      `--//registry.example.test/:_auth=${REDACTED_CREDENTIAL}`,
      "--password",
      REDACTED_CREDENTIAL
    ]);
    expect(containsSensitiveCredentials("https://example.test/pkg?token=[REDACTED]")).toBe(true);
  });

  it("preserves ordinary URLs, registry specs, and SSH usernames", () => {
    const values = [
      "https://example.test/pkg.tgz?download=1",
      "git+ssh://git@example.test/repo.git",
      "@scope/pkg@1.2.3"
    ];

    for (const value of values) {
      expect(containsSensitiveCredentials(value)).toBe(false);
      expect(redactSensitiveText(value)).toBe(value);
    }
  });
});
