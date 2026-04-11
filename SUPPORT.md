# Support

SafeInstall is a solo-maintained open-source project. Issues and PRs are welcome — the author reviews and merges at own discretion.

SafeInstall is designed to fail closed when project metadata is stale, inconsistent, or ambiguous.

## Before Reporting a Problem

Run these commands in the affected project:

```bash
safeinstall --json npm install
safeinstall --json npm ci
safeinstall --json pnpm install
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
- SafeInstall supports lockfile-aware project installs for npm and pnpm
- SafeInstall intentionally blocks ambiguous workspace-targeting commands
- SafeInstall intentionally blocks when lockfile state is incomplete or conflicting

## Known Limits In 0.1.0

- No transitive dependency policy
- No bun lockfile-aware project install analysis
- No selective lifecycle-script execution even when scripts are allowlisted
