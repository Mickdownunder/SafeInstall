# Security Policy

## Supported versions

| Version | Supported |
|:---|:---|
| 0.11.x | Yes |
| < 0.11 | No (upgrade to the latest 0.11.x release) |

## Reporting a vulnerability

If you discover a security vulnerability in SafeInstall, **do not open a public issue.** Instead, report it privately via email:

**Michael@acpip.io**

Include:
- A description of the vulnerability
- Steps to reproduce
- The version of SafeInstall affected
- Any potential impact assessment

## Response timeline

- **Acknowledgement**: within 48 hours of receiving the report.
- **Initial assessment**: within 5 business days.
- **Fix and disclosure**: coordinated with the reporter. A patch release will be published before or simultaneously with public disclosure.

## Scope

The following are in scope for security reports:

- Policy bypass (a package that should be blocked by a configured rule is allowed)
- Cache poisoning (an attacker can manipulate cached registry metadata to influence policy decisions)
- Credential or token exposure through SafeInstall's behavior
- Command injection or path traversal via crafted package names or config values
- Vulnerabilities in SafeInstall's own dependencies that are exploitable through SafeInstall's usage patterns

The following are explicitly out of scope:

- Vulnerabilities in packages that SafeInstall evaluates (SafeInstall is a policy gate, not a vulnerability scanner)
- Social engineering attacks that require the user to intentionally misconfigure SafeInstall
- Denial-of-service through extremely large lockfiles or dependency trees (SafeInstall inherits the performance characteristics of the underlying package manager)

## Trust surface guarantee (current scope)

The Agent Trust Surface (`safeinstall trust lock` / `trust status`) currently
provides the following, stated precisely so nobody relies on more than it
delivers:

- **Enforced automatically:** inconsistent tampering. Any change to a locked
  file (policy config, agent hook files, `.safeinstall/`) that does not also
  consistently rewrite the lock and ledger is detected locally before guard
  decisions and installs, and in CI on every pull request.
- **Requires human review:** a fully consistent rewrite. An attacker who can
  edit a pull request can today rewrite the policy, the lock, the ledger, and
  the verification workflow together; the committed baseline has no reference
  outside the repository yet. The real security boundary for that case is
  human review of the trust-surface diff.

This gap is a known finding from the adversarial review in
[RFC-001 §13](docs/rfcs/rfc-001-verifiable-dependency-decisions.md) (K1–K3).
The decided fix (2026-07-10, in progress): trust verification will run from a
source outside pull-request mutation — a separate, code-owner-locked verifier
repository referenced by commit SHA, with the verifier CLI pinned by hash —
combined with code-owner review required on trust-surface paths. Until that
lands, treat the automatic guarantee as tamper-evidence against inconsistent
changes, not tamper-proofing against a fully consistent rewrite.

## Provenance

SafeInstall is published to npm with [Sigstore provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions trusted publishing. Every release is cryptographically traceable to a specific commit and workflow run.

Last verified: 2026-07-10
