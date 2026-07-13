import { describe, expect, it } from "vitest";

import { analyzeShellCommand } from "../src/guard-commands";
import { present } from "./helpers/present";

describe("analyzeShellCommand", () => {
  describe("commands without installs", () => {
    it("ignores ordinary commands", () => {
      const analysis = analyzeShellCommand("git status && ls -la");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
      expect(analysis.rewrittenCommand).toBeUndefined();
    });

    it("ignores non-install package manager commands", () => {
      for (const command of ["npm test", "npm run build", "pnpm run lint", "bun run dev", "npm uninstall axios"]) {
        const analysis = analyzeShellCommand(command);
        expect(analysis.installs, command).toEqual([]);
        expect(analysis.unanalyzable, command).toEqual([]);
      }
    });

    it("classifies npx and pnpm dlx as runners, not installs", () => {
      const npx = analyzeShellCommand("npx playwright install");
      expect(npx.installs).toEqual([]);
      expect(npx.runners).toEqual([
        {
          tool: "npx",
          packageHint: "playwright",
          fetchesRemote: false,
          segmentText: "npx playwright install"
        }
      ]);

      const dlx = analyzeShellCommand("pnpm dlx create-next-app");
      expect(dlx.installs).toEqual([]);
      expect(dlx.runners).toEqual([
        {
          tool: "pnpm dlx",
          packageHint: "create-next-app",
          fetchesRemote: true,
          segmentText: "pnpm dlx create-next-app"
        }
      ]);
    });

    it("classifies bunx, yarn dlx, and npm exec as runners", () => {
      expect(analyzeShellCommand("bunx cowsay hi").runners[0]).toMatchObject({
        tool: "bunx",
        packageHint: "cowsay",
        fetchesRemote: false
      });
      expect(analyzeShellCommand("bun x cowsay hi").runners[0]).toMatchObject({ tool: "bunx" });
      expect(analyzeShellCommand("yarn dlx create-app").runners[0]).toMatchObject({
        tool: "yarn dlx",
        fetchesRemote: true
      });
      expect(analyzeShellCommand("npm exec -- prettier --write .").runners[0]).toMatchObject({
        tool: "npm exec",
        packageHint: "prettier",
        fetchesRemote: false
      });
    });

    it("marks -p/--package and version-suffixed runner targets as remote", () => {
      expect(analyzeShellCommand("npx -p typescript tsc").runners[0]).toMatchObject({
        packageHint: "typescript",
        fetchesRemote: true
      });
      expect(analyzeShellCommand("npx --package=cowsay cowsay hi").runners[0]).toMatchObject({
        packageHint: "cowsay",
        fetchesRemote: true
      });
      // Version suffix keeps fetchesRemote false here; the local-resolution
      // check in guard-flow rejects non-plain hints instead.
      expect(analyzeShellCommand("npx cowsay@1.5.0 hi").runners[0]).toMatchObject({
        packageHint: "cowsay@1.5.0"
      });
    });

    it("treats pnpm exec as local-only (no runner)", () => {
      const analysis = analyzeShellCommand("pnpm exec prettier --write .");
      expect(analysis.runners).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("ignores package-manager names appearing as plain arguments", () => {
      const analysis = analyzeShellCommand("echo npm install is dangerous");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("allows installs already routed through safeinstall", () => {
      const analysis = analyzeShellCommand("safeinstall npm install axios");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
      expect(analysis.usesSafeInstall).toBe(true);
    });
  });

  describe("raw install detection", () => {
    it("detects a plain npm install", () => {
      const analysis = analyzeShellCommand("npm install axios");
      expect(analysis.installs).toEqual([
        { manager: "npm", command: "install", segmentText: "npm install axios" }
      ]);
      expect(analysis.rewrittenCommand).toBe("safeinstall npm install axios");
    });

    it("detects aliases and canonicalizes them in the rewrite", () => {
      expect(analyzeShellCommand("npm i axios").rewrittenCommand).toBe("safeinstall npm install axios");
      expect(analyzeShellCommand("pnpm i").rewrittenCommand).toBe("safeinstall pnpm install");
      expect(analyzeShellCommand("bun a zod").rewrittenCommand).toBe("safeinstall bun add zod");
      expect(analyzeShellCommand("npm ci").rewrittenCommand).toBe("safeinstall npm ci");
    });

    it("detects bare project installs", () => {
      const analysis = analyzeShellCommand("pnpm install");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("safeinstall pnpm install");
    });

    it("rewrites only the install segment in chained commands", () => {
      const analysis = analyzeShellCommand("cd app && npm install axios && npm test");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("cd app && safeinstall npm install axios && npm test");
    });

    it("rewrites multiple install segments independently", () => {
      const analysis = analyzeShellCommand("npm i axios; pnpm add zod");
      expect(analysis.installs).toHaveLength(2);
      expect(analysis.rewrittenCommand).toBe("safeinstall npm install axios; safeinstall pnpm add zod");
    });

    it("handles env-var prefixes and preserves them in the rewrite", () => {
      const analysis = analyzeShellCommand("CI=1 npm install axios");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("CI=1 safeinstall npm install axios");
    });

    it("sees through common wrappers like sudo and env", () => {
      expect(analyzeShellCommand("sudo npm install -g safeinstall-cli").installs).toHaveLength(1);
      expect(analyzeShellCommand("env npm install axios").installs).toHaveLength(1);
    });

    it("sees through value-taking and boolean wrapper options", () => {
      expect(analyzeShellCommand("sudo -u root npm install evil-pkg").rewrittenCommand).toBe(
        "sudo -u root safeinstall npm install evil-pkg"
      );
      expect(analyzeShellCommand("sudo -E npm install evil-pkg").installs).toHaveLength(1);
      expect(analyzeShellCommand("env -i npm install evil-pkg").installs).toHaveLength(1);
      expect(analyzeShellCommand("env -u NODE_OPTIONS npm install evil-pkg").installs).toHaveLength(1);
      expect(analyzeShellCommand("time -p npm install evil-pkg").installs).toHaveLength(1);
      expect(analyzeShellCommand("command -p npm install evil-pkg").installs).toHaveLength(1);
    });

    it("fails closed when env split-string embeds a package-manager command", () => {
      for (const command of [
        "env -S 'npm install evil-pkg'",
        "env --split-string='pnpm add evil-pkg'"
      ]) {
        const analysis = analyzeShellCommand(command);
        expect(analysis.installs, command).toEqual([]);
        expect(analysis.unanalyzable, command).toHaveLength(1);
        expect(present(analysis.unanalyzable[0]).reason, command).toContain("split-string");
      }
    });

    it("fails closed on unknown wrapper options before an install", () => {
      const analysis = analyzeShellCommand("sudo --future-option value npm install evil-pkg");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(present(analysis.unanalyzable[0]).reason).toContain("wrapper option");
    });

    it("does not mistake command lookup mode for command execution", () => {
      const analysis = analyzeShellCommand("command -v npm");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("sees through corepack and drops it from the rewrite", () => {
      const plain = analyzeShellCommand("corepack pnpm add axios");
      expect(plain.installs).toHaveLength(1);
      expect(plain.rewrittenCommand).toBe("safeinstall pnpm add axios");

      const versioned = analyzeShellCommand("corepack pnpm@9 add axios");
      expect(versioned.installs).toHaveLength(1);
      expect(versioned.rewrittenCommand).toBe("safeinstall pnpm add axios");
    });

    it("detects installs behind value-taking directory flags", () => {
      expect(analyzeShellCommand("pnpm --dir packages/app add evil-pkg").installs).toEqual([
        { manager: "pnpm", command: "add", segmentText: "pnpm --dir packages/app add evil-pkg" }
      ]);
      expect(analyzeShellCommand("npm --workspace app install evil-pkg").installs).toHaveLength(1);
    });

    it("resolves path-qualified package manager binaries", () => {
      const analysis = analyzeShellCommand("/usr/local/bin/npm install axios");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("safeinstall npm install axios");
    });

    it("resolves Windows launcher extensions", () => {
      expect(analyzeShellCommand("npm.cmd install axios").installs).toEqual([
        { manager: "npm", command: "install", segmentText: "npm.cmd install axios" }
      ]);
      expect(analyzeShellCommand("pnpm.exe add zod").installs).toHaveLength(1);
    });

    it("keeps manager flags before the subcommand", () => {
      const analysis = analyzeShellCommand("pnpm -C packages/app install");
      expect(analysis.installs).toEqual([
        { manager: "pnpm", command: "install", segmentText: "pnpm -C packages/app install" }
      ]);
      expect(analysis.rewrittenCommand).toBe("safeinstall pnpm -C packages/app install");
    });

    it("handles redirections without treating targets as packages", () => {
      const analysis = analyzeShellCommand("npm install axios > install.log 2>&1");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("safeinstall npm install axios > install.log 2>&1");
    });

    it("detects installs after leading redirections, including numeric file descriptors", () => {
      expect(analyzeShellCommand(">out npm install evil-pkg").rewrittenCommand).toBe(
        ">out safeinstall npm install evil-pkg"
      );
      expect(analyzeShellCommand("< in pnpm add evil-pkg").installs).toHaveLength(1);
      expect(analyzeShellCommand("2>err npm install evil-pkg").rewrittenCommand).toBe(
        "2>err safeinstall npm install evil-pkg"
      );
      expect(analyzeShellCommand("{audit}>out npm install evil-pkg").rewrittenCommand).toBe(
        "{audit}>out safeinstall npm install evil-pkg"
      );
    });

    it("normalizes case-insensitive manager and wrapper names in safe rewrites", () => {
      expect(analyzeShellCommand("NPM install evil-pkg").rewrittenCommand).toBe(
        "safeinstall npm install evil-pkg"
      );
      expect(analyzeShellCommand("SUDO PNPM add evil-pkg").rewrittenCommand).toBe(
        "SUDO safeinstall pnpm add evil-pkg"
      );
    });

    it("handles pipes", () => {
      const analysis = analyzeShellCommand("npm install axios | tee install.log");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe("safeinstall npm install axios | tee install.log");
    });

    it("handles quoted arguments", () => {
      const analysis = analyzeShellCommand('npm install "@scope/pkg@^1.0.0"');
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBe('safeinstall npm install "@scope/pkg@^1.0.0"');
    });
  });

  describe("fail-closed on unanalyzable install segments", () => {
    it("flags command substitution in install arguments", () => {
      const analysis = analyzeShellCommand("npm install $(cat packages.txt)");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBeUndefined();
    });

    it("flags backtick substitution mentioning a package manager", () => {
      const analysis = analyzeShellCommand("`echo npm` install evil-pkg");
      expect(analysis.unanalyzable).toHaveLength(1);
    });

    it("flags variable expansion in install arguments", () => {
      const analysis = analyzeShellCommand("npm install $PKG");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(present(analysis.unanalyzable[0]).reason).toContain("variable expansion");
    });

    it("allows env-assignment prefixes containing expansions", () => {
      const analysis = analyzeShellCommand("TOKEN=$NPM_TOKEN npm install axios");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("flags installs hidden in nested shells", () => {
      const analysis = analyzeShellCommand('bash -c "npm install evil-pkg"');
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(present(analysis.unanalyzable[0]).reason).toContain("nested shell");
    });

    it("ignores nested shells without install hints", () => {
      const analysis = analyzeShellCommand('bash -c "echo hello"');
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("flags yarn installs as unsupported", () => {
      for (const command of ["yarn", "yarn install", "yarn add axios", "yarn global add pkg"]) {
        const analysis = analyzeShellCommand(command);
        expect(analysis.unanalyzable, command).toHaveLength(1);
        expect(present(analysis.unanalyzable[0]).reason, command).toContain("yarn");
      }
    });

    it("ignores non-install yarn commands", () => {
      const analysis = analyzeShellCommand("yarn run build");
      expect(analysis.unanalyzable).toEqual([]);
    });

    it("classifies create/init subcommands that fetch templates as remote runners", () => {
      for (const command of [
        "npm create vite@latest",
        "npm init foo",
        "pnpm create vite",
        "yarn create foo",
        "bun create react-app"
      ]) {
        const analysis = analyzeShellCommand(command);
        expect(analysis.runners, command).toHaveLength(1);
        expect(present(analysis.runners[0]).fetchesRemote, command).toBe(true);
      }

      expect(analyzeShellCommand("npm init").runners).toEqual([]);
    });

    it("flags install aliases hidden behind unknown value-taking flags", () => {
      const analysis = analyzeShellCommand("pnpm --some-future-flag value add evil-pkg");
      expect(analysis.installs).toEqual([]);
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(present(analysis.unanalyzable[0]).reason).toContain('"add"');
    });

    it("does not flag install aliases owned by non-install subcommands", () => {
      expect(analyzeShellCommand("npm run add").unanalyzable).toEqual([]);
      expect(analyzeShellCommand("pnpm exec install-tool").unanalyzable).toEqual([]);
      expect(analyzeShellCommand("npm view add").unanalyzable).toEqual([]);
    });

    it("suppresses the rewrite when any segment is unanalyzable", () => {
      const analysis = analyzeShellCommand("npm install axios && npm install $PKG");
      expect(analysis.installs).toHaveLength(1);
      expect(analysis.unanalyzable).toHaveLength(1);
      expect(analysis.rewrittenCommand).toBeUndefined();
    });
  });
});
