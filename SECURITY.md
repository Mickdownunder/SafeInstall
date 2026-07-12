# Security Policy

## Supported versions

| Version | Supported |
|:---|:---|
| 0.13.x | Yes |
| < 0.13 | No (upgrade to the latest 0.13.x release) |

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
  decisions and installs, and in CI on every pull request. Since 0.12.0 the
  CI check itself is hardened against pull-request mutation: the workflow
  definition is loaded from the protected base branch
  (`pull_request_target`), the candidate is checked out strictly as data,
  and the verifier CLI is pinned by sha512 content hash — a pull request
  cannot neuter its own trust check.
- **Requires human review:** a fully consistent rewrite. An attacker who can
  edit a pull request can rewrite the policy, the lock, and the ledger
  together into an internally consistent state; the committed baseline has
  no reference outside the repository (RFC-001 §13 K2). The security
  boundary for that case is human review of the trust-surface diff — which
  is exactly what such a rewrite must appear in.

This gap is a known finding from the adversarial review in
[RFC-001 §13](docs/rfcs/rfc-001-verifiable-dependency-decisions.md) (K1–K3).
Status of the decided fix (2026-07-10; decisions in RFC-001 §14):

- **Shipped:** the external verification anchor,
  [safeinstall-verifier](https://github.com/Mickdownunder/safeinstall-verifier)
  — a separate, code-owner-locked repository holding the verification logic
  with an integrity-pinned CLI, an adversarial suite required on every
  change (tampered workflow, policy, registry URL, forged lock,
  name-spoofed check, removed baseline, naive consistent rewrite, corrupt
  tarball — all must fail), and its own branch ruleset.
- **Pending (owner-gated):** switching this repository's trust workflow to
  invoke that verifier by full commit SHA. The switch edits an
  enforcement-zone file, so it deliberately requires the owner's
  interactive `safeinstall trust approve` — the same human gate it
  protects.

**Maintainer model (decided 2026-07-11,
[#41](https://github.com/Mickdownunder/SafeInstall/issues/41)):** SafeInstall
is maintained solo. GitHub does not count a pull-request author's
self-approval, so platform-enforced second-party review of trust-surface
paths is not attainable with one maintainer; "human review" above means
review by the same single owner who merges. A second maintainer will be
added organically from the contributor pool — not appointed for
availability, because every added key is added attack surface. Until then,
treat the automatic guarantee as tamper-evidence against inconsistent
changes plus externally anchored verification logic, not as two-party
control.

## Provenance

SafeInstall is published to npm with [Sigstore provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions trusted publishing. Every release is cryptographically traceable to a specific commit and workflow run.

Last verified: 2026-07-12
