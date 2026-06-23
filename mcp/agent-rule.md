# SafeInstall agent rule

Paste the snippet below into your agent's rules file — `CLAUDE.md`, Cursor Rules (`.cursor/rules`), Windsurf rules, or the equivalent. It tells the agent to consult SafeInstall before any install. Without it, the `check_package` tool is available but the agent has no instruction to call it.

This rule assumes the `safeinstall` MCP server is configured (see [`README.md`](README.md)).

---

## Dependency safety: always check before installing

Before suggesting or running **any** package install command — `npm install`, `npm add`, `pnpm add`, `yarn add`, `bun add`, or `npx` of an unknown package — call the SafeInstall `check_package` tool for **each** package and version you intend to add.

- If the verdict is **`block`**, do **not** install the package. Tell the user the reason (`reasons[].message`) and suggest a safer alternative, for example:
  - an **older version** that passes the release-age window (for a `release-too-new` block),
  - the **correctly spelled** package (for a `typo-squat-suspected` block — use the name in the suggestion),
  - waiting for or verifying the release (for a `provenance-downgrade` or `identity-discontinuity` block, which can indicate a compromised maintainer account).
- Only proceed with installs whose verdict is **`allow`**.
- Surface any `warnings` to the user even when the verdict is `allow`.

Pass `name` (required), `version` (when the user asked for a specific version or range), and `manager` (`npm` / `pnpm` / `bun`) to the tool. Check each package in a multi-package install separately.

---

> Tip: keep this rule near the top of your rules file so it is always in context when the agent reaches for an install command.
