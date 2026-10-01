---
name: safeinstall-setup
description: Set up the existing SafeInstall policy and trust baseline in a local npm or pnpm project, or help a user enable the SafeInstall plugin hook. Use for SafeInstall onboarding and protection setup, not unrelated package installations.
---

# Set up SafeInstall

Last verified: 2026-10-01

Resolve this skill's installed directory from the host-provided skill location.
The plugin root is two directories above this skill directory. Use that absolute
root, never a guessed cache path or a global `safeinstall` binary. Quote all paths.
Do not assume `PLUGIN_ROOT` is exported in an ordinary shell tool; it is a hook variable.

1. Resolve the user's intended project to an absolute directory. If there are
   multiple plausible projects, ask which one. Check Node.js satisfies
   `^22.22.2 || ^24.15.0 || >=26.0.0`, required by bundled signature verification.
   If unsupported, ask the user to select a supported runtime; do not install one
   or weaken provenance policy automatically.
2. Call the plugin's `protection_status` with that `projectPath`. Report policy
   presence, trust drift, and the distinction between policy and hook activation.
3. Explain the writes before asking permission: starter `safeinstall.config.json`
   and `.safeinstall/` baseline/ledger. Existing policy is preserved; existing
   trust drift stops setup. Do not run setup without the user's authorization.
4. In the project directory, run:
   `node "<absolute-plugin-root>/scripts/run.cjs" cli init --no-guard --mode strict --json`
   The host owns the plugin hook. Do not add duplicate project hooks.
5. Call `protection_status` again. If drift is reported, show it and stop.
   Never approve drift, unlock trust, remove a lock, use `--force`, lower policy,
   or grant hook trust on the user's behalf.
6. Tell the user to review and explicitly trust the bundled hook in the host's
   hook trust UI and start a new chat if needed. Installation alone does not
   enable enforcement. Do not report “protected” without observing activation.

No API key or package download is required by this plugin. Registry package
checks still contact the project's configured registry. Local hooks protect
supported shell-tool calls, not arbitrary code execution or all system installs.
