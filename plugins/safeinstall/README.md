# SafeInstall plugin

Last verified: 2026-10-01

The existing SafeInstall engine, packaged for local Codex/ChatGPT Work plugin
hosts. Plugin version **0.1.1** bundles CLI **0.15.0**. It is not a new policy
engine, an OS sandbox, a vulnerability scanner, or a public-directory listing.

## What you get

- `check_package`: release-age, scripts, sources, typo-squat and provenance
  checks, evaluated against the explicitly selected local project's policy.
- `protection_status`: policy location, engine version, and trust-surface drift.
- Four workflows: `safeinstall-setup`, `safeinstall-check`,
  `safeinstall-install`, and `safeinstall-status`.
- A separately trusted PreToolUse shell hook that denies unguarded package
  commands. It never returns `allow`, rewrites tool input, or suppresses normal
  permission prompts. Installation uses the bundled CLI explicitly.

## Download the public release

Download `safeinstall-plugin-0.1.1.tgz` and `SHA256SUMS` from
[the plugin release](https://github.com/Mickdownunder/SafeInstall/releases/tag/plugin-v0.1.1).
Verify the archive's SHA256 against `SHA256SUMS`, then extract it into a new
directory. The extracted directory contains `safeinstall/` and
`.agents/plugins/marketplace.json`; register that directory as the marketplace
using the commands below. No repository checkout or npm installation is needed.
For example, after extracting into `~/Downloads/safeinstall-plugin-0.1.1`:

```sh
codex plugin marketplace add "$HOME/Downloads/safeinstall-plugin-0.1.1"
codex plugin add safeinstall@safeinstall-local
```

The bundled signature verifier requires Node.js **22.22.2+ on 22.x,
24.15.0+ on 24.x, or 26+** (`^22.22.2 || ^24.15.0 || >=26.0.0`).
Unsupported versions stop with an explicit error rather than silently disabling
signature verification. Public download does not mean approval or listing in
OpenAI's directory.

`safeinstall-plugin-0.1.1.zip` is a plugin-only distribution archive with
`plugin.json` at the archive root, not an eligible public-directory submission.
The [current submission rules](https://developers.openai.com/plugins/deploy/submission)
exclude lifecycle hooks. This package contains a hook and local stdio MCP; the
ordinary MCP submission path expects a public HTTPS endpoint, while local MCP
support requires coordination with OpenAI. Use the `.tgz` marketplace for local
Codex installation. Neither archive is an approved OpenAI directory listing.

## Build from this repository

With the repository's locked dependencies already available and a supported
Node.js version as specified above:

```sh
node scripts/build-plugin.mjs
```

The output is `dist/plugins/` (local marketplace with a `safeinstall/` plugin)
and `dist/safeinstall-plugin-0.1.1.tgz` (the same marketplace and plugin).
The builder compiles the current engine, includes runtime dependencies and
required MCP/Sigstore peers, retains dependency licenses, and creates
`runtime/inventory.json` with package versions and the source lockfile digest.
`THIRD_PARTY_NOTICES` includes full license terms for the three dependencies
whose published packages omit license files, using version-pinned, hash-checked
local supplements. Builds make no license-fetch network requests and refuse
unreviewed missing license texts. Existing dependency license/notice files are
retained unchanged.
Runtime dependencies are regular files (including nested version conflicts),
not symlinks that the host's plugin cache copier may skip. The builder refuses
an installed pnpm graph whose lockfile differs from the repository lockfile.
It runs no dependency installation or lifecycle scripts. Build output is ignored
by Git and is not automatically published. Rebuild after source changes.

## Install locally

Register the generated marketplace, not the unbuilt source directory:

```sh
codex plugin marketplace add /absolute/path/to/SafeInstall/dist/plugins
codex plugin add safeinstall@safeinstall-local
```

Alternatively select the registered SafeInstall marketplace in the desktop
Plugins Directory and install SafeInstall there. Extracting the archive to
another directory produces an independently relocatable marketplace root.
The host copies the plugin to its cache; rebuilding the source does not update
an already installed copy. Refresh/reinstall from the marketplace after rebuilds.

Review and explicitly trust the bundled hook in the host's hook trust UI.
Installing/enabling the plugin does **not** grant hook trust. The status tool
cannot observe host activation and reports that limitation instead of claiming
protection. Start a new chat to load the installed skills and tools if necessary.

Then ask “Set up SafeInstall in this project” or invoke `$safeinstall-setup`.
Setup asks permission before writing project policy and a strict trust baseline;
it does not add duplicate project hooks or approve drift. Existing policy is
preserved. Trust approval/unlocking remains a human-terminal action.

## Security and privacy boundaries

Package checks are read-only MCP tools, not install authorization. Installs run
through the same fresh evaluation, exact-version/SHA512 artifact binding and
lifecycle-script disabling as SafeInstall CLI. npm and pnpm are supported;
Bun remains fail-closed. The wrapper rejects automated trust approval/unlocking
and project hook registration, even when global CLI options precede the command.

Malformed/oversized hook input or a missing/broken engine denies the tool call.
Ordinary supported commands receive no hook opinion, leaving host approvals
intact. Enforcement requires a host that supports PreToolUse and a trusted hook.
It covers the existing engine's supported shell command syntax, **not** arbitrary
programmatic downloads, code execution, hostile host/Node binaries, or every
installation elsewhere on the machine. Existing unrelated project hooks remain
under the project's own management.

No OpenAI API key, new daemon, telemetry service or account is needed. Registry
and provenance checks make the existing engine's network requests: package
names/versions go to the configured registry, and provenance verification may
contact Sigstore services. Policies and trust state remain local; package
metadata is untrusted evidence, never executable workflow instructions.

This local stdio package is not an ordinary browser-only ChatGPT integration.
Lifecycle hooks are currently excluded from public-directory submission. The
ordinary MCP submission path requires a reviewed HTTPS endpoint; local MCP
support requires coordination with OpenAI. No remote service,
domain verification, OpenAI directory submission or npm publication is included
in this release. The public GitHub download is independent of directory review.

## Verification

```sh
pnpm exec vitest run tests/plugin-e2e.test.ts
node scripts/plugin-client-smoke.mjs
SAFEINSTALL_TEST_CLI_PATH="$PWD/dist/plugins/safeinstall/scripts/cli.cjs" \
  pnpm exec vitest run tests/install-binding-real-e2e.test.ts
```

The plugin tests rebuild, extract and run the distributed artifact, perform a
real stdio MCP handshake, test project-specific checks/status, and probe raw
installs with a hostile PATH, malformed input, trust drift and approval bypass
attempts. The existing real-manager suite tests approved bytes, lifecycle
suppression, tag races, manifest substitution and tarball substitution via the
bundled CLI entry. Desktop hook-trust interaction is a separate manual gate.
The client smoke uses an isolated temporary Codex home, installs the generated
marketplace, and asks the real app-server to discover the two MCP tools and four
skills. It grants no hook trust and makes no model request. Its proof is saved
to `dist/plugins-verification/codex-client.json` with the archive digest.

Packaging follows the [official plugin format](https://developers.openai.com/plugins/build/plugins)
and the [host hook contract](https://learn.chatgpt.com/docs/hooks).
