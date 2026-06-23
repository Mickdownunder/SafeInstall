# SafeInstall MCP server

Wire SafeInstall's supply-chain policy engine into your AI coding agent so it checks every package **before** suggesting or running an install.

The CLI (`safeinstall …`) protects humans who type the command. This MCP server protects **agents** — Claude Code, Claude Desktop, Cursor, Windsurf, Cline — by exposing the same engine as a tool the agent can call on its own.

## What it exposes

A single [Model Context Protocol](https://modelcontextprotocol.io) tool over stdio:

### `check_package`

> Check whether installing an npm package would be blocked by SafeInstall's supply-chain policy (release age, install scripts, untrusted sources, typo-squatting, Sigstore provenance, and provenance continuity). Call this BEFORE suggesting or running any package install.

**Input**

| Field     | Type     | Required | Notes                                                  |
| --------- | -------- | -------- | ------------------------------------------------------ |
| `name`    | string   | yes      | Package name, e.g. `axios` or `@scope/pkg`.            |
| `version` | string   | no       | A version or range; defaults to `latest`.              |
| `manager` | string   | no       | `npm` \| `pnpm` \| `bun` — informational only.         |

**Output** (returned as JSON text content)

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

`verdict` is `"block"` whenever the engine produces any blocking reason, otherwise `"allow"`. `sourceRepository` is the GitHub `owner/repo` the version was published from (from Sigstore provenance or the continuity baseline) when available, otherwise `null`.

## Configuration resolution

The server uses the **same config resolution as the CLI** — it walks up from the current working directory looking for `safeinstall.config.json`.

- **Config file found** → it is respected **exactly**.
- **No config file** → a **recommended secure preset** is used: the built-in defaults with `typoSquat.mode` and `continuity.mode` promoted to `"block"`. The agent use case wants maximum signal, so typo-squats and provenance discontinuities are blocked out of the box rather than the CLI's conservative off-by-default.

## Install once, protect forever

Two steps, then every install the agent proposes is screened automatically:

### 1. Add the MCP server to your client

**Claude Code / Claude Desktop** — add to your MCP config (`claude_desktop_config.json`, or a project-local `.mcp.json`):

```json
{
  "mcpServers": {
    "safeinstall": { "command": "npx", "args": ["safeinstall-cli", "mcp"] }
  }
}
```

**Cursor** — add the same block to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "safeinstall": { "command": "npx", "args": ["safeinstall-cli", "mcp"] }
  }
}
```

**Windsurf / Cline** and other MCP clients use the same shape — a server named `safeinstall` whose `command` is `npx` and `args` are `["safeinstall-cli", "mcp"]`. If you have SafeInstall installed globally you can instead use `"command": "safeinstall", "args": ["mcp"]`.

### 2. Add the agent rule

> [!IMPORTANT]
> **MCP tools are advisory.** Installing the server makes `check_package` *available* — it does **not** force the agent to call it. You must instruct the agent to use it.

Paste the snippet from [`agent-rule.md`](agent-rule.md) into your `CLAUDE.md`, Cursor Rules, or the equivalent system-prompt/rules file for your agent. That rule is what turns "available" into "always consulted".

## Optional dependency

The MCP SDK (`@modelcontextprotocol/sdk`) is an **optional dependency**, loaded lazily only when `safeinstall mcp` runs — exactly like the optional `sigstore` package. Users who only use the CLI never install it.

`npx safeinstall-cli mcp` pulls it in automatically. If you installed SafeInstall in a way that skipped optional dependencies and run `safeinstall mcp`, the command prints:

```
The MCP server requires the optional '@modelcontextprotocol/sdk' package. Install it with: npm install @modelcontextprotocol/sdk
```

and exits non-zero.

## Verifying the server manually

`safeinstall mcp` speaks JSON-RPC over stdio. Quickest check with the official inspector:

```bash
npx @modelcontextprotocol/inspector npx safeinstall-cli mcp
```

List the tools, then call `check_package` with `{ "name": "axios" }` (expect `allow`) and `{ "name": "raect" }` (expect a `typo-squat-suspected` block under the secure preset).
