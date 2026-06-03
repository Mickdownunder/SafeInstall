# SafeInstall in action

This directory contains a reproducible demonstration of every policy check SafeInstall enforces. There is **no malware here** — each scenario uses a real, legitimate package (or controlled local config) to demonstrate the *mechanism* that would catch a real attack.

Run it yourself:

```bash
bash demo/run.sh
```

Requirements: Node.js >= 20, npm, network access. The script installs `safeinstall-cli` into a temporary directory, runs six scenarios, and cleans up after itself. Nothing is installed into your project.

---

## The six scenarios

### 1. Release too new

A freshly published version is the window where most malicious packages are caught by the community before they're noticed. SafeInstall blocks releases younger than the configured minimum.

```
$ safeinstall npm install axios
Install blocked.
- axios@<version>
  Blocked: release too new (axios@<version> is N hours old; minimum is 999999 hours).
  Suggestion: Retry later or lower minimumReleaseAgeHours if this package is intentionally urgent.
```

### 2. Lifecycle script present

Install scripts run arbitrary code at install time. SafeInstall blocks packages that declare `preinstall`, `install`, or `postinstall` unless you allow them per package. `esbuild` legitimately ships a `postinstall` — here it's blocked to demonstrate the check.

```
$ safeinstall npm install esbuild
Install blocked.
- esbuild@<version>
  Blocked: install script present (esbuild@<version> has postinstall).
  Suggestion: Allow this package explicitly in allowedScripts if you trust its install hooks.
```

### 3. Untrusted source

Git, URL, and tarball installs bypass the registry's publishing controls. They're blocked unless explicitly added to `allowedSources`.

```
$ safeinstall npm install github:axios/axios
Install blocked.
- github:axios/axios
  Blocked: untrusted source (git).
  Suggestion: Use a registry release or allow this source intentionally.
```

### 4. Typo-squat

A one-character variation on a popular package name is the most common AI-suggestion failure mode. `raect` is one transposition away from `react`.

```
$ safeinstall pnpm add raect
Install blocked.
- raect
  Blocked: Suspected typo-squat: "raect" is 1 edit(s) away from popular package "react".
  Suggestion: Verify you meant to install "react". If this package is intentional, add "raect" to typoSquat.ignore.
```

### 5. Publisher mismatch — the maintainer-compromise defense

This is the scenario no other install-time tool catches. A compromised npm maintainer can publish a malicious version that carries a **valid** Sigstore signature — signed by a workflow the attacker controls in a fork. SafeInstall verifies the signature *and* checks that the source repository matches the publisher you pinned. Here `safeinstall-cli` is deliberately pinned to the wrong publisher to simulate compromise:

```
$ safeinstall check
Check blocked.
- safeinstall-cli@<version>
  Blocked: publisher mismatch for safeinstall-cli (expected evil-org/SafeInstall, got Mickdownunder/SafeInstall).
  Suggestion: Verify the package source. Update provenance.trustedPublishers only if the change is intentional.
```

The attestation is cryptographically valid. It's blocked anyway, because a valid signature from the wrong repository is exactly what a maintainer-account compromise looks like.

### 6. Allowlist does not disable attack-signal checks

As of 0.4.0, allowlisting a package skips only release-age, install-script, and typo-squat checks. Active attack signals — untrusted source, trust downgrades, newly-introduced scripts, and provenance mismatches — still apply. Here `axios` is allowlisted, but a git source is still blocked:

```
$ safeinstall npm install github:axios/axios
Install blocked.
- github:axios/axios
  Blocked: untrusted source (git).
  Suggestion: Use a registry release or allow this source intentionally.
```

---

## What this demonstrates

| Scenario | Risk class | Real-world example |
|:---|:---|:---|
| 1 | Freshly-published malware | Most npm supply-chain publishes are caught within 72h |
| 2 | Install-time code execution | `event-stream`, countless postinstall miners |
| 3 | Source-control bypass | Installing from an attacker-controlled fork |
| 4 | Typo-squatting | `crossenv`, `electron-native-notify`, etc. |
| 5 | Maintainer-account compromise | `ua-parser-js`, `eslint-scope` |
| 6 | Trust erosion of a known-good package | A trusted dep updated to add a malicious script |

SafeInstall is a policy gate, not a malware scanner. It does not read package contents or maintain a CVE database. It enforces that the *circumstances* of an install — age, scripts, source, name, provenance — match a policy you control, before the package manager runs.
