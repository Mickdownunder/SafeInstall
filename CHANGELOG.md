# Changelog

## 0.1.1 - 2026-04-11

### Fixed

- Registry timeout errors raised by `AbortSignal.timeout()` on Node 20+ are now surfaced as a clear "timed out" message instead of an opaque runtime error.
- Package names are percent-encoded via `encodeURIComponent` for all registry URLs, not just the leading scope separator.
- Configuration files now reject unknown top-level keys so typos such as `minimumReleaseAgeHour` fail loudly.
- `allowedPackages` now matches case-insensitively so allowlists work regardless of how the package name is requested.
- The on-disk registry cache is written with 0600 file permissions and 0700 directories so co-located users on a shared host cannot poison cached publish timestamps.
- `scripts/pack-smoke.mjs` resolves the project root from `import.meta.url` so the release smoke test runs on any machine, not just the author's.

### Changed

- A warning is now printed when `registryUrl` points at a non-loopback plaintext HTTP endpoint, since package metadata is unauthenticated in transit.
- Releases published from GitHub Actions now include [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestations.
- Releases are published via npm [trusted publisher](https://docs.npmjs.com/trusted-publishers) OIDC, eliminating long-lived tokens from the publish pipeline.

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
