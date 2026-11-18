# Security Policy

## Supported versions

| Version | Supported |
|:---|:---|
| 0.16.x | Yes |
| < 0.16 | No (upgrade to the latest 0.16.x release) |

## Reporting a vulnerability

If you discover a security vulnerability in SafeInstall, **do not open a public issue.** Instead, report it privately via email:

**office@cyntro.at**

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

## What counts as a vulnerability

A report is a vulnerability when it breaks a guarantee this file or the
README states: a package that policy blocks gets installed, a protected file
changes without the approval the trust lock requires, a credential reaches
output or a decision record, or the verifier runs code its pinned digest
does not cover. Behavior listed below as an accepted limit, or in the
README's [Guard limitations](README.md#guard-limitations),
[Trust surface limitations](README.md#trust-surface-limitations--read-honestly)
and [Limitations](README.md#limitations), is not a vulnerability unless the
report shows a cheaper way to reach it than the one described there.

### The shell guard

The guard reads each shell command an agent is about to run, routes package
installs through the policy engine, and fails closed when it cannot tell
whether a command installs anything. That includes an install hidden in a
substitution, in `sh -c "..."`, in text piped or here-stringed into a shell,
in a git alias that runs a shell command, or behind a command word that a
glob could complete to a package manager.

It is not a sandbox. Code the agent writes to a file and runs, `node -e`,
`python -c` and any other interpreter can install packages without a
package-manager command line, and the guard does not read script files or
the contents of files fed to a shell. The trust lock and CI re-verification
catch the effects on the next run; the guard does not prevent them at the
moment of the call.

### Accepted limits

- **Registry configuration from the project.** A project `.npmrc` can map a
  scope, a proxy or a certificate authority to another host and reference a
  token from the environment. npm and pnpm read it themselves, and
  SafeInstall leaves credentials and registry scopes in place because
  private registries depend on them (settings that move files, disable
  checks or load code do block, see the README's Configuration section). A
  repository change can therefore send a token that the environment provides
  to a host the change names, before any artifact is checked. Review
  `.npmrc` changes like code, and do not give registry tokens to jobs that
  run untrusted pull requests.
- **Buried provenance history.** Provenance continuity looks back at most
  three times `continuity.baselineSize` versions (15 by default) for an
  attested baseline. An attacker who holds publish rights and releases that
  many versions without provenance leaves no baseline, and continuity reports
  `no-baseline` instead of a downgrade. Searching an unbounded history would
  make every check cost unbounded registry requests. Packages whose
  provenance must never be missing belong under `provenance.mode: "require"`
  or `provenance.requireFor`, which block a version without provenance
  regardless of history.
- **Tarball addresses from the registry.** SafeInstall binds an install to
  the tarball URL and SHA-512 that the configured registry returns and
  checks the digest; it does not restrict which host the URL names, because
  registries serve tarballs from CDNs and other origins. A registry or mirror
  under an attacker's control can make the package manager request any HTTPS
  address from the machine that installs, but cannot change the bytes that
  get installed. The configured registry is trusted for metadata by design;
  use one you control or trust, and restrict outbound network access where
  that matters.

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
- **Shipped:** this repository's trust workflow invokes that verifier by
  full commit SHA, never a branch or tag
  ([#59](https://github.com/Mickdownunder/SafeInstall/pull/59)). Moving
  the pin edits an enforcement-zone file, so every bump deliberately
  requires the owner's interactive `safeinstall trust approve`, the same
  human gate it protects.

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

Last verified: 2026-10-01
