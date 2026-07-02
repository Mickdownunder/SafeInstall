# Security Policy

## Supported versions

| Version | Supported |
|:---|:---|
| 0.10.x | Yes |
| < 0.10 | No (upgrade to the latest 0.10.x release) |

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

## Provenance

SafeInstall is published to npm with [Sigstore provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions trusted publishing. Every release is cryptographically traceable to a specific commit and workflow run.
