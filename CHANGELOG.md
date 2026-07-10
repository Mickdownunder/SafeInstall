# Changelog

## Unreleased

### Fixed

- **Guard setup now gives the correct Trust Surface next step.** Fresh projects are directed to create a baseline with `safeinstall trust lock`; projects that already have a baseline are told to review drift with `safeinstall trust status` and intentionally re-baseline guard changes with `safeinstall trust approve`; an idempotent re-run no longer asks for unnecessary approval.

## 0.11.0 - 2026-07-10

### Added

- **`safeinstall init` is now one-command onboarding.** One run takes a project from zero to protected: write the starter policy config, register guard hooks for the agents actually present (`.claude/`, `CLAUDE.md`, `.codex/`, `AGENTS.md`, `.cursor/`, `.cursorrules` — or an explicit `--client claude,codex,cursor`), then lock the Agent Trust Surface over the result, in that order so the baseline covers the hooks just written. Idempotent and fail-closed on re-runs: an existing config is kept (`--force` overwrites; previously init errored), existing guard entries are skipped, and an existing lock is never re-baselined — drift aborts init with the trust findings instead of blessing a tampered surface. New flags: `--client`, `--no-guard`, `--no-lock`, `--mode warn|strict`.

- **Codex is now a first-class guard client.** `safeinstall guard install` non-destructively registers a project-level `PreToolUse`/`Bash` hook in `.codex/hooks.json`, and `safeinstall guard codex` implements Codex's current hook protocol. Raw package-manager installs are rewritten in-place through the SafeInstall CLI with `updatedInput`; unanalysable commands and trust-surface drift are denied. Registry runners fail closed because Codex `PreToolUse` does not currently support an approval (`ask`) decision. Users must review and trust the installed project hook with Codex `/hooks`.

### Security

- **Codex hook controls are part of the Agent Trust Surface.** Both `.codex/hooks.json` and `.codex/config.toml` are enforcement-zone files, so deleting the guard, changing its command, or disabling hooks through project config produces lockdown drift. The Codex guard has real process-level E2E coverage for ordinary installs, the permanent parser bypass corpus, remote scaffolding, and trust-surface tampering.

## 0.10.2 - 2026-07-10

### Security

- **Hardened the agent guard against shell-parser bypasses.** Package-manager and wrapper names are now normalized case-insensitively, leading file-descriptor redirections are analyzed before command classification, wrapper options are parsed conservatively, and ambiguous `env --split-string` forms fail closed. Remote project scaffolding through package runners follows the runner approval path, while path-qualified package-manager invocations are rewritten consistently through SafeInstall.
- **Added a permanent adversarial regression corpus and property-based fuzzing.** Captured bypass classes now run in the normal test suite alongside an independent reference detector, and the standalone harness supports million-command campaigns for deeper parser validation.

### Changed

- Split the guard parser into command analysis, shell normalization, and shared types so security-critical review no longer depends on a single oversized module. The CLI and hook contracts are unchanged.

## 0.10.1 - 2026-07-03

### Fixed

- **Default install no longer pulls sigstore and the MCP SDK (supply-chain footprint).** `sigstore` and `@modelcontextprotocol/sdk` were declared as `optionalDependencies`, which npm installs by default (they are only skipped when installation *fails*). That pulled ~130 packages into a normal `npm install safeinstall-cli` — carrying eval/network/shell/URL capability signals in the transitive tree — and contradicted the "3 runtime dependencies, loads on demand" promise. They are now `peerDependencies` marked optional in `peerDependenciesMeta`, so a default install pulls only the three real runtime dependencies (`npm-package-arg`, `semver`, `yaml`); a fresh install drops from ~130 packages to a handful. The lazy-import paths are unchanged: enabling `provenance.mode` or running `safeinstall mcp` without the package still prints a clear install hint. A release-metadata test now guards against regressing these back into installed dependencies.

## 0.10.0 - 2026-07-02

### Added

- **Agent Trust Surface: self-defending policy.** The guard stops raw installs, but a prompt-injected agent can instead rewrite the rules — weaken `safeinstall.config.json`, delete the hook from `.cursor/hooks.json`, plant invisible-Unicode instructions in `AGENTS.md`, or register a malicious MCP server. Those files program the next agent session; in the agent era they are the persistence mechanism. `safeinstall trust lock` records a hash baseline of that surface, and SafeInstall reconciles the real state against it before guard decisions and before every install/check.

  Three zones with proportionate responses: the **enforcement** zone (SafeInstall config, agent hook files, `.safeinstall/`) locks down every agent command on drift; the **instruction** zone (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/**`, `.github/copilot-instructions.md`) always blocks hidden Unicode but only warns on content drift by default, because Claude Code writes to `CLAUDE.md` itself; the **tool** zone (`.mcp.json`, `.cursor/mcp.json`, MCP blocks in `.claude/settings.json`) denies installs and runners on drift and flags unpinned MCP servers (the rug-pull vector where `npx evil-mcp` fetches new code without any config change).

  Defense that survives adversarial review:
  - **Reconciliation, not just interception.** Every `safeinstall` install/check reconciles, not only the guard. A bypass the guard never sees — a `node -e` install, or deleting the hook to silence the guard — still leaves a hash drift caught before the next run.
  - **Hash-chained ledger with an out-of-workspace mirror** (`.safeinstall/ledger.jsonl` + a head mirror under `~/.safeinstall/`). Rewriting the in-repo lock and ledger to hide tampering still mismatches the mirror.
  - **Human-gated approval.** `safeinstall trust approve` reads confirmation from the controlling terminal (`/dev/tty`), never stdin, and refuses CI and known agent-hook contexts, so an agent cannot approve its own tampering.
  - **CI backstop.** The GitHub Action gains a `verify-trust` input: with the committed `.safeinstall/` baseline, `safeinstall trust status --require-lock` re-verifies the surface on every pull request, so a compromised local machine cannot slip drift past review.

  New commands: `safeinstall trust lock [--mode warn|strict]`, `safeinstall trust status [--require-lock]`, `safeinstall trust approve`, `safeinstall trust unlock`. Honest scope, documented in the README: the durable guarantee is the committed lock re-verified by CI on a separate machine; locally it is tamper-evident against mistakes and non-targeted tampering, not tamper-proof against a scheme-aware agent in your own account; it watches files, not intent.

- The guard also denies shell writes that target a trust-surface file (`echo … > safeinstall.config.json`, `sed -i … AGENTS.md`, `tee`, `rm`), interception to complement reconciliation.

  Hardening from an adversarial review:
  - The ledger-bound baseline hash now covers the enforcement `mode` and schema version, not just the file/MCP list — so editing the committed lock to downgrade `strict`→`warn` (softening instruction-drift enforcement) is detected as `trust-lock-forged`.
  - `trust status` is strictly read-only: it no longer appends to the ledger on drift, so it does not dirty the working tree in CI or grow the ledger unbounded.
  - Ledger appends are serialized with an exclusive lock file, so concurrent runs (parallel agent commands, CI matrices) cannot corrupt the hash chain into a false lockdown.
  - The trust precheck in the install/check flows fails closed as a clean policy block on a read error instead of crashing with an unhandled error.
  - Hidden-Unicode detection extended to the implicit bidi mark `U+061C`, soft hyphen, line/paragraph separators, deprecated formatting controls, and interlinear annotation anchors (Trojan-Source class).
  - Unpinned-MCP detection now treats semver ranges (`^1`, `~1`, `1.x`, `*`, `>=1`), not only tags, as floating, and resolves the spec through `-p/--package` and value-taking runner flags. Unpinned servers are surfaced on every reconciliation (warning in warn mode, block in strict mode), not only at lock time.
  - New `safeinstall trust unlock` removes the lock, ledger, and head mirror — including clearing a stale mirror that would otherwise keep reporting `lock-removed`.
  - The local head mirror is documented as a best-effort signal against naive/accidental history rewrites; a missing mirror self-heals from the verified head rather than nagging on every fresh clone. The durable anchor is CI re-verification of the committed lock.

- **`safeinstall trust lock --ci github`** scaffolds the CI re-verification workflow (`.github/workflows/safeinstall-trust.yml`) that runs `safeinstall trust status --require-lock` on every pull request, so the committed baseline is re-checked on a machine the agent does not control. This closes the gap between "the guarantee lives in CI" and "did the user actually wire up CI".

  Built to avoid the release-sequencing and self-protection traps:
  - The workflow **pins the CLI to an exact version** (never `@latest`), so it can never resolve to a CLI that predates the `trust` command and silently pass — the anchor cannot become a no-op.
  - It is **trust-only** (`trust status --require-lock`, not the full dependency check) with `permissions: contents: read`, so it does not fail on a repo without a `package.json` and holds no write token.
  - The workflow file is **part of the tracked enforcement surface**: flipping it off or deleting it is detected as drift, and the guard denies raw shell writes to it. It is scaffolded into the baseline so it does not itself register as drift.
  - Honest scope, documented in the README: for the check to enforce you must make it a required status check and require review of `.safeinstall/`/`.github/workflows/` (CODEOWNERS) — the automatic check catches inconsistent tampering; a fully consistent baseline rewrite needs human review. An existing workflow file is never overwritten.

## 0.9.0 - 2026-07-02

### Added

- **Agent guard: enforced install gating for AI coding agents.** The MCP tool is advisory — an agent *can* call it. The new guard is enforcement: `safeinstall guard install` registers SafeInstall as a pre-shell-execution hook for **Claude Code** (`PreToolUse`/`Bash` in `.claude/settings.json`) and **Cursor** (`beforeShellExecution` in `.cursor/hooks.json`, with `failClosed: true`), so every shell command an agent runs is intercepted before execution.

  The guard (`safeinstall guard <claude|cursor>`) never evaluates policy itself. It detects package installs — including aliases (`npm i`, `bun a`, `npm ci`), env-var prefixes, wrappers like `sudo`/`env`, chained commands, pipes, and redirections — and **denies them with the exact rewritten command routed through the SafeInstall CLI** (`cd app && npm i axios && npm test` → "run `cd app && safeinstall npm install axios && npm test` instead"). Routing through the CLI matters more than a plain allow/deny: a vetted-but-raw `npm install` would still execute lifecycle scripts; through SafeInstall it gets the full policy evaluation *and* runs with scripts disabled. Blocking becomes steering: a well-behaved agent self-corrects in one step. The guard needs no network access and answers in milliseconds.

  Fail-closed on the security-relevant path: install commands that cannot be analyzed with confidence (command substitution, variable expansion in arguments, installs hidden in nested shells, yarn) are denied with an explanation. Non-install commands and unparseable hook events produce no opinion, so the guard never bricks the agent's shell.

  Package runners (`npx`, `pnpm dlx`, `bunx`, `yarn dlx`, `npm exec`) get a third verdict: **ask**. They download and execute registry code without install-time checks, so the user must approve — except when the runner would resolve a locally installed binary (nearest `node_modules/.bin`, mirroring the runners' own resolution), in which case nothing is downloaded and the command is allowed. `pnpm exec` is local-only and always allowed. Windows launcher extensions (`npm.cmd`) are recognized.

  Hook config merging is conservative and idempotent: existing hooks are preserved, a malformed settings file is left untouched and reported, and re-running detects the existing registration.

- **Install-command aliases.** `safeinstall npm i axios`, `pnpm i`, `bun a zod`, `npm clean-install` and the other documented package-manager aliases now work; previously only the canonical `install`/`add`/`ci` spellings were accepted. `--dir`, `--workspace`, and `--lockfile-dir` are also recognized as value-taking flags, so their values are no longer mistaken for subcommands or package specs.

- **`--config <path>` global flag.** All commands accept an explicit config file path (also as `--config=path`), skipping upward discovery. An explicit path that cannot be read is a hard error (exit 1), never a silent fallback to built-in defaults — CI cannot accidentally run with a weaker policy than intended.

### Fixed

- **Policy bypass via `--` (security).** `safeinstall npm install -- evil-pkg` previously evaluated *nothing* (spec extraction stopped at `--`) while npm still installed the package, because package managers treat post-`--` tokens as positional package specs for install commands. Tokens after `--` are now extracted and evaluated like any other spec.
- **Guard fail-closed net for unknown flags.** A package-manager command whose subcommand position cannot be resolved but which contains an install alias elsewhere (the signature of an unknown value-taking flag) is denied by the guard instead of allowed — unless the subcommand is a known non-install command like `run`, which owns its arguments.
- **GitHub Action `config-path` input now works.** The action documented a `config-path` input but never passed it to the CLI (and the CLI had no flag to receive it). The input is now forwarded as `--config` in both `check` and `install` modes.
- **Restored `scripts/refresh-typo-squat-targets.mjs`.** The script referenced from `src/typo-squat-targets.ts` was missing from the repository. It now fetches the top-N packages from `npm-high-impact` (pinned version, parsed as data only — no remote code execution) and merges them into the shipped target list without dropping curated entries.
- **`SECURITY.md` supported-versions table** updated from the stale 0.2.x window to 0.8.x.

## 0.8.0 - 2026-06-23

### Added

- **MCP server for AI coding agents.** A new `safeinstall mcp` subcommand starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio that exposes a single `check_package` tool. AI coding agents (Claude Code, Claude Desktop, Cursor, Windsurf, Cline) can call it *before* suggesting or running any install, so the policy engine reaches every agent user without anyone typing `safeinstall`.

  The tool runs the **same engine as the CLI** — release age, install scripts, untrusted sources, typo-squat, Sigstore provenance, and provenance continuity — via `evaluateRequestedPackages`, and returns a machine-readable verdict:

  ```json
  {
    "verdict": "allow" | "block",
    "name": "...",
    "version": "...resolved...",
    "reasons": [ { "code": "...", "message": "...", "suggestion": "..." } ],
    "warnings": ["..."],
    "infos": ["..."],
    "sourceRepository": "owner/repo" | null,
    "ageHours": 0
  }
  ```

  - **Config resolution matches the CLI.** A project `safeinstall.config.json` is respected exactly. When none is found, the server uses a **recommended secure preset** — built-in defaults with `typoSquat` and `continuity` promoted to `"block"` — because the agent use case wants maximum signal.
  - **Lightweight by design.** `@modelcontextprotocol/sdk` is an **optional dependency**, dynamically imported only when `safeinstall mcp` runs (same pattern as the optional `sigstore` package). CLI-only users never install it; if it is missing the command prints an install hint and exits non-zero.
  - **Onboarding artifacts.** New [`mcp/README.md`](mcp/README.md) (copy-paste MCP client config for Claude Code/Desktop and Cursor) and [`mcp/agent-rule.md`](mcp/agent-rule.md) (a ready-to-paste rule that instructs the agent to call `check_package` before every install). MCP tools are advisory — the server plus the rule snippet is the "install once, protected forever" combination.

- **`sourceRepository` on package evaluations.** The engine now surfaces the `owner/repo` a version was published from (from verified provenance or the continuity baseline) on `PackageEvaluation`, so JSON consumers and the MCP verdict can show package origin.

## 0.7.0 - 2026-06-23

### Added

- **Provenance continuity.** A new opt-in check that learns a per-package trust baseline from the provenance identity of recent versions and blocks deviations at install time — the structural gap npm itself does not close. npm verifies provenance at publish time but does not enforce continuity *between* versions, so a compromised account can publish a version with no attestation (from a stolen token) or from a different repository without raising any alarm. This is the dominant 2026 attack pattern (Mastra and the dormant-account republishes).

  Two block-worthy deviations:
  - **`provenance-downgrade`** — recent versions were attested, this one is not. The fingerprint of an account-compromise publish from a personal token.
  - **`identity-discontinuity`** — this version is attested from a different source repository than the established baseline.

  Because the baseline is learned per package, packages that never adopted provenance simply have no baseline and the check stays silent — no false positives, no global "require provenance" sledgehammer. It reads npm's published attestation metadata, so it works **without** the optional sigstore package. Opt in via a new `continuity` config block (defaults to `"off"`).

  ```json
  {
    "continuity": {
      "mode": "warn",
      "baselineSize": 5
    }
  }
  ```

  Honest limit: continuity does not catch an attack delivered through a legitimately-compromised CI workflow that still produces valid provenance from the real repository (the Shai-Hulud worm class) — there is no identity discontinuity to detect there.

- The attack replay (`pnpm replay mastra`) now demonstrates the `provenance-downgrade` verdict alongside the release-age and transitive checks, showing the catch that npm defaults structurally cannot make.

## 0.6.0 - 2026-06-16

### Changed

- **`sigstore` is now an optional dependency.** Users who do not enable `provenance.mode` no longer install sigstore and its ~160 transitive packages. This reduces installed package count from ~165 to ~5, dramatically improves install speed, and eliminates all six supply-chain warnings that Socket/Snyk flagged on the sigstore dependency subtree (network access, filesystem access, URL strings, unmaintained transitive, AI code anomaly, new author).

  When `provenance.mode` is set to `"warn"` or `"require"` and sigstore is not installed, SafeInstall surfaces a clear error: *"Sigstore provenance verification requires the optional 'sigstore' package. Install it with: npm install sigstore"*.

  For users who do enable provenance verification, the behavior is identical — sigstore is still lazy-loaded at verification time, not at startup.

## 0.5.0 - 2026-05-29

### Added

- **Transitive dependency evaluation.** SafeInstall can now evaluate the full lockfile dependency tree, not just direct dependencies — closing the biggest coverage gap, since most real supply-chain attacks reach a project through a transitive dependency. Opt in via a new `transitive` config block (defaults to `"off"`, fully backward compatible).

  Two checks run transitively, both read directly from the lockfile with **zero extra registry calls**:
  - **`install-script`** — flags transitive packages that declare a lifecycle script (the `ua-parser-js` attack class). npm records this in the lockfile; pnpm lockfiles do not, so this check is npm-only for now.
  - **`untrusted-source`** — flags transitive packages resolving from git, url, or tarball sources. Works for npm and pnpm.

  Release-age, typo-squat, and provenance are deliberately not run transitively to avoid noise and per-package registry round-trips. Transitive evaluation applies to `safeinstall check` and project installs (`pnpm install`, `npm ci`). Findings are aggregated into one block reason per check type with a capped inline list so a large tree does not flood the output.

### Breaking changes

- **Removed the `ciMode` config field.** This field was declared, documented, validated, and configurable — but nothing in the codebase ever read it. Existing config files that include `ciMode` will now fail strict key validation with a clear error message. Remove the field from your `safeinstall.config.json` to fix. Closes #2.

  ```json
  {
    "transitive": {
      "mode": "warn",
      "checks": ["install-script", "untrusted-source"]
    }
  }
  ```

## 0.4.0 - 2026-05-29

### Breaking changes

- **`allowedPackages` no longer bypasses every policy check.** Previously, listing a package in `allowedPackages` skipped *all* checks, including the ones that detect active supply-chain attacks. As of 0.4.0, allowlisting a package skips only the checks a user legitimately wants to bypass for a known-good dependency:
  - **Skipped when allowlisted:** release-age, install-script-present, typo-squat detection.
  - **Still enforced when allowlisted:** untrusted-source, trust-downgrade (registry → git/url/tarball), newly-introduced lifecycle scripts on an update, and all provenance checks (including publisher-mismatch).

  This closes a real gap: an allowlisted package that was later compromised — for example by adding a `postinstall` script it never had, or by being republished from a different source repository — is now still blocked. If you relied on `allowedPackages` to also permit a non-registry source, move that intent to `allowedSources`, which is the correct field for it.

## 0.3.0 - 2026-04-11

### Added

- **GitHub Action.** SafeInstall now ships as a reusable GitHub Action (`Mickdownunder/SafeInstall@v1`). Teams can run policy checks on every pull request with five lines of workflow YAML, no CLI installation required. Supports `check` mode (audit direct dependencies) and `install` mode (run the package manager through SafeInstall). Blocked dependencies appear in the GitHub Actions job summary with the exact block reason. Outputs `decision`, `summary`, `exit-code`, and `json` for downstream workflow steps.

### Upgraded

- All dependencies updated to latest patch/minor versions. vitest 3 → 4, @types/node 24 → 25.
- All six previously reported security advisories resolved (vite, postcss, ip-address, brace-expansion) via dependency upgrades and pnpm overrides.
- CI and release workflows updated from Node 20 (EOL) to Node 22 (Active LTS).
- Community health files added: Code of Conduct (Contributor Covenant v2.1), Contributing guide, and Security policy with private vulnerability reporting.

## 0.2.1 - 2026-04-11

A follow-up to 0.2.0 that fixes two real-world UX issues found during manual verification of the published package, and rewrites the README opener to lead with the maintainer-compromise attack-catch demo.

### Fixed

- **Verified-OK provenance messages no longer print with a `Warning:` prefix.** In 0.2.0, a successful provenance verification in warn mode was routed through the same channel as policy concerns, producing confusing output like `Warning: ... provenance verified from ...`. A new `infos` field is now surfaced separately on `PackageEvaluation` and `CliResult`, and rendered with an `Info:` prefix in human mode. Missing attestations remain real warnings; only verified successes moved to infos. The change is additive (JSON consumers see an additional empty `infos` array) and non-breaking.
- **Typo-squat detection now fires even when the registry cannot resolve the requested name.** Before 0.2.1, typing a suspicious package name that did not exist on npm (e.g. `raect` for `react`) produced a generic `fetch failed` runtime error instead of the helpful `Blocked: suspected typo-squat of "react"` message. Registry resolution is now wrapped in a try/catch, and the policy engine still runs typo-squat detection against the requested name. If nothing else catches it, a new `package-resolution-failed` block code surfaces the underlying error with the package name.

### Changed

- README opening section now leads with the trusted-publisher attack-catch demo and a dogfood example where SafeInstall verifies its own Sigstore attestation.

## 0.2.0 - 2026-04-11

Two new policy checks covering opposite ends of the supply-chain attack spectrum: typo-squat detection for the most common attack (a one-letter mistake turning into a malware install) and Sigstore provenance verification for the most sophisticated (a tampered tarball with a valid-looking signature from the wrong source).

Both features default to `"off"` so upgrading from 0.1.1 is fully non-breaking. Opt in via `typoSquat.mode` and `provenance.mode` in `safeinstall.config.json`.

### Added

- **Typo-squat detection.** New `typoSquat` config block. Uses Damerau-Levenshtein distance with an early cutoff to flag install requests whose package name is a close-but-not-exact match to a popular package (e.g. `lodsh` for `lodash`, `raect` for `react`, `axois` for `axios`). Supports `"warn"` and `"block"` modes, a configurable minimum name length, and a per-project ignore list for known legitimate lookalikes. The popular-package list is curated and embedded at build time — no runtime network fetch.
- **Sigstore provenance verification.** New `provenance` config block. Fetches the attestation bundle from the npm registry's `/-/npm/v1/attestations/` endpoint, verifies the Sigstore bundle cryptographically via the official `sigstore` package (signatures, Rekor transparency log, public trust root), and extracts the source repository and commit ref from the SLSA v1 provenance statement. Supports `"warn"` and `"require"` modes and per-package `requireFor` overrides.
- **Trusted publisher pinning.** Inside the provenance config, `trustedPublishers` maps a package name pattern (exact name or glob) to an expected `owner/repo` slug. A valid provenance attestation from an unexpected repository is **always** blocked, regardless of mode — this is the defense against maintainer-account compromise attacks where an attacker republishes a legitimate-looking package from a fork they control.
- **Offline behavior control.** `provenance.offlineBehavior` is either `"fail-closed"` (default, safer) or `"allow-cached"` (more available). Cached attestation bundles share the existing disk cache hardening from 0.1.1.

### Changed

- The config validator now recognizes and strictly validates the two new top-level keys (`typoSquat`, `provenance`) and their nested shapes.
- `safeinstall.config.example.json` now includes both new blocks with sensible defaults.

### Security

- Trusted-publisher-mismatch blocks cannot be silenced by dropping to `"warn"` mode. This is intentional: a valid Sigstore signature from the wrong source repository is exactly what a maintainer-compromise attack looks like.

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
