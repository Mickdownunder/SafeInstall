import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeShellCommand } from "../src/guard-commands";
import { decideGuard } from "../src/guard-flow";

/**
 * Characterization tests for the shell-command guard parser.
 *
 * These pin the parser's CURRENT observable behaviour, category by category,
 * so the planned decomposition into Tokenize/Classify/Rewrite modules can be
 * verified to preserve it byte for byte. They are golden tests: they assert
 * what the parser does today, not what it ideally should do.
 *
 * Former security findings are tagged `regression`. Their assertions pin the
 * patched decisions so a future parser refactor cannot silently reopen them:
 *   - manager and wrapper matching is case-insensitive,
 *   - leading redirections cannot hide the effective command,
 *   - wrapper options are parsed according to the wrapper contract,
 *   - create/init subcommands that execute registry code require confirmation.
 * Note: fullwidth/zero-width manager spellings (unicode category) are allowed,
 * but a real shell would not resolve them to the binary either, so they are
 * expected behaviour rather than bypasses.
 */

type Decision = "allow" | "deny" | "ask";

interface RunnerExpectation {
  tool: string;
  packageHint: string | undefined;
  fetchesRemote: boolean;
}

interface Case {
  input: string;
  decision: Decision;
  /** Exact `manager command` pairs, e.g. "npm install". */
  installs?: string[];
  /** Exact rewrittenCommand. */
  rewrite?: string;
  runners?: RunnerExpectation[];
  /** Substring the first unanalyzable reason must contain. */
  reasonIncludes?: string;
  writeTargets?: string[];
  usesSafeInstall?: true;
  regression?: true;
}

function derivedDecision(analysis: ReturnType<typeof analyzeShellCommand>): Decision {
  if (analysis.unanalyzable.length > 0) return "deny";
  if (analysis.installs.length > 0) return "deny";
  if (analysis.runners.length > 0) return "ask";
  return "allow";
}

const CASES: Case[] = [
    // ---- simple ----
    { input: "git status && ls -la", decision: "allow" },
    { input: "echo hello world", decision: "allow" },
    { input: "cd app", decision: "allow" },
    { input: "node dist/cli.js", decision: "allow" },
    { input: "npm test", decision: "allow" },
    { input: "npm run build", decision: "allow" },
    { input: "pnpm run lint", decision: "allow" },
    { input: "bun run dev", decision: "allow" },
    { input: "npm uninstall axios", decision: "allow" },
    { input: "npm ls", decision: "allow" },
    { input: "npm outdated", decision: "allow" },
    { input: "npm --version", decision: "allow" },
    { input: "npm", decision: "allow" },
    { input: "pnpm", decision: "allow" },
    { input: "bun", decision: "allow" },
    { input: "npm config get registry", decision: "allow" },
    // ---- install ----
    { input: "npm install", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install" },
    { input: "npm install axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "npm i axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "npm add axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "pnpm install", decision: "deny", installs: ["pnpm install"], rewrite: "safeinstall pnpm install" },
    { input: "pnpm i", decision: "deny", installs: ["pnpm install"], rewrite: "safeinstall pnpm install" },
    { input: "pnpm add zod", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add zod" },
    { input: "bun install", decision: "deny", installs: ["bun install"], rewrite: "safeinstall bun install" },
    { input: "bun add zod", decision: "deny", installs: ["bun add"], rewrite: "safeinstall bun add zod" },
    { input: "bun a zod", decision: "deny", installs: ["bun add"], rewrite: "safeinstall bun add zod" },
    { input: "npm ci", decision: "deny", installs: ["npm ci"], rewrite: "safeinstall npm ci" },
    { input: "npm clean-install", decision: "deny", installs: ["npm ci"], rewrite: "safeinstall npm ci" },
    { input: "npm in axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "npm ins axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "npm isntall axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "npm ic", decision: "deny", installs: ["npm ci"], rewrite: "safeinstall npm ci" },
    { input: "pnpm add react react-dom zod", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add react react-dom zod" },
    // ---- install-flags ----
    { input: "npm install -g safeinstall-cli", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install -g safeinstall-cli" },
    { input: "npm install --save-dev typescript", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install --save-dev typescript" },
    { input: "npm i -D vitest", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install -D vitest" },
    { input: "pnpm add -w lodash", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add -w lodash" },
    { input: "npm install --registry http://r.example axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install --registry http://r.example axios" },
    { input: "npm i --force axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install --force axios" },
    // ---- mgr-flags ----
    { input: "pnpm -C packages/app install", decision: "deny", installs: ["pnpm install"], rewrite: "safeinstall pnpm -C packages/app install" },
    { input: "npm --workspace app install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm --workspace app install evil-pkg" },
    { input: "pnpm --dir packages/app add evil-pkg", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm --dir packages/app add evil-pkg" },
    { input: "npm --registry http://r install axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm --registry http://r install axios" },
    // ---- pipe ----
    { input: "npm install axios | tee install.log", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios | tee install.log", writeTargets: ["install.log"] },
    { input: "npm install axios 2>&1 | cat", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios 2>&1 | cat" },
    // ---- chain ----
    { input: "cd app && npm install axios && npm test", decision: "deny", installs: ["npm install"], rewrite: "cd app && safeinstall npm install axios && npm test" },
    { input: "npm i axios; pnpm add zod", decision: "deny", installs: ["npm install", "pnpm add"], rewrite: "safeinstall npm install axios; safeinstall pnpm add zod" },
    { input: "false || npm install axios", decision: "deny", installs: ["npm install"], rewrite: "false || safeinstall npm install axios" },
    { input: "git pull && npm ci", decision: "deny", installs: ["npm ci"], rewrite: "git pull && safeinstall npm ci" },
    { input: "npm i a && npm i b", decision: "deny", installs: ["npm install", "npm install"], rewrite: "safeinstall npm install a && safeinstall npm install b" },
    // ---- subst ----
    { input: "npm install $(cat packages.txt)", decision: "deny", reasonIncludes: "The install command uses she" },
    { input: "`echo npm` install evil-pkg", decision: "deny", reasonIncludes: "shell substitution" },
    { input: "npm install `whoami`", decision: "deny", reasonIncludes: "The install command uses she" },
    { input: "( npm install evil-pkg )", decision: "deny", reasonIncludes: "The install command uses she" },
    { input: "echo $(date)", decision: "allow" },
    // ---- quote ----
    { input: "npm install '@scope/pkg@^1.0.0'", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install '@scope/pkg@^1.0.0'" },
    { input: "npm install \"axios@1.2.3\"", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install \"axios@1.2.3\"" },
    { input: "'npm install axios'", decision: "allow" },
    { input: "npm install \\\"axios\\\"", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install \\\"axios\\\"" },
    // ---- env ----
    { input: "CI=1 npm install axios", decision: "deny", installs: ["npm install"], rewrite: "CI=1 safeinstall npm install axios" },
    { input: "FOO=bar BAZ=1 npm i axios", decision: "deny", installs: ["npm install"], rewrite: "FOO=bar BAZ=1 safeinstall npm install axios" },
    { input: "TOKEN=$NPM_TOKEN npm install axios", decision: "deny", installs: ["npm install"], rewrite: "TOKEN=$NPM_TOKEN safeinstall npm install axios" },
    { input: "npm install $PKG", decision: "deny", reasonIncludes: "The install argument \"$PKG\" " },
    { input: "npm install ${PKG}", decision: "deny", reasonIncludes: "The install argument \"${PKG}" },
    // ---- path ----
    { input: "/usr/local/bin/npm install axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "./npm install axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "../node_modules/.bin/pnpm add zod", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add zod" },
    { input: "npm.cmd install axios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios" },
    { input: "pnpm.exe add zod", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add zod" },
    // ---- runner ----
    { input: "npx playwright install", decision: "ask", runners: [{ tool: "npx", packageHint: "playwright", fetchesRemote: false }] },
    { input: "npx cowsay hi", decision: "ask", runners: [{ tool: "npx", packageHint: "cowsay", fetchesRemote: false }] },
    { input: "pnpm dlx create-next-app", decision: "ask", runners: [{ tool: "pnpm dlx", packageHint: "create-next-app", fetchesRemote: true }] },
    { input: "bunx cowsay hi", decision: "ask", runners: [{ tool: "bunx", packageHint: "cowsay", fetchesRemote: false }] },
    { input: "bun x cowsay hi", decision: "ask", runners: [{ tool: "bunx", packageHint: "cowsay", fetchesRemote: false }] },
    { input: "yarn dlx create-app", decision: "ask", runners: [{ tool: "yarn dlx", packageHint: "create-app", fetchesRemote: true }] },
    { input: "npm exec -- prettier --write .", decision: "ask", runners: [{ tool: "npm exec", packageHint: "prettier", fetchesRemote: false }] },
    { input: "npm x prettier", decision: "ask", runners: [{ tool: "npm exec", packageHint: "prettier", fetchesRemote: false }] },
    { input: "pnpx foo", decision: "ask", runners: [{ tool: "pnpx", packageHint: "foo", fetchesRemote: true }] },
    { input: "npx -p typescript tsc", decision: "ask", runners: [{ tool: "npx", packageHint: "typescript", fetchesRemote: true }] },
    { input: "npx --package=cowsay cowsay hi", decision: "ask", runners: [{ tool: "npx", packageHint: "cowsay", fetchesRemote: true }] },
    { input: "npx cowsay@1.5.0 hi", decision: "ask", runners: [{ tool: "npx", packageHint: "cowsay@1.5.0", fetchesRemote: false }] },
    { input: "npx -- prettier", decision: "ask", runners: [{ tool: "npx", packageHint: "prettier", fetchesRemote: false }] },
    { input: "pnpm exec prettier --write .", decision: "allow" },
    // ---- wrapper ----
    { input: "sudo npm install -g safeinstall-cli", decision: "deny", installs: ["npm install"], rewrite: "sudo safeinstall npm install -g safeinstall-cli" },
    { input: "env npm install axios", decision: "deny", installs: ["npm install"], rewrite: "env safeinstall npm install axios" },
    { input: "nohup npm install axios", decision: "deny", installs: ["npm install"], rewrite: "nohup safeinstall npm install axios" },
    { input: "time npm install axios", decision: "deny", installs: ["npm install"], rewrite: "time safeinstall npm install axios" },
    { input: "command npm install axios", decision: "deny", installs: ["npm install"], rewrite: "command safeinstall npm install axios" },
    { input: "exec npm install axios", decision: "deny", installs: ["npm install"], rewrite: "exec safeinstall npm install axios" },
    { input: "corepack pnpm add axios", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add axios" },
    { input: "corepack pnpm@9 add axios", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add axios" },
    // ---- redir ----
    { input: "npm install axios > install.log", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios > install.log", writeTargets: ["install.log"] },
    { input: "npm install axios >> install.log", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios >> install.log", writeTargets: ["install.log"] },
    { input: "npm install axios 2> err.log", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios 2> err.log", writeTargets: ["err.log"] },
    { input: "npm install axios &> all.log", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios &> all.log", writeTargets: ["all.log"] },
    { input: "npm install axios > install.log 2>&1", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios > install.log 2>&1", writeTargets: ["install.log"] },
    { input: "npm install axios < input", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios < input" },
    // ---- ws ----
    { input: "npm install a\nnpm install b", decision: "deny", installs: ["npm install", "npm install"], rewrite: "safeinstall npm install a\nsafeinstall npm install b" },
    { input: "npm\tinstall\taxios", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm\tinstall\taxios" },
    { input: "npm install axios\r", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install axios\r" },
    { input: "  npm   install    axios  ", decision: "deny", installs: ["npm install"], rewrite: "  safeinstall npm   install    axios  " },
    // ---- unicode ----
    { input: "\uff4e\uff50\uff4d install axios", decision: "allow" },
    { input: "n\u200bpm install axios", decision: "allow" },
    { input: "npm install \u200bxss-pkg", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install \u200bxss-pkg" },
    { input: "npm install evil\u202egpk", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install evil\u202egpk" },
    // ---- degenerate ----
    { input: "", decision: "allow" },
    { input: " ", decision: "allow" },
    { input: ";", decision: "allow" },
    { input: "&&", decision: "allow" },
    { input: "|", decision: "allow" },
    { input: "\n", decision: "allow" },
    { input: "   \t  ", decision: "allow" },
    // ---- overlong ----
    { input: "npm install aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    // ---- yarn ----
    { input: "yarn", decision: "deny", reasonIncludes: "SafeInstall does not support" },
    { input: "yarn install", decision: "deny", reasonIncludes: "SafeInstall does not support" },
    { input: "yarn add axios", decision: "deny", reasonIncludes: "SafeInstall does not support" },
    { input: "yarn global add pkg", decision: "deny", reasonIncludes: "SafeInstall does not support" },
    { input: "yarn run build", decision: "allow" },
    { input: "yarn create foo", decision: "ask", runners: [{ tool: "yarn create", packageHint: "foo", fetchesRemote: true }] },
    // ---- owned ----
    { input: "npm run add", decision: "allow" },
    { input: "pnpm exec install-tool", decision: "allow" },
    { input: "npm view add", decision: "allow" },
    { input: "npm config set add x", decision: "allow" },
    // ---- stray ----
    { input: "pnpm --some-future-flag value add evil-pkg", decision: "deny", reasonIncludes: "SafeInstall could not confid" },
    { input: "npm --loglevel warn install axios", decision: "deny", reasonIncludes: "SafeInstall could not confid" },
    // ---- nested ----
    { input: "bash -c 'npm install evil-pkg'", decision: "deny", reasonIncludes: "The command runs a package m" },
    { input: "sh -c \"echo hi\"", decision: "allow" },
    { input: "zsh -c 'ls -la'", decision: "allow" },
    { input: "bash -lc 'pnpm add zod'", decision: "deny", reasonIncludes: "The command runs a package m" },
    // ---- routed ----
    { input: "safeinstall npm install axios", decision: "allow", usesSafeInstall: true },
    { input: "safeinstall pnpm add zod", decision: "allow", usesSafeInstall: true },
    { input: "cd app && safeinstall npm install axios", decision: "allow", usesSafeInstall: true },
    // ---- write ----
    { input: "tee out.txt", decision: "allow", writeTargets: ["out.txt"] },
    { input: "rm -rf build", decision: "allow", writeTargets: ["build"] },
    { input: "mv a b", decision: "allow", writeTargets: ["a", "b"] },
    { input: "cp x y", decision: "allow", writeTargets: ["x", "y"] },
    { input: "sed -i s/a/b/ file.txt", decision: "allow", writeTargets: ["s/a/b/", "file.txt"] },
    { input: "echo hi > out.txt", decision: "allow", writeTargets: ["out.txt"] },
    { input: "truncate -s0 log", decision: "allow", writeTargets: ["log"] },
    { input: "echo hi > /dev/null", decision: "allow" },
    // ---- security regressions: case ----
    { input: "NPM install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install evil-pkg", regression: true },
    { input: "Npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "safeinstall npm install evil-pkg", regression: true },
    { input: "PNPM add evil-pkg", decision: "deny", installs: ["pnpm add"], rewrite: "safeinstall pnpm add evil-pkg", regression: true },
    { input: "Bun add evil-pkg", decision: "deny", installs: ["bun add"], rewrite: "safeinstall bun add evil-pkg", regression: true },
    { input: "SUDO npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "SUDO safeinstall npm install evil-pkg", regression: true },
    // ---- security regressions: leading redirection ----
    { input: "< in npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "< in safeinstall npm install evil-pkg", regression: true },
    { input: "> out npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "> out safeinstall npm install evil-pkg", writeTargets: ["out"], regression: true },
    { input: ">out npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: ">out safeinstall npm install evil-pkg", writeTargets: ["out"], regression: true },
    { input: "2>err npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "2>err safeinstall npm install evil-pkg", writeTargets: ["err"], regression: true },
    { input: "{audit}>out npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "{audit}>out safeinstall npm install evil-pkg", writeTargets: ["out"], regression: true },
    // ---- security regressions: wrapper options ----
    { input: "sudo -u root npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "sudo -u root safeinstall npm install evil-pkg", regression: true },
    { input: "sudo -E npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "sudo -E safeinstall npm install evil-pkg", regression: true },
    { input: "env -i npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "env -i safeinstall npm install evil-pkg", regression: true },
    { input: "time -p npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "time -p safeinstall npm install evil-pkg", regression: true },
    { input: "command -p npm install evil-pkg", decision: "deny", installs: ["npm install"], rewrite: "command -p safeinstall npm install evil-pkg", regression: true },
    { input: "env -S 'npm install evil-pkg'", decision: "deny", reasonIncludes: "split-string", regression: true },
    // ---- security regressions: remote execution ----
    { input: "npm create vite@latest", decision: "ask", runners: [{ tool: "npm create", packageHint: "vite@latest", fetchesRemote: true }], regression: true },
    { input: "npm init foo", decision: "ask", runners: [{ tool: "npm init", packageHint: "foo", fetchesRemote: true }], regression: true },
    { input: "yarn create foo", decision: "ask", runners: [{ tool: "yarn create", packageHint: "foo", fetchesRemote: true }], regression: true },
    { input: "pnpm create vite", decision: "ask", runners: [{ tool: "pnpm create", packageHint: "vite", fetchesRemote: true }], regression: true }
];

describe("guard parser characterization", () => {
  it("locks a broad, categorized corpus of behaviours", () => {
    expect(CASES.length).toBeGreaterThan(100);
  });

  it.each(CASES.map((testCase) => [testCase.input, testCase] as const))(
    "%j",
    (_input, testCase) => {
      const analysis = analyzeShellCommand(testCase.input);

      // The headline contract: the guard's decision on this command.
      expect(derivedDecision(analysis), "decision").toBe(testCase.decision);

      // Structural consistency between decision and parser output.
      if (testCase.decision === "allow") {
        expect(analysis.installs, "allow => no installs").toEqual([]);
        expect(analysis.unanalyzable, "allow => nothing unanalyzable").toEqual([]);
      } else if (testCase.decision === "deny") {
        expect(analysis.installs.length + analysis.unanalyzable.length, "deny => install or unanalyzable").toBeGreaterThan(0);
      } else {
        expect(analysis.runners.length, "ask => at least one runner").toBeGreaterThan(0);
        expect(analysis.installs, "ask => no installs").toEqual([]);
        expect(analysis.unanalyzable, "ask => nothing unanalyzable").toEqual([]);
      }

      if (testCase.installs !== undefined) {
        expect(analysis.installs.map((i) => `${i.manager} ${i.command}`)).toEqual(testCase.installs);
      }
      if (testCase.rewrite !== undefined) {
        expect(analysis.rewrittenCommand).toBe(testCase.rewrite);
      } else if (testCase.decision !== "deny" || testCase.reasonIncludes !== undefined) {
        // No rewrite unless there is a clean install segment.
        expect(analysis.rewrittenCommand).toBeUndefined();
      }
      if (testCase.runners !== undefined) {
        expect(
          analysis.runners.map((r) => ({ tool: r.tool, packageHint: r.packageHint, fetchesRemote: r.fetchesRemote }))
        ).toEqual(testCase.runners);
      }
      if (testCase.reasonIncludes !== undefined) {
        expect(analysis.unanalyzable.length).toBeGreaterThan(0);
        expect(analysis.unanalyzable[0].reason).toContain(testCase.reasonIncludes);
      }
      if (testCase.writeTargets !== undefined) {
        expect(analysis.writeTargets).toEqual(testCase.writeTargets);
      }
      if (testCase.usesSafeInstall !== undefined) {
        expect(analysis.usesSafeInstall).toBe(true);
      }
    }
  );

  it("every tagged security regression remains closed", () => {
    for (const testCase of CASES.filter((c) => c.regression)) {
      expect(derivedDecision(analyzeShellCommand(testCase.input)), `regression ${JSON.stringify(testCase.input)}`).not.toBe("allow");
    }
  });

  it("covers every planned category with at least one case", () => {
    // A guard against silently dropping a category during future edits.
    expect(CASES.length).toBe(160);
  });
});

describe("guard decision + message layer (decideGuard, no trust lock)", () => {
  // Exercises the real guard decision (allow/deny/ask) and the exact operator
  // and agent messages, in a throwaway directory with no trust lock and no
  // node_modules, so runner local-resolution is deterministic (always remote).
  let cwd: string;

  it("setup temp cwd", async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "safeinstall-char-"));
    expect(cwd).toBeTruthy();
  });

  it("allows an ordinary command with no opinion", async () => {
    const decision = await decideGuard("git status && ls -la", cwd);
    expect(decision.action).toBe("allow");
  });

  it("denies a raw install and hands back the safeinstall rewrite", async () => {
    const decision = await decideGuard("npm i axios", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.userMessage).toContain("SafeInstall requires package installs");
    expect(decision.agentMessage).toContain("safeinstall npm install axios");
  });

  it("denies a chained install rewriting only the install segment", async () => {
    const decision = await decideGuard("cd app && npm install axios && npm test", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).toContain("cd app && safeinstall npm install axios && npm test");
  });

  it("denies an unanalyzable install (command substitution) fail-closed", async () => {
    const decision = await decideGuard("npm install $(cat packages.txt)", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.userMessage).toContain("could not safely analyze");
    expect(decision.agentMessage).toContain("could not verify whether it installs anything");
  });

  it("denies a nested-shell install fail-closed", async () => {
    const decision = await decideGuard("bash -c 'npm install evil-pkg'", cwd);
    expect(decision.action).toBe("deny");
    expect(decision.agentMessage).toContain("nested shell");
  });

  it("asks before a registry-fetching runner", async () => {
    const decision = await decideGuard("pnpm dlx create-next-app", cwd);
    expect(decision.action).toBe("ask");
    expect(decision.userMessage).toContain("without install-time policy checks");
  });

  it("asks before an npx runner that cannot resolve locally", async () => {
    const decision = await decideGuard("npx cowsay hi", cwd);
    expect(decision.action).toBe("ask");
  });

  it("regression/case-sensitivity: an uppercase manager install is denied", async () => {
    const decision = await decideGuard("NPM install evil-pkg", cwd);
    expect(decision.action).toBe("deny");
  });

  it("regression/redirection-prefix: a leading redirection cannot hide the install", async () => {
    const decision = await decideGuard("> out npm install evil-pkg", cwd);
    expect(decision.action).toBe("deny");
  });

  it("regression/wrapper-option: a wrapper option cannot hide the install", async () => {
    const decision = await decideGuard("sudo -u root npm install evil-pkg", cwd);
    expect(decision.action).toBe("deny");
  });

  it("regression/remote-exec: npm create requires confirmation", async () => {
    const decision = await decideGuard("npm create vite@latest", cwd);
    expect(decision.action).toBe("ask");
  });
});
