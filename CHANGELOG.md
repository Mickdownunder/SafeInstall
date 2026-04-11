# Changelog

## 0.1.0 - 2026-03-31

First public release. Open source under MIT license.

### Added

- Local CLI wrapper for `npm`, `pnpm`, and `bun`
- Policy enforcement for release age, lifecycle scripts, untrusted sources, and trust downgrades
- Lockfile-aware project installs for `pnpm install`, `npm install`, and `npm ci`
- JSON output for CI and automation
- `safeinstall init` starter config generation
- Monorepo-aware package and lockfile discovery for npm and pnpm
- End-to-end CLI regression coverage and local-repo QA against real projects
- Configurable registry URL for private mirrors (Verdaccio, Artifactory)
- On-disk cache for exact-version registry metadata and publish timestamps
- Graceful SIGINT/SIGTERM shutdown with proper exit codes
- `--help` / `-h` and `--version` / `-v` flags

### Hardened

- Fail-closed behavior for stale, missing, or ambiguous lockfiles
- Explicit blocking for ambiguous workspace-targeting flags
- Package-manager mismatch blocking when `package.json` declares a different manager
- Local workspace and file-based project references handled as local sources instead of external supply-chain inputs
- Abbreviated registry metadata for faster fetches
- Concurrency-limited registry requests

### Notes

- Package name: `safeinstall-cli` (npm) — command: `safeinstall`
- `bun install` remains manifest-based for project installs in this release
- Policy checks apply to direct dependencies only in this release
