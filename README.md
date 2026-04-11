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

All rules are configurable. Ambiguous or incomplete metadata **blocks instead of allowing**.

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
safeinstall --help
safeinstall --version

# JSON output (CI/automation)
safeinstall --json pnpm add axios
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

## Configuration

Optional `safeinstall.config.json` — discovered by walking upward from the project directory.

```json
{
  "minimumReleaseAgeHours": 72,
  "registryUrl": "https://registry.npmjs.org",
  "allowedScripts": {
    "esbuild": ["postinstall"]
  },
  "allowedSources": ["registry", "workspace", "file", "directory"],
  "allowedPackages": [],
  "ciMode": false,
  "packageManagerDefaults": {
    "npm": { "ignoreScripts": true },
    "pnpm": { "ignoreScripts": true },
    "bun": { "ignoreScripts": true }
  }
}
```

| Field | Purpose |
|:---|:---|
| `minimumReleaseAgeHours` | Minimum age in hours for registry versions |
| `registryUrl` | npm-compatible registry URL for metadata (mirrors, Artifactory, Verdaccio) |
| `allowedScripts` | Per-package lifecycle script exceptions |
| `allowedSources` | Permitted source types |
| `allowedPackages` | Names that skip policy entirely (with warning) |
| `ciMode` | Reserved for future CI-specific behavior |
| `packageManagerDefaults` | Per-manager flags forwarded to the tool |

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

---

## Limitations

- **Not a CVE scanner** — pair with `npm audit` or Snyk for vulnerability data
- **Transitive dependencies** not fully evaluated yet
- **`peerDependencies`** not evaluated unless also declared as direct dependencies
- **Trust downgrade detection** requires prior install state in `node_modules`
- **`bun install`** uses manifest-only analysis (lockfile parity not yet implemented)
- **`safeinstall check`** evaluates direct dependencies only
- Ambiguous metadata blocks instead of guessing — by design

## What it does not do

- Vulnerability scanning or CVE databases
- Registry proxying or tarball rewriting
- Malware detection or provenance attestation
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
