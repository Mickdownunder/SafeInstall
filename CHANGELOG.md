# Changelog

## 0.14.0 - 2026-07-13

### Added

- **Opt-in `provenance.toolingUnavailable: "fail-closed"` closes the tool-removal known-gap.** When the `sigstore` verifier is absent, provenance can be evaluated for no package; the default (`"warn"`) degrades to a loud per-package warning so a fresh environment stays bootstrappable. The new per-project knob lets a project that has already installed `sigstore` treat a *missing* verifier as suspicious and **block** every install until it is reinstalled — closing the residual where an attacker with `node_modules` write access could delete `sigstore` to slip provenance past the check. The `sigstore` bootstrap install itself (`requested.name === "sigstore"`) stays exempt, so `fail-closed` can never deadlock. New block code `attestation-tooling-unavailable`; the Attack Lab records the opt-in defence (`provenance-tooling-fail-closed`) alongside the still-honest default-mode limit (`provenance-tooling-removed`).

### Changed

- **Internal hardening — no runtime behaviour change.** `trust-surface.ts` (870 LoC) was split into four focused modules (hidden-Unicode detection, MCP-server parsing, trust-surface reconciliation, and the data model), each under the 500-LoC line. ESLint + typescript-eslint were added with type-aware rules (`no-explicit-any`, `no-floating-promises`, `switch-exhaustiveness-check`), wired into `pnpm lint`, the `release:check` gate, and a dedicated CI job; the linter found and fixed 14 real issues, including two non-exhaustive switches. TypeScript was hardened with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`: every optional field and every array/record index access is now honest, fixed with real guards, `for...of`, and documented invariants — never a `!` assertion.

## 0.13.1 - 2026-07-12

### Fixed

- **Clearer guard message for a package-manager word inside shell substitution.** The block now explains the non-install case — a package-manager word used only as an argument (a workflow name, a read-only query) — and points to splitting that part into a separate command, instead of the misleading "rewrite the install" text. The parser is unchanged and still fail-closed; only the guidance improves (issue #56, finding 1).

- **Provenance no longer deadlocks the install that brings its own verifier (issue #56).** Verification collapsed two different failures into one fail-closed `invalid` verdict: a bundle that loads and fails to verify (a package-specific attack signal) and the `sigstore` tool being absent entirely (an environment state — provenance can be evaluated for no package). The second blocked the bootstrap install that installs `sigstore` itself, so a fresh checkout with provenance active could not install its own dependencies (found live during the 0.13.0 release). A distinct `tooling-unavailable` status now degrades the tool-absent case to a loud per-package warning (`provenance NOT verified — sigstore not installed`) while a genuinely invalid bundle still blocks fail-closed, unchanged. The residual — an attacker deleting `sigstore` to downgrade enforcement — is recorded as a first-class Attack Lab `known-gap` (`provenance-tooling-removed`), not silently swallowed.

## 0.13.0 - 2026-07-12

### Added

- **Projects can pin the CLI version their protections assume.** A new optional config field `minimumCliVersion` (exact semver, e.g. `"0.12.0"`) declares the lowest safeinstall-cli version whose guard behavior the project relies on. When an older CLI runs, it warns loudly — naming the running version, the required version, and the update command — in the guard hook (agent and user messages plus stderr), in `install`/`check` results, and as an info line in `trust status`. The comparison is fully offline (no network in the guard hotpath) and deliberately a warning, never a hard failure: a hard failure would break every agent session after each release until the global CLI is updated, recreating the block-fatigue #33 removed. An invalid value (non-semver, or a range) fails config parsing closed like every other config error. Note the bootstrap edge: CLIs that predate this field reject unknown config keys, so setting it makes them refuse the whole config (fail-closed) instead of warning.

- **Attack Lab: a machine-readable, eval-system-first catalogue of attacks against SafeInstall (`attack-lab/`, issue #41 stage 4).** Every case is a validated JSON manifest carrying its reproducible starting state, attacker prerequisites, the vulnerable control version, the expected SafeInstall layer, a machine-readable expected verdict, a named regression test in the normal suite, and disclosure status. The eval turns each case's declared defense into a status: `defended`→`ok`, `documented-limit`→`known-gap`, `unpatched`→`regression`; an unpatched bypass marked `public` is a `discipline-error`, so exploit detail cannot be committed public before a release + advisory. `node attack-lab/run.mjs` (also `pnpm attack-lab`) prints machine-readable `RESULT`/`SUMMARY` lines and exits non-zero on any regression or discipline error; `tests/attack-lab.test.ts` validates the whole catalogue, proves every referenced regression-test file exists, and **live-executes** the shipped control for representative cases (the guard parser still denies `sudo -u root npm install`; the human gate still refuses a `CODEX_SHELL` context). Seed content: the two real 2026-07-11 incidents (the Codex `CODEX_SHELL` approve-gate gap, and approval-fatigue-as-a-primitive), representatives of the guard-parser bypass corpus, and the decision-record / workflow-anchor defenses shipped this cycle (D3 registry redirect, M4 unrecorded rider lockfile, post-record tamper, K1 neutered-same-name check). The lab deliberately carries the two honest limits — approval fatigue and the K2 consistent-rewrite residual — as first-class `known-gap` cases, so a future change cannot silently relabel them "defended" without a real fix.

- **Dependency Decision Records, L0 foundations: `safeinstall decisions verify` (RFC-001 §5–§7).** The record layer of the provability chapter exists: canonical RFC 8785 (JCS) encoding with an integer-only producer profile — the record file IS the canonical bytes, digest = sha256 over them (D1); git blob-OID bindings computed as-staged with a paired independent sha256, so working-tree materialization games (autocrlf, smudge/clean, uncommitted attributes) cannot move what a binding means (D2); per-lockfile-path hash chains appended under the same owned-token file lock the trust ledger uses (extracted, not duplicated); and a committed-state verifier: `safeinstall decisions verify --base <ref>` checks that every lockfile changed in a base..head delta is covered by a schema-valid, digest-named, linkage-continuous chain anchored at both committed ends — an unrecorded second workspace lockfile (§13 M4), a post-record tamper, a fabricated before-state, and a renamed or edited record file are each a deterministic failure, and a non-default `registryUrl` is a hard `registry-not-default` finding unless explicitly allowlisted verifier-side (D3). Records are explicitly untrusted audit evidence (actor-tagged L0): the verifier checks integrity and completeness; it never trusts a recorded verdict. Emission from the install flow and CI re-authorization (`decisions authorize`) follow in the next changes.

- **Installs now leave an L0 decision record (RFC-001 §5, D4).** Every policy-evaluated install decision in a git repository — allow or block — writes an actor-tagged, explicitly untrusted record into `.safeinstall/decisions/`, chained per lockfile path and bound (git blob OID + sha256, as-staged) to the manifest, lockfile, policy config, and trust lock before and after the package manager ran. Per-package observations carry the resolved version, the publish time and **which source answered it** (`publishTimeSource`), and the D4 guarantees: `file:`/`directory:`/`link:` sources always produce an explicit `non-registry-source` finding with `notEvaluable` reasons — a record with non-registry sources can never read "clean". `installed` records whether the manager exited 0 (honesty metadata, §4 — never a gate input). Emission never blocks an install: without a git repository (D2 requires one) the result says `Decision record not written: …` instead of staying silent. Checks are opt-in via `safeinstall check --record` (binding before == after): checks run constantly on agent hotpaths, and unconditional records would dirty every worktree and train users to gitignore the decisions directory. The L0→verify slice is closed end to end: an e2e test drives a real CLI install through a stub package manager in a real repository and the committed record passes `decisions verify` against the base..head delta.

- **`safeinstall decisions authorize` — the L1 re-authorization gate (RFC-001 §6, §10).** Authorization answers "is this dependency state acceptable *now*, observed independently?" and re-derives everything: the committed-state verification must pass first (chain integrity plus the D3 registry trust root); the working tree must BE the head state for every file evaluated (`decisions-dirty-state` refuses local divergence, so "authorized" can never describe bytes that are not what merges); then a fresh policy evaluation of the head's direct dependencies and transitive lockfile checks runs with registry metadata fetched at authorization time. Recorded L0 verdicts are ignored by design — divergence (a package aged past the release window) is legitimate, and only the fresh result gates. `--output <file>` writes the authorization artifact as canonical JCS bytes (evaluatedAt, base/head commits, verified lockfile blob OIDs, the policy blob it ran under, verdict + reasons) — the exact bytes a future L2 signature will cover. Honest scope: policy thresholds come from the committed head config; a weakened policy authorizes against the weakened rules (§13 K2 — the boundary for that is human review of the enforcement-zone diff, stated, not papered over).

- **L2 signable statement layer: `safeinstall decisions attest` / `verify-attestation` (RFC-001 §3 L2, §10).** `decisions attest` builds the in-toto v1 Statement over an authorization artifact — subject = the artifact by sha256, predicate = the authorization itself — as canonical JCS bytes: the exact DSSE payload a Sigstore keyless signature will cover. `decisions verify-attestation` checks (non-cryptographically) that a statement binds a given artifact: canonical form, in-toto/predicate types, subject digest, and the predicate's verdict + head commit — catching a statement built for a different or tampered artifact. **Language discipline (issue #41): this is the *signable statement*, never a "proof".** The statement alone attests nothing; the cryptographic completion — Sigstore keyless signing (`sigstore.attest`, which needs an OIDC identity from a CI workflow) and bundle verification against the expected workflow identity (`sigstore.verify`) — runs where an OIDC identity exists, not in a hermetic build, and is the release/CI/owner-gated step (the `sigstore` peer dependency is already present for it). Freezing the statement's canonical form now means that eventual signature covers a stable, independently reconstructable payload. Every CLI message says plainly that binding is verified, not a signature.

### Changed

- **RFC-001 advanced to R2: the open trust-root questions are decided.** The decision-record spec now fixes canonical JSON (RFC 8785 JCS with an integer-only producer profile), binds records to git blob OIDs instead of working-tree byte hashes (killing the CRLF/materialization class and dropping `.gitattributes` from decision-record trust roots), makes the verifier's registry identity a verifier-side trust root with any non-default `registryUrl` a hard finding, turns non-registry sources (`file:`/`link:`/`directory:`) into explicit never-clean findings, defines monorepo semantics as per-lockfile-path chains with PR-level completeness, and settles race/TTL/retention (ruleset-first freshness, deterministic chain-preserving compaction). Publish time from the registry `time` field becomes primary over the `last-modified` header (implementation queued). Docs only — no runtime behavior changes in this entry.

- **The external verification anchor exists: [safeinstall-verifier](https://github.com/Mickdownunder/safeinstall-verifier).** Trust verification logic now lives in a separate, code-owner-locked public repository (RFC-001 §13 K1, stage 2 of #41): a composite action that installs safeinstall-cli pinned by exact version and sha512 content hash and verifies a candidate checkout strictly as data, guarded by a CI-required adversarial suite (tampered workflow, weakened policy, redirected registryUrl, forged lock, identically-named-but-neutered check, removed baseline, naive consistent rewrite via mirror containment, corrupt verifier tarball — every case must fail, and the clean fixture must pass, so a vacuous verifier can never go green). SECURITY.md now states the shipped/pending split and the solo-maintainer review model (owner decision, #41) precisely. Switching this repository's trust workflow to invoke the verifier by full commit SHA is a separate, owner-gated change (enforcement zone).

### Fixed

- **Release-age now trusts the registry `time` map first, not a CDN header (RFC-001 §13 M1 / §14 D7).** Publish times were taken from the tarball's `last-modified` HTTP header — a mutable CDN/cache artifact — with the registry's authoritative `time` map only as fallback. The priority is flipped: the `time` map is primary, the header is fallback only, and every resolution records which source answered (`publishTimeSource: "registry-time" | "tarball-last-modified"`) so a release-age decision resting on the weaker source can say so instead of silently downgrading. The publish-time disk cache moved to a new namespace (`registry-publish-times-v2`) carrying the source alongside the date; old header-derived entries without provenance are deliberately not read.

## 0.12.0 - 2026-07-11

### Added

- **The repo dogfoods its own MCP server.** A root `.mcp.json` (exact-version pinned, as the trust surface demands of everyone) gives agent sessions in this repository `check_package` automatically, and satisfies Open-Plugins auto-detection.

- **`trust lock --ci github` now scaffolds a content-hash-pinned verifier.** The generated workflow installs the CLI from a tarball whose sha512 is verified against the digest recorded from the registry at scaffold time (trust on first use), so a registry later serving different bytes for the same version fails the check instead of silently swapping the verifier. Everything embedded in the workflow is allowlist-validated first; any registry error fails the scaffold closed — a weaker, version-only workflow is never written.

### Fixed

- **Legitimate trust-history advancement no longer demands approval.** The out-of-workspace ledger mirror now reconciles by hash-chain containment instead of head equality: a pull/rebase that brings reviewed, CI-verified trust entries fast-forwards the mirror silently, while rewrites and rollbacks still hard-block (#33).

### Changed

- Declared the MCP registry name in its canonical namespace case (`io.github.Mickdownunder/safeinstall`) and shipped `server.json`, enabling publication to the official MCP registry.
- **The Claude Code guard now rewrites raw installs in place, matching the Codex client.** A raw package-manager install (`npm install axios`, plus the previously bypassable case-insensitive, fd-redirection, and wrapper forms) is no longer denied with an instruction to re-run through the CLI; `safeinstall guard claude` now returns `hookSpecificOutput.updatedInput` to replace it with the SafeInstall-routed command. The hook emits **no `permissionDecision`**, so Claude Code's normal permission prompt stays active and displays the *rewritten* command — the user reviews and approves `safeinstall npm install axios`, never the raw install. Verified end-to-end against Claude Code v2.1.206: with `permission_mode: default` and a hook returning only `updatedInput`, the permission dialog showed the routed command and only the routed command executed on approval, so the in-place rewrite is a UX win, not a permission-prompt bypass. The `ask` path (registry runners) is unchanged — Claude's approval prompt is already stronger than Codex's forced deny — and mixed install-plus-runner commands still hard-deny, because `decideGuard` leaves the rewrite unset so a registry runner can never ride along inside `updatedInput`.

## 0.11.1 - 2026-07-10

### Security

- **`safeinstall trust approve` now refuses Codex sessions.** The human-approval gate blocked `CI`, `CLAUDECODE`, and `CURSOR_AGENT` contexts but had no marker for Codex, so a Codex session on the user's terminal could approve its own trust-surface changes. `CODEX_SHELL` (set by Codex in every shell it spawns) joins the refusal list, and the marker-refusal path gained its first direct tests.

### Fixed

- **Guard setup now gives the correct Trust Surface next step.** Fresh projects are directed to create a baseline with `safeinstall trust lock`; projects that already have a baseline are told to review drift with `safeinstall trust status` and intentionally re-baseline guard changes with `safeinstall trust approve`; an idempotent re-run no longer asks for unnecessary approval.

### Changed

- Declared the package's official MCP registry name (`mcpName: io.github.mickdownunder/safeinstall`) so the MCP server can be published to registry.modelcontextprotocol.io.
- `release:check` builds before testing, so the e2e suites always run against the current sources instead of a stale `dist/`.

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
