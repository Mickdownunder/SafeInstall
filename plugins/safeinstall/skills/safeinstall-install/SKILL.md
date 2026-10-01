---
name: safeinstall-install
description: Install or add requested npm or pnpm dependencies through SafeInstall's existing artifact-bound installation gate. Use when a user requests dependency installation, including development dependencies. Never use for arbitrary registry-code execution or to bypass a policy block.
---

# Install through SafeInstall

Last verified: 2026-10-01

Resolve the installed plugin root from this skill's file location (two directories
above its directory) and the intended project to absolute paths. Do not guess
cache paths, rely on an ordinary shell having `PLUGIN_ROOT`, or invoke a global CLI.

1. Identify the existing package manager from project metadata and lockfile.
   Preserve npm versus pnpm; ask when ambiguous. Bun is not supported for
   artifact-bound installation and must not be substituted with raw Bun.
2. Call `check_package` for each requested package/version using the actual
   `projectPath`. Show warnings even for `allow`. On `block`, tool failure or
   unavailable tools: stop, report evidence, and do not install.
3. Confirm the user's installation intent and scope (production/development,
   project/workspace). A request to check is not a request to install.
4. Run in the project directory, with quoted absolute plugin path and quoted
   literal package arguments:
   `node "<absolute-plugin-root>/scripts/run.cjs" cli npm install "<package@version>" --json`
   or `node "<absolute-plugin-root>/scripts/run.cjs" cli pnpm add "<package@version>" --json`.
   Add `--save-dev` or `-D` only when the user requested a development dependency.
   For existing dependency installs, use the same wrapper with `npm install` or
   `pnpm install`; the engine evaluates the dependency graph itself.
5. Preserve host approval prompts. The engine performs fresh policy evaluation,
   exact-version/SHA512 binding and lifecycle-script disabling. A previous MCP
   allow does not replace this gate. Report engine block/error output unchanged.
6. Inspect the resulting manifest/lockfile delta and actual command exit status.
   Report what changed; do not report success based only on the earlier MCP check.

Never run raw package installs as fallback. Never request unsafe flags, enable
lifecycle scripts, run npx/bunx, lower release age or provenance settings, disable
the hook, alter the registry to evade a block, or approve/unlock trust drift.
Workspace/unsupported flag rejection is a stop, not permission to bypass.
