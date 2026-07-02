<p align="center">
  <strong>SafeInstall</strong>
  <br />
  <em>Stop risky package installs before they run.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/safeinstall-cli"><img src="https://img.shields.io/npm/v/safeinstall-cli?style=flat-square&color=22c55e" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="license" /></a>
  <a href="https://github.com/Mickdownunder/SafeInstall"><img src="https://img.shields.io/github/stars/Mickdownunder/SafeInstall?style=flat-square" alt="stars" /></a>
  <a href="https://github.com/Mickdownunder/SafeInstall"><img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square" alt="TypeScript" /></a>
  <a href="https://safeinstall.dev"><img src="https://img.shields.io/badge/docs-safeinstall.dev-22c55e?style=flat-square" alt="docs" /></a>
</p>

<p align="center">
  Local-first CLI wrapper for <strong>npm</strong>, <strong>pnpm</strong>, and <strong>bun</strong>.<br />
  Policy runs first. Then your package manager. Not the other way around.<br /><br />
  Open source · MIT licensed · Free forever
</p>

---

## Why SafeInstall

AI coding tools suggest packages in seconds. They don't check publish dates. They don't read install scripts. They don't verify the source. You type "yes" and move on.

SafeInstall is the gate between suggestion and execution.

```
$ safeinstall pnpm add compromised-pkg@9.9.9

Install blocked.
- compromised-pkg@9.9.9
  Blocked: release too new (published 3 hours ago; minimum is 72 hours).
  Blocked: install script present (has postinstall).
```

No dashboard. No account. No cloud. One command prefix — policy runs locally, blocks by default, then invokes the real tool.

---

## Catching a maintainer-compromise attack

A valid Sigstore signature is not enough. An attacker who compromises an npm maintainer account can publish a malicious version of a package you already trust, and the attestation on that malicious version will cryptographically verify — signed by a GitHub Actions workflow the attacker controls in a fork of the real repository.

SafeInstall catches this. Pin the expected source repository with `provenance.trustedPublishers` and any build that comes from anywhere else is blocked, even if the signature is valid:

```
$ safeinstall check
Using config: ./safeinstall.config.json
Check blocked.
- axios@1.99.0
  Blocked: publisher mismatch for axios (expected axios/axios, got evil-org/axios).
  Suggestion: Verify the package source. Update provenance.trustedPublishers only if the change is intentional.
```

This is the only check of its kind in an install-time policy gate. CVE scanners look for known vulnerabilities. Content analyzers look for suspicious code. SafeInstall enforces that the cryptographic chain of trust points at the repository you agreed to trust — and refuses anything else, no matter how legitimate it looks.

SafeInstall itself is published with a Sigstore attestation. You can eat your own dog food: enable provenance verification, pin `safeinstall-cli` to `Mickdownunder/SafeInstall`, and watch SafeInstall verify its own trust chain against the public Sigstore transparency log.

```
$ safeinstall check
Using config: ./safeinstall.config.json
Info: safeinstall-cli: provenance verified from Mickdownunder/SafeInstall via .github/workflows/release.yml.
Check passed: no direct dependency policy violations found.
```

---

## Install

```bash
npm install -g safeinstall-cli
```

> Node.js >=20 · macOS, Linux, Windows · Command: `safeinstall`

## Quickstart

```bash
safeinstall init                      # create safeinstall.config.json
safeinstall pnpm add axios            # policy runs, then pnpm
safeinstall npm install               # lockfile-aware project install
safeinstall check                     # audit direct deps against policy
```

---

## How it works

```
┌─────────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  safeinstall pnpm   │ ──▶ │  Resolve &   │ ──▶ │  Policy check   │
│  add axios          │     │  fetch meta  │     │  (age, scripts, │
└─────────────────────┘     └──────────────┘     │   sources, ...)  │
                                                  └────────┬────────┘
                                                           │
                                                 ┌─────────▼─────────┐
                                          pass → │  Invoke pnpm add  │
                                          fail → │  Exit 2 (blocked) │
                                                 └───────────────────┘
```

1. Resolves what would be installed
2. Fetches registry metadata (publish time, declared scripts)
3. Evaluates policy rules
4. Blocks (exit 2) or invokes the real package manager

No registry proxy. No tarball rewriting. No cloud dependency.

---

## Policy defaults

| Rule | Default | Block message |
|:---|:---|:---|
| **Release age** | 72 hours minimum | `Blocked: release too new` |
| **Lifecycle scripts** | preinstall, install, postinstall blocked | `Blocked: install script present` |
| **Source types** | registry, workspace, file, directory allowed | `Blocked: untrusted source` |
| **Trust downgrade** | Detects registry→git/url or new scripts on update | `Blocked: trust level dropped` |
| **Typo-squat detection** | Off by default; opt in via `typoSquat.mode` | `Blocked: suspected typo-squat` |
| **Provenance verification** | Off by default; opt in via `provenance.mode` | `Blocked: attestation missing/invalid/publisher mismatch` |
| **Transitive dependencies** | Off by default; opt in via `transitive.mode` | `Blocked: transitive install script / untrusted source` |
| **Provenance continuity** | Off by default; opt in via `continuity.mode` | `Blocked: provenance downgrade / identity discontinuity` |

All rules are configurable. Ambiguous or incomplete metadata **blocks instead of allowing**.

### Provenance continuity — catching what npm defaults can't

This is SafeInstall's most distinctive check, and the one no other consumer-side tool does. npm verifies provenance at *publish* time and binds a package to a source repository — but it does not enforce **continuity** between versions. A compromised maintainer account can publish a new version with *no* attestation (from a stolen token), or from a *different* repository, and npm raises no alarm. This is the signature of the 2026 attack wave (Mastra, the dormant-account republishes).

Continuity learns a per-package trust baseline from the provenance identity of recent versions, then blocks deviations:

- **`provenance-downgrade`** — recent versions were attested, this one isn't. The fingerprint of an account-compromise publish from a personal token. *(This is the Mastra case.)*
- **`identity-discontinuity`** — this version is attested from a different source repository than the established baseline.

Because the baseline is learned **per package**, there are no false positives on the large majority of packages that never adopted provenance — they simply have no baseline and the check stays silent. No global "require provenance" sledgehammer.

It reads npm's published attestation metadata, so it works **without the optional sigstore package**. Opt in with `continuity.mode` set to `"warn"` or `"block"`.

> **Honest limit:** continuity does not catch an attack that comes *through* a legitimately-compromised CI workflow with valid provenance from the real repository (e.g. the Shai-Hulud worm class). There is no identity discontinuity to detect there. SafeInstall raises the bar against the dominant 2026 attack pattern; it does not close every door.

### Transitive dependencies

By default SafeInstall evaluates **direct** dependencies. Most supply-chain attacks, though, reach you through a *transitive* dependency — a package you never chose, pulled in several levels deep. Enable `transitive` mode to walk the full lockfile tree.

Two checks run transitively, both read directly from the lockfile with **zero extra registry calls**:

- **`install-script`** — flags transitive packages that declare a lifecycle script (the `ua-parser-js` attack class: a deeply nested dependency running code at install time). npm records this in the lockfile; pnpm lockfiles do not, so this check is npm-only for now.
- **`untrusted-source`** — flags transitive packages resolving from git, url, or tarball sources instead of the registry. Works for both npm and pnpm.

Release-age, typo-squat, and provenance are deliberately **not** run transitively — they would either flood you with noise or require a registry round-trip per package. Transitive evaluation applies to `safeinstall check` and project installs (`pnpm install`, `npm ci`), which have a resolved lockfile.

```json
{
  "transitive": {
    "mode": "warn",
    "checks": ["install-script", "untrusted-source"]
  }
}
```

### Typo-squat detection

A new policy check in 0.2.0 that flags install requests whose package name is a close-but-not-exact match to a well-known popular package. It catches the most common supply-chain attack pattern: `lodsh` for `lodash`, `axois` for `axios`, `raect` for `react`, and so on.

- **Algorithm:** Damerau-Levenshtein distance (transpositions count as a single edit)
- **Target list:** curated set of popular ecosystem packages, embedded at build time (no runtime network fetch)
- **Default mode:** `"off"` — opt in with `typoSquat: { "mode": "warn" }` or `"block"`
- **False-positive mitigation:** exact matches to the list are never flagged, short names (< 4 chars) are skipped, per-project `ignore` list is supported

### Provenance verification

A new policy check in 0.2.0 that **cryptographically verifies** the npm provenance attestation for registry installs and optionally **pins the source repository** via per-package trusted publisher patterns.

- Fetches the attestation bundle from the npm registry's `/-/npm/v1/attestations/<pkg>@<version>` endpoint
- Verifies the Sigstore bundle via the official `sigstore` package (signatures, Rekor transparency log, Sigstore public trust root)
- Extracts source repository, commit ref, and workflow path from the SLSA v1 provenance statement
- Matches the source repository slug against per-package `trustedPublishers` patterns — catching not only tampered tarballs but also **maintainer-compromise attacks** where an attacker republishes a legitimate-looking package from a fork they control
- **Publisher mismatches always block**, even in `"warn"` mode, because a valid signature from the wrong repo is exactly what maintainer compromise looks like

Default mode is `"off"`. Opt in by setting `provenance.mode` to `"warn"` or `"require"`.

---

## Usage

```bash
# Ad-hoc installs
safeinstall pnpm add axios
safeinstall npm install react@19.2.0
safeinstall bun add zod

# Project installs (lockfile-aware for npm/pnpm)
safeinstall pnpm install
safeinstall npm ci

# Monorepo — target one package
safeinstall pnpm -C packages/app install
safeinstall npm --prefix packages/app ci

# Utilities
safeinstall check                     # direct dependency audit
safeinstall check --json              # machine-readable
safeinstall init                      # create starter config
safeinstall init --force              # overwrite existing config
safeinstall mcp                       # MCP server for AI coding agents
safeinstall guard install             # register agent shell hooks (Claude Code, Cursor)
safeinstall trust lock                # baseline the Agent Trust Surface
safeinstall trust lock --ci github    # ...and scaffold the CI re-verification workflow
safeinstall trust status              # reconcile the trust surface (exit 2 on drift; read-only)
safeinstall trust approve             # review drift and re-baseline (interactive)
safeinstall trust unlock              # remove the baseline (lock, ledger, head mirror)
safeinstall --help
safeinstall --version

# JSON output (CI/automation)
safeinstall --json pnpm add axios

# Explicit config file (skips upward discovery)
safeinstall --config ./ci/safeinstall.config.json check
```

## Project installs

For `pnpm install` and `npm install` / `npm ci`, dependency versions come from the lockfile — not loose ranges in `package.json`.

- `pnpm-lock.yaml` for pnpm
- `package-lock.json` or `npm-shrinkwrap.json` for npm
- Stale, missing, or mismatched lockfile entries **fail closed**
- If `packageManager` is set in `package.json`, using a different CLI is blocked
- Workspace-targeting flags (`--filter`, `--workspace`) are blocked — use `-C` or `--prefix`
- `bun install` uses manifest-oriented analysis (full lockfile parity not yet implemented)

---

## MCP server / AI agents

The CLI reaches humans who type `safeinstall`. The **MCP server reaches every AI coding agent** — Claude Code, Cursor, Windsurf, Cline — so the policy engine is consulted *before* an agent suggests or runs an install, without anyone typing anything.

`safeinstall mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio that exposes one tool, `check_package`, backed by the exact same engine as the CLI (release age, install scripts, untrusted sources, typo-squat, Sigstore provenance, and provenance continuity).

> [!IMPORTANT]
> MCP tools are **advisory**. Installing the server makes `check_package` *available*; it does not force an agent to call it. "Install once, protected forever" = **one MCP config block + one rule snippet** ([`mcp/agent-rule.md`](mcp/agent-rule.md)) telling the agent to call the tool before every install.

### Wire it into your agent

**Claude Code / Claude Desktop** — add to your MCP config (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "safeinstall": { "command": "npx", "args": ["safeinstall-cli", "mcp"] }
  }
}
```

**Cursor** — add the same block to `.cursor/mcp.json`.

Then paste the rule from [`mcp/agent-rule.md`](mcp/agent-rule.md) into your `CLAUDE.md` / Cursor Rules. Full setup details: [`mcp/README.md`](mcp/README.md).

### What the agent sees

`check_package` accepts `name` (required), `version` (optional, defaults to latest), and `manager` (optional, informational) and returns a JSON verdict:

```json
{
  "verdict": "block",
  "name": "raect",
  "version": null,
  "reasons": [
    { "code": "typo-squat-suspected", "message": "Blocked: Suspected typo-squat: \"raect\" is 2 edit(s) away from popular package \"react\".", "suggestion": "Verify you meant to install \"react\"." }
  ],
  "warnings": [],
  "infos": [],
  "sourceRepository": null,
  "ageHours": null
}
```

`verdict` is `"block"` when any policy reason blocks the install, otherwise `"allow"`.

When **no `safeinstall.config.json` is found**, the MCP server uses a **recommended secure preset** — the built-in defaults with `typoSquat` and `continuity` promoted to `"block"`, because the agent use case wants maximum signal. When a config file **is** found, it is respected exactly (same resolution as the CLI).

The MCP SDK ships as an **optional dependency**, lazily loaded only when `safeinstall mcp` runs — CLI-only users never install it. If it is missing, the command prints an install hint and exits non-zero.

---

## Agent guard — enforcement, not advice

The MCP tool is advisory: an agent *can* consult it. The **guard is enforcement**: it hooks into the agent's shell layer and intercepts every command *before it runs* — whether or not the agent knows SafeInstall exists.

```bash
safeinstall guard install          # registers hooks for Claude Code and Cursor
safeinstall guard install --client cursor   # or just one client
```

This writes project-level hook configuration (merged non-destructively, idempotent on re-runs):

- **Claude Code** — a `PreToolUse` hook on the `Bash` tool in `.claude/settings.json`
- **Cursor** — a `beforeShellExecution` hook in `.cursor/hooks.json`, registered with `failClosed: true` so a crashed or timed-out guard blocks instead of silently allowing

### How the guard decides

The guard never evaluates policy itself — it detects package installs and routes them through the CLI, which owns the decision:

| Agent runs | Guard response |
|:---|:---|
| `git status`, `npm test`, ... | Allowed — not an install |
| `npm install axios` (also `npm i`, `pnpm add`, `bun a`, `npm ci`, `corepack pnpm add`, `pnpm --dir app add`, ...) | **Denied**, agent is told to run `safeinstall npm install axios` instead |
| `cd app && npm i axios && npm test` | **Denied**, rewrite prefixes only the install segment |
| `safeinstall npm install axios` | Allowed — already routed through the policy engine |
| `npm install $(cat list.txt)`, `bash -c "npm install ..."` | **Denied** — cannot be analyzed safely (fail-closed) |
| `yarn add axios` | **Denied** — SafeInstall cannot policy-check yarn |
| `npx tsc` with `typescript` installed locally | Allowed — npx resolves the local binary, nothing is downloaded |
| `npx create-next-app`, `pnpm dlx ...`, `bunx ...`, `yarn dlx ...` | **Ask** — downloads and executes registry code, so the user must approve |

Routing through the CLI matters more than a simple allow/deny: a vetted-but-raw `npm install` would still execute lifecycle scripts. Through SafeInstall, the same install gets the full policy evaluation *and* runs with install scripts disabled.

The deny message hands the agent the exact rewritten command, so a well-behaved agent self-corrects in one step — blocking becomes steering. The guard needs no network access and answers in milliseconds.

### Guard limitations

- The `safeinstall` binary must be on the agent's `PATH` (`npm install -g safeinstall-cli`).
- `npx` and friends are gated with **ask**, not policy-checked: SafeInstall's engine evaluates installs, not one-off executions. The local-binary fast path mirrors the runners' own resolution (nearest `node_modules/.bin`), so approved project tooling never prompts.
- A determined adversary can bypass shell-level analysis (e.g. by writing a script file first, or via `node -e`). The guard raises the bar as one layer of defense in depth — combine it with the MCP tool and CI checks.

---

## Agent Trust Surface — self-defending policy

The guard stops raw installs. But a prompt-injected agent does not have to fight the guard — it can just **rewrite the rules**: weaken `safeinstall.config.json`, delete the hook from `.cursor/hooks.json`, plant an invisible-Unicode instruction in `AGENTS.md`, or register a malicious MCP server. Those files program the *next* agent session; in the agent era they are the persistence mechanism, the new crontab.

`safeinstall trust lock` records a hash baseline of that surface. SafeInstall then reconciles the real state against it before guard decisions and before every install/check, and can re-verify it in CI.

```bash
safeinstall guard install       # register the hooks
safeinstall trust lock --ci github  # baseline the surface AND scaffold CI re-verification
safeinstall trust status        # reconcile — exit 2 on drift (use in CI); read-only
safeinstall trust approve       # review drift and re-baseline (interactive only)
safeinstall trust unlock        # remove the baseline (lock, ledger, head mirror)
```

`--ci github` writes `.github/workflows/safeinstall-trust.yml`, which re-verifies the committed baseline on every pull request by running `safeinstall trust status --require-lock` with the CLI pinned to an exact version. Commit `.safeinstall/` and that workflow together. An existing workflow file is never overwritten, and the workflow file is itself part of the tracked surface, so disabling it is detected as drift.

Two things you must do for the check to actually enforce, because a CLI cannot set them for you:

- Make the workflow a **required status check** in your branch protection — otherwise a red check does not block a merge.
- Require review of changes to `.safeinstall/` and `.github/workflows/` (e.g. via `CODEOWNERS`). The automatic check catches *inconsistent* tampering; a fully consistent rewrite of the whole baseline in one PR is only caught by a human reviewing the `.safeinstall/` diff.

### The three zones

| Zone | Files | On drift |
|:---|:---|:---|
| **Enforcement** | `safeinstall.config.json`, `.claude/settings.json`, `.cursor/hooks.json`, `.github/workflows/safeinstall-trust.yml`, `.safeinstall/` | Every agent command is denied until a human approves |
| **Instruction** | `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/**`, `.github/copilot-instructions.md` | Hidden Unicode is always blocked; content drift warns (blocks in `--mode strict`) |
| **Tool** | `.mcp.json`, `.cursor/mcp.json`, MCP blocks in `.claude/settings.json` | Installs and runners are denied until a human approves; unpinned MCP servers are flagged |

Instruction content drift only warns by default because Claude Code writes to `CLAUDE.md` itself (its memory feature) — blocking that would break a normal workflow. Hidden Unicode, on the other hand, has no legitimate purpose in these files and always blocks.

### How it defends itself

- **CI as the real anchor.** Run `safeinstall trust lock --ci github` to scaffold a workflow that re-hashes the trust surface against the committed lock on every pull request, on a machine the agent does not control, with the CLI pinned to an exact version. This is the durable guarantee: tampering that happened on a compromised local machine does not survive review. (Wiring the Action directly also works — but pin its `version:` input; the default `latest` floats.)
- **Reconciliation on top of interception.** The guard is the fast layer; every `safeinstall` install/check also reconciles against the baseline. Deleting the hook to silence the guard, or editing a protected file, shows up as drift on the next SafeInstall run locally — and, regardless, fails CI re-verification.
- **Human-gated changes.** Both commands that relax enforcement require a human: `safeinstall trust approve` reads its confirmation from the controlling terminal (`/dev/tty`), never from stdin, and `trust unlock` likewise requires a controlling terminal — both refuse to run in CI or known agent-hook contexts, so an agent cannot silently re-baseline or remove the surface. `trust status` is read-only (safe in CI, never mutates the repo).
- **Hash-chained ledger.** Baseline decisions are chained in `.safeinstall/ledger.jsonl`; the lock binds to a ledger entry (including its enforcement `mode`), so editing the committed lock to drop a file or downgrade strict→warn breaks the binding. A local head mirror under `~/.safeinstall/` catches naive/accidental history rewrites; a vanished mirror is self-healed from the verified head on the next clean run, so a fresh clone establishes it automatically without noise.

### Trust surface limitations — read honestly

- **The durable guarantee is the committed lock verified by CI, not the local mirror.** Locally this is **tamper-evident against mistakes and non-targeted tampering, not tamper-proof.** A scheme-aware agent in your own user account can bypass interception (e.g. an install driven from `node -e`), rewrite the in-repo lock and ledger into a consistent state, and delete the local head mirror — user space cannot stop that, because the agent can read and delete anything you can. What it cannot do is subvert re-verification of the committed lock on a separate machine. **If you rely on this against a capable adversary, you must run the CI check.**
- It watches shell commands and files, not intent: an install performed by a program the agent writes and runs is caught by reconciliation on the next SafeInstall/CI run, not prevented at the moment of the call.
- A missing local head mirror is ambiguous (a fresh clone has none too), so on a clean verify it is self-healed from the committed ledger head rather than warned or blocked — the mirror is a best-effort local convenience, never the guarantee.

---

## Configuration

Optional `safeinstall.config.json` — discovered by walking upward from the project directory, or passed explicitly with `--config <path>`. An explicit path that cannot be read is an error (exit 1), never a silent fallback to defaults.

```json
{
  "minimumReleaseAgeHours": 72,
  "registryUrl": "https://registry.npmjs.org",
  "allowedScripts": {
    "esbuild": ["postinstall"]
  },
  "allowedSources": ["registry", "workspace", "file", "directory"],
  "allowedPackages": [],
  "packageManagerDefaults": {
    "npm": { "ignoreScripts": true },
    "pnpm": { "ignoreScripts": true },
    "bun": { "ignoreScripts": true }
  },
  "typoSquat": {
    "mode": "warn",
    "minNameLength": 4,
    "ignore": []
  },
  "provenance": {
    "mode": "warn",
    "requireFor": [],
    "trustedPublishers": {
      "axios": "axios/axios"
    },
    "offlineBehavior": "fail-closed"
  },
  "transitive": {
    "mode": "warn",
    "checks": ["install-script", "untrusted-source"]
  },
  "continuity": {
    "mode": "warn",
    "baselineSize": 5
  }
}
```

| Field | Purpose |
|:---|:---|
| `minimumReleaseAgeHours` | Minimum age in hours for registry versions |
| `registryUrl` | npm-compatible registry URL for metadata (mirrors, Artifactory, Verdaccio) |
| `allowedScripts` | Per-package lifecycle script exceptions |
| `allowedSources` | Permitted source types |
| `allowedPackages` | Names that skip release-age, install-script, and typo-squat checks (with warning). Source, trust-downgrade, and provenance checks still apply. |
| `packageManagerDefaults` | Per-manager flags forwarded to the tool |
| `typoSquat.mode` | `"off"` / `"warn"` / `"block"` — how to handle suspected typo-squats |
| `typoSquat.minNameLength` | Minimum package name length to check (shorter names are skipped) |
| `typoSquat.ignore` | Known legitimate lookalikes to skip, lowercased on load |
| `provenance.mode` | `"off"` / `"warn"` / `"require"` — whether to verify Sigstore attestations |
| `provenance.requireFor` | Package names (glob supported) for which provenance is required even in `"warn"` mode |
| `provenance.trustedPublishers` | Map of package name pattern → expected `owner/repo` slug; mismatches always block |
| `provenance.offlineBehavior` | `"fail-closed"` blocks on fetch failure, `"allow-cached"` falls back to a cached attestation |
| `transitive.mode` | `"off"` / `"warn"` / `"block"` — evaluate the full lockfile tree, not just direct deps |
| `transitive.checks` | Which checks run transitively: `"install-script"` and/or `"untrusted-source"` |
| `continuity.mode` | `"off"` / `"warn"` / `"block"` — detect provenance downgrades and source-repo changes against a learned per-package baseline |
| `continuity.baselineSize` | How many recent versions to sample when learning the baseline (default 5) |

Run `safeinstall init` to generate a starter config.

---

## Exit codes

| Code | Meaning |
|:---|:---|
| `0` | Allowed / check passed |
| `1` | Runtime or config error |
| `2` | Blocked by policy |

Use exit code 2 like any other failing step in a CI pipeline.

## JSON output

Pass `--json` anywhere in the command. Structured output goes to stdout.

```bash
safeinstall --json pnpm add axios
```

Fields: `command`, `commandString`, `packageManager`, `decision`, `summary`, `reasons`, `warnings`, `affectedPackages`, `exitCode`, `exitCodeMeaning`. Allowed installs include `execution.stdout` and `execution.stderr`.

---

## Examples

> Want to see every check in action? Run [`bash demo/run.sh`](./demo) — a reproducible script that blocks one scenario per policy check against real packages. See [demo/README.md](./demo/README.md) for the walkthrough.
>
> Want to see it against a **real attack**? Run [`pnpm replay mastra`](./demo/replay) — it feeds the recorded attack-time state of the June 2026 Mastra compromise into SafeInstall's real policy engine and shows which checks would have blocked it. See [demo/replay/README.md](./demo/replay/README.md).

<details>
<summary><strong>Fresh release blocked</strong></summary>

```
$ safeinstall pnpm add axios
Using config: built-in defaults
Install blocked.
- axios@1.14.0
  Blocked: release too new (axios@1.14.0 is 6 hours old; minimum is 72 hours).
  Suggestion: Retry later or lower minimumReleaseAgeHours if this package is intentionally urgent.
```

</details>

<details>
<summary><strong>Git source blocked</strong></summary>

```
$ safeinstall npm install github:axios/axios
Using config: built-in defaults
Install blocked.
- github:axios/axios
  Blocked: untrusted source (git).
  Suggestion: Use a registry release or allow this source intentionally.
```

</details>

<details>
<summary><strong>Package manager mismatch</strong></summary>

```
$ safeinstall npm install
Using config: built-in defaults
Install blocked.
- Project install blocked: package.json declares pnpm as packageManager, but this command uses npm.
```

</details>

<details>
<summary><strong>Stale lockfile</strong></summary>

```
$ safeinstall pnpm install
Using config: built-in defaults
Install blocked.
- Project install blocked: axios is declared in package.json but missing from pnpm-lock.yaml.
```

</details>

<details>
<summary><strong>Typo-squat caught</strong></summary>

```
$ safeinstall pnpm add raect
Using config: ./safeinstall.config.json
Install blocked.
- raect
  Blocked: Suspected typo-squat: "raect" is 1 edit(s) away from popular package "react".
  Suggestion: Verify you meant to install "react". If this package is intentional, add "raect" to typoSquat.ignore.
```

</details>

<details>
<summary><strong>Publisher mismatch (maintainer compromise defense)</strong></summary>

```
$ safeinstall pnpm add axios@1.99.0
Using config: ./safeinstall.config.json
Install blocked.
- axios@1.99.0
  Blocked: publisher mismatch for axios (expected axios/axios, got evil-org/axios).
  Suggestion: Verify the package source. Update provenance.trustedPublishers only if the change is intentional.
```

</details>

---

## GitHub Action

Run SafeInstall policy checks automatically on every pull request. Five lines of YAML, no configuration required — defaults apply immediately.

```yaml
# .github/workflows/safeinstall.yml
name: SafeInstall Policy Check
on: [pull_request]
jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: Mickdownunder/SafeInstall@v1
```

The action runs `safeinstall check` against your direct dependencies and sets the job status to pass or fail. Blocked dependencies appear in the GitHub Actions job summary with the exact block reason and suggestion.

### Install mode

To enforce policy during the actual install step (not just a check):

```yaml
      - uses: Mickdownunder/SafeInstall@v1
        with:
          mode: install
          package-manager: pnpm
          args: "--frozen-lockfile"
```

### Inputs

| Input | Default | Description |
|:---|:---|:---|
| `mode` | `check` | `check` audits deps; `install` runs the package manager through SafeInstall |
| `package-manager` | `pnpm` | `npm`, `pnpm`, or `bun` (install mode only) |
| `args` | | Additional arguments forwarded to the package manager |
| `config-path` | | Explicit path to `safeinstall.config.json` (auto-discovered if omitted) |
| `version` | `latest` | SafeInstall CLI version to install |

### Outputs

| Output | Description |
|:---|:---|
| `decision` | `allow` or `block` |
| `summary` | Human-readable one-line summary |
| `exit-code` | `0` (allow), `2` (block), or `1` (error) |
| `json` | Full JSON result from SafeInstall |

---

## Limitations

- **Not a CVE scanner** — pair with `npm audit` or Snyk for vulnerability data
- **Transitive dependencies** are evaluated for install scripts and untrusted sources when `transitive.mode` is enabled. Release-age, typo-squat, and provenance still apply to direct dependencies only.
- **Transitive install-script detection** is npm-only — pnpm lockfiles do not record install-script presence. Transitive untrusted-source detection works for both.
- **Native builds (`binding.gyp`)** are caught via the install-script check: npm normalizes `binding.gyp` into a `node-gyp rebuild` install script at publish time, so it is present in the registry metadata SafeInstall already reads — no tarball download required. The residual edge is a package published through a non-standard client that omits this normalization while still shipping a `binding.gyp`; detecting that would require tarball content inspection, which is out of scope (see *What it does not do*).
- **`peerDependencies`** not evaluated unless also declared as direct dependencies
- **Trust downgrade detection** requires prior install state in `node_modules`
- **`bun install`** uses manifest-only analysis (lockfile parity not yet implemented); transitive evaluation is npm/pnpm only
- **Typo-squat target list** is curated and refreshed manually between releases; brand new packages published in the last day may not yet appear
- **Provenance verification** supports GitHub Actions trusted publishers on the public Sigstore root only (GitLab CI, self-hosted Sigstore out of scope for 0.2.0)
- **Git sources** are identified by URL for allowlist purposes, not by inferred package name — conflating registry `axios` with `github:any-fork/axios` would be dangerous
- Ambiguous metadata blocks instead of guessing — by design

## What it does not do

- Vulnerability scanning or CVE databases
- Registry proxying or tarball rewriting
- Malware detection or package content analysis
- Selective lifecycle script execution (forwards `--ignore-scripts` by default)

---

## Works with

SafeInstall works with any tool that runs package manager commands — including AI coding assistants:

**Cursor** · **GitHub Copilot** · **Cline** · **Claude Code** · **Windsurf** · **Aider** · **Devin** · **Continue**

Just prefix your install commands with `safeinstall`. Same workflow, one safety layer.

---

## Contributing

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Issues and PRs welcome. Author merges at own discretion — this is a solo-maintained project.

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

SafeInstall is provided as-is under the MIT license. It is a policy tool that enforces configurable rules on package installs. It does not guarantee the safety of any package, does not detect all supply-chain attacks, and does not replace professional security review. Use at your own risk. The authors are not liable for any damages arising from the use of this software.

---

<p align="center">
  <a href="https://safeinstall.dev">safeinstall.dev</a> · <a href="https://www.npmjs.com/package/safeinstall-cli">npm</a> · <a href="https://github.com/Mickdownunder/SafeInstall">GitHub</a>
</p>
