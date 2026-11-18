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
    [
      "https://storage.googleapis.com/b/pkg.tgz?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40p.iam.gserviceaccount.com%2F20261118%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Expires=600&X-Goog-Signature=0123abcdef",
      "https://storage.googleapis.com/b/pkg.tgz?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=[REDACTED]&X-Goog-Expires=600&X-Goog-Signature=[REDACTED]"
    ],
    ["ssh://user:top-secret@example.test/repo.git", "ssh://[REDACTED]@example.test/repo.git"],
    ["HTTPS://user:top-secret@example.test/pkg.tgz", "HTTPS://[REDACTED]@example.test/pkg.tgz"],
    ["https://us%3Aer:p%40ss@example.test/pkg.tgz", "https://[REDACTED]@example.test/pkg.tgz"],
    ["git://token@example.test/repo.git", "git://[REDACTED]@example.test/repo.git"],
    [
      "git+https://user:top-secret@example.test/o/r.git#semver:^1.2.3",
      "git+https://[REDACTED]@example.test/o/r.git#semver:^1.2.3"
    ],
    [
      "foo@https://user:s3cr3tMARK@example.test/x.tgz",
      "foo@https://[REDACTED]@example.test/x.tgz"
    ],
    ["https://example.test/x.tgz?API_KEY=top-secret", "https://example.test/x.tgz?API_KEY=[REDACTED]"],
    ["https://example.test/x?a=1&jwt=top-secret#frag", "https://example.test/x?a=1&jwt=[REDACTED]#frag"],
    ["--registry=https://u:top-secret@example.test/", "--registry=https://[REDACTED]@example.test/"],
    ["--//example.test/:_authToken=top-secret", "--//example.test/:_authToken=[REDACTED]"],
    ["--//example.test/a/b/:username=top-secret", "--//example.test/a/b/:username=[REDACTED]"],
    ["--//example.test/:_password=top-secret", "--//example.test/:_password=[REDACTED]"],
    ["--otp=123456", "--otp=[REDACTED]"]
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
      "ssh://git@example.test/repo.git",
      "git@github.com:o/r.git",
      "git+https://github.com/o/r.git#main",
      "@scope/pkg@1.2.3",
      "foo@npm:bar@1",
      "next-auth@>=4",
      "oauth@>=0.9",
      "auth@>=1",
      "next-auth@>=4.0.0",
      "fix: code=1 handling",
      "key=value",
      "Authorization: Bearer abc",
      "https://example.test/x?code=1&session=2&monkey=3"
    ];

    for (const value of values) {
      expect(containsSensitiveCredentials(value)).toBe(false);
      expect(redactSensitiveText(value)).toBe(value);
    }
  });

  it("flags ssh userinfo only when it carries a password", () => {
    expect(containsSensitiveCredentials("git+ssh://git:pw@example.test/r.git")).toBe(true);
    expect(containsSensitiveCredentials("git+ssh://git@example.test/r.git")).toBe(false);
  });
});
