# Support

SafeInstall is a solo-maintained open-source project. Issues and PRs are welcome — the author reviews and merges at own discretion.

SafeInstall is designed to fail closed when project metadata is stale, inconsistent, or ambiguous.

## Before Reporting a Problem

Run these commands in the affected project:

```bash
safeinstall --json npm install
safeinstall --json npm ci
safeinstall --json pnpm install
safeinstall --json bun install
safeinstall check --json
```

Use the command that matches the package manager and workflow you expected to use.

## Include This Information

- SafeInstall version (`safeinstall --version`)
- Node.js version
- Package manager and version
- Exact SafeInstall command
- Exact JSON output
- Relevant `packageManager` field from `package.json`
- Whether the project uses `package-lock.json`, `npm-shrinkwrap.json`, or `pnpm-lock.yaml`
- Redacted `safeinstall.config.json` if one exists

## Expected Support Boundary

- SafeInstall supports direct dependency policy checks
- SafeInstall supports opt-in transitive lockfile checks (`transitive.mode`)
- SafeInstall supports lockfile-aware project installs for npm and pnpm
- SafeInstall intentionally blocks ambiguous workspace-targeting commands
- SafeInstall intentionally blocks when lockfile state is incomplete or conflicting

## Known Limits

- Supported package managers are npm, pnpm, and bun. yarn is not supported: yarn installs cannot be policy-checked, and the agent guard denies them.
- No bun lockfile-aware project install analysis. `safeinstall bun install` uses manifest-based analysis of `package.json`; lockfile-aware project installs exist for npm and pnpm only.
- Transitive dependency policy (opt-in via `transitive.mode`) runs only the `install-script` and `untrusted-source` checks. Transitive install-script detection works for npm lockfiles only (pnpm lockfiles do not record script presence). Release-age, typo-squat, provenance, and continuity checks apply to direct dependencies only.
- No selective lifecycle-script execution. `allowedScripts` affects only the policy verdict; installs are still forwarded with `--ignore-scripts` while `packageManagerDefaults.<manager>.ignoreScripts` is true (the default).
- Provenance verification supports GitHub Actions trusted publishers on the public Sigstore trust root only.
- No CVE scanning and no package content or malware analysis — SafeInstall is a policy gate over registry metadata and lockfiles.

Last verified: 2026-07-09
