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

- Artifact-bound installation supports npm and pnpm. Bun installs fail closed until an artifact-binding adapter exists. yarn is not supported, and the agent guard denies yarn installs.
- Install binding requires canonical SHA-512 metadata and matching lockfile entries. Global installs, explicit non-registry additions, conflicting registries, script-enabling flags, and unknown options block.
- Explicit additions prepare a lockfile before frozen installation. Failed checks can leave manifest/lockfile changes for inspection. npm's frozen phase uses `ci`, replacing `node_modules`; shared-lockfile workspaces review all recorded importers.
- Transitive dependency policy (opt-in via `transitive.mode`) runs only the `install-script` and `untrusted-source` checks. Transitive install-script detection works for npm lockfiles only (pnpm lockfiles do not record script presence). Release-age, typo-squat, provenance, and continuity checks apply to direct dependencies only.
- No selective lifecycle-script execution. `allowedScripts` affects only the policy verdict; installation always disables lifecycle scripts and pnpmfile hooks, regardless of legacy `ignoreScripts` configuration.
- Provenance verification supports GitHub Actions trusted publishers on the public Sigstore trust root only.
- No CVE scanning and no package content or malware analysis — SafeInstall is a policy gate over registry metadata and lockfiles.

Last verified: 2026-10-01
