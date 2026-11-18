import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { detectHiddenUnicode, normalizeHiddenUnicode } from "../src/hidden-unicode";
import { parseMcpServers } from "../src/mcp-server-parse";
import {
  computeTrustSurfaceDrift,
  findTrustContext,
  isTrustSurfacePath,
  snapshotTrustSurface
} from "../src/trust-surface";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";
import { present } from "./helpers/present";

afterAll(async () => {
  await cleanupTempDirs();
});

let stateDir: string;

beforeEach(async () => {
  stateDir = await createTempDir("safeinstall-state-");
  process.env.SAFEINSTALL_STATE_DIR = stateDir;
});

describe("detectHiddenUnicode", () => {
  it("finds zero-width, bidi, and tag characters", () => {
    expect(detectHiddenUnicode("normal")).toEqual([]);
    expect(detectHiddenUnicode("a\u200bb")).toEqual(["U+200B"]);
    expect(detectHiddenUnicode("a\u202eb")).toEqual(["U+202E"]);
    expect(detectHiddenUnicode("run\u{e0041}\u{e0042}")).toEqual(["U+E0041", "U+E0042"]);
  });

  it("tracks real bidi/zero-width controls but not benign formatting characters", () => {
    // ARABIC LETTER MARK — the third implicit bidi direction, previously missed.
    expect(detectHiddenUnicode("a\u061cb")).toEqual(["U+061C"]);
    expect(detectHiddenUnicode("a\u00adb")).toEqual([]); // soft hyphen: benign (Word/PDF paste), deliberately not tracked
    expect(detectHiddenUnicode("a\u2028b")).toEqual([]); // line separator: benign (JSON.stringify emits raw), not tracked
    expect(detectHiddenUnicode("a\u206ab")).toEqual([]); // deprecated formatting control: not an injection vector, not tracked
  });

  it("ignores a leading byte-order mark but reports later ones", () => {
    expect(detectHiddenUnicode("\ufeffhello")).toEqual([]);
    expect(detectHiddenUnicode("hi\ufeffthere")).toEqual(["U+FEFF"]);
  });
});

describe("normalizeHiddenUnicode", () => {
  it("removes hidden characters so normalized hashes ignore invisible edits", () => {
    expect(normalizeHiddenUnicode("a\u200b\u202eb")).toBe("ab");
    expect(normalizeHiddenUnicode("\ufeffclean")).toBe("clean");
  });
});

describe("parseMcpServers", () => {
  it("extracts servers with env key names but no values, and flags unpinned runners", () => {
    const json = JSON.stringify({
      mcpServers: {
        github: { command: "docker", args: ["run", "mcp/github"], env: { GITHUB_TOKEN: "secret" } },
        floaty: { command: "npx", args: ["-y", "evil-mcp"] },
        pinned: { command: "npx", args: ["-y", "good-mcp@1.2.3"] }
      }
    });
    const servers = parseMcpServers(".cursor/mcp.json", json);

    const github = servers.find((server) => server.name === "github");
    expect(github?.envKeys).toEqual(["GITHUB_TOKEN"]);
    expect(github?.unpinned).toBe(false);
    expect(JSON.stringify(servers)).not.toContain("secret");

    expect(servers.find((server) => server.name === "floaty")?.unpinned).toBe(true);
    expect(servers.find((server) => server.name === "pinned")?.unpinned).toBe(false);
  });

  it("treats semver RANGES as unpinned, not just tags (rug-pull)", () => {
    const json = JSON.stringify({
      mcpServers: {
        caret: { command: "npx", args: ["-y", "m@^1.0.0"] },
        tilde: { command: "npx", args: ["-y", "m@~1.0.0"] },
        star: { command: "npx", args: ["-y", "m@*"] },
        xrange: { command: "npx", args: ["-y", "m@1.x"] },
        exact: { command: "npx", args: ["-y", "m@1.0.0"] }
      }
    });
    const servers = parseMcpServers(".mcp.json", json);
    const byName = new Map(servers.map((server) => [server.name, server.unpinned]));
    expect(byName.get("caret")).toBe(true);
    expect(byName.get("tilde")).toBe(true);
    expect(byName.get("star")).toBe(true);
    expect(byName.get("xrange")).toBe(true);
    expect(byName.get("exact")).toBe(false);
  });

  it("resolves the spec past value-taking runner flags", () => {
    const json = JSON.stringify({
      mcpServers: { s: { command: "npx", args: ["--package", "real-pkg@2.0.0", "bin"] } }
    });
    const servers = parseMcpServers(".mcp.json", json);
    // real-pkg@2.0.0 is an exact pin, so this must NOT be flagged unpinned;
    // a naive firstPositional would have grabbed "real-pkg@2.0.0" or "bin".
    expect(present(servers[0]).unpinned).toBe(false);
  });

  it.each([
    // The value of an option the parser does not know must not pass as the package.
    [["--cache", "cache@1.2.3", "floating-mcp"], true],
    [["--registry", "r@1.0.0", "floating-mcp"], true],
    [["--userconfig", "rc@1.0.0", "floating-mcp@latest"], true],
    // An attached value is unambiguous, and known boolean options are skipped.
    [["--cache=/tmp/c", "good-mcp@1.2.3"], false],
    [["-y", "--prefer-offline", "good-mcp@1.2.3"], false],
    [["--", "good-mcp@1.2.3"], false],
    [["--", "floating-mcp"], true],
    // Every requested package has to be pinned, not only the first.
    [["--package", "a@1.0.0", "--package", "floating", "bin"], true],
    [["-p", "a@1.0.0", "-p", "b@2.0.0", "bin"], false],
    [["--package=a@1.0.0", "bin"], false]
  ])("decides whether npx %j is unpinned", (args, unpinned) => {
    const servers = parseMcpServers(".mcp.json", JSON.stringify({ mcpServers: { s: { command: "npx", args } } }));
    expect(present(servers[0]).unpinned).toBe(unpinned);
  });

  it("reads the package of a uvx --from invocation", () => {
    const unpinned = (args: string[]): boolean =>
      present(parseMcpServers(".mcp.json", JSON.stringify({ mcpServers: { s: { command: "uvx", args } } }))[0]).unpinned;

    expect(unpinned(["--from", "tool@1.2.3", "tool"])).toBe(false);
    expect(unpinned(["--from", "tool", "tool"])).toBe(true);
  });

  it("treats a full SemVer 2.0 pin (prerelease + build metadata) as pinned", () => {
    const json = JSON.stringify({
      mcpServers: {
        rc: { command: "npx", args: ["-y", "m@1.2.3-rc.1+build.7"] },
        alpha: { command: "npx", args: ["-y", "@scope/m@1.0.0-alpha+001"] }
      }
    });
    const byName = new Map(parseMcpServers(".mcp.json", json).map((server) => [server.name, server.unpinned]));
    expect(byName.get("rc")).toBe(false);
    expect(byName.get("alpha")).toBe(false);
  });

  it("returns nothing for malformed or server-less configs", () => {
    expect(parseMcpServers("x", "not json")).toEqual([]);
    expect(parseMcpServers("x", JSON.stringify({ other: true }))).toEqual([]);
  });
});

describe("snapshotTrustSurface + computeTrustSurfaceDrift", () => {
  async function seedProject(): Promise<string> {
    const root = await createTempDir("safeinstall-trust-");
    await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
    await writeFile(path.join(root, "AGENTS.md"), "# rules\n");
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));
    await writeFile(path.join(root, ".codex", "config.toml"), "[features]\nhooks = true\n");
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "rules", "main.md"), "be good\n");
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"] } } })
    );
    return root;
  }

  it("snapshots enforcement, instruction (incl. rules glob), and tool files", async () => {
    const root = await seedProject();
    const snapshot = await snapshotTrustSurface(root);
    const paths = snapshot.files.map((file) => file.path).sort();
    expect(paths).toContain("safeinstall.config.json");
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain(".codex/hooks.json");
    expect(paths).toContain(".codex/config.toml");
    expect(paths).toContain(".cursor/rules/main.md");
    expect(snapshot.mcpServers.map((server) => server.name)).toContain("gh");
  });

  it("reports a clean drift when nothing changed", async () => {
    const root = await seedProject();
    const snapshot = await snapshotTrustSurface(root);
    const drift = computeTrustSurfaceDrift(snapshot, snapshot);
    expect(drift.clean).toBe(true);
  });

  it("detects modified, added, and removed files", async () => {
    const root = await seedProject();
    const baseline = await snapshotTrustSurface(root);

    await writeFile(path.join(root, "safeinstall.config.json"), '{"minimumReleaseAgeHours":0}\n');
    await writeFile(path.join(root, "CLAUDE.md"), "new file\n");
    const next = await snapshotTrustSurface(root);

    const drift = computeTrustSurfaceDrift(baseline, next);
    expect(drift.clean).toBe(false);
    const byPath = new Map(drift.files.map((entry) => [entry.path, entry.change]));
    expect(byPath.get("safeinstall.config.json")).toBe("modified");
    expect(byPath.get("CLAUDE.md")).toBe("added");
  });

  it("flags newly introduced hidden Unicode against the baseline", async () => {
    const root = await seedProject();
    const baseline = await snapshotTrustSurface(root);

    await writeFile(path.join(root, "AGENTS.md"), "# rules\nignore\u202eprevious\n");
    const next = await snapshotTrustSurface(root);

    const drift = computeTrustSurfaceDrift(baseline, next);
    expect(drift.newHiddenUnicode).toEqual([{ path: "AGENTS.md", codes: ["U+202E"] }]);
  });

  it("detects a newly added MCP server", async () => {
    const root = await seedProject();
    const baseline = await snapshotTrustSurface(root);

    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"] },
          evil: { command: "npx", args: ["-y", "evil-mcp"] }
        }
      })
    );
    const next = await snapshotTrustSurface(root);

    const drift = computeTrustSurfaceDrift(baseline, next);
    const added = drift.mcpServers.find((entry) => entry.name === "evil");
    expect(added?.change).toBe("added");
    expect(added?.unpinned).toBe(true);
  });
});

describe("nested instruction files", () => {
  const run = promisify(execFile);

  async function put(root: string, relativePath: string, content = "x\n"): Promise<void> {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const INCLUDED = [
    ".claude/CLAUDE.md",
    ".claude/rules/style.md",
    ".cursorrules",
    "AGENTS.md",
    "a/b/.cursor/rules/r.mdc",
    "docs/deep/er/CLAUDE.md",
    "packages/app/.cursorrules",
    "packages/app/AGENTS.md",
    "sub/CLAUDE.md"
  ];
  const EXCLUDED = [
    "node_modules/pkg/AGENTS.md",
    "packages/app/node_modules/dep/CLAUDE.md",
    "docs/CLAUDE.md.bak",
    "packages/app/README.md",
    "sub/.github/copilot-instructions.md",
    "sub/.cursor/mcp.json",
    "a/b/.cursor/rules"
  ];

  async function instructionPaths(root: string): Promise<string[]> {
    const snapshot = await snapshotTrustSurface(root);
    return snapshot.files
      .filter((file) => file.kind === "instruction")
      .map((file) => file.path)
      .sort();
  }

  it("finds nested instruction files outside a git repository with the bounded walk", async () => {
    const root = await createTempDir("safeinstall-nested-walk-");
    for (const file of [...INCLUDED, ...EXCLUDED.filter((file) => file !== "a/b/.cursor/rules")]) {
      await put(root, file);
    }
    await put(root, ".hidden/AGENTS.md");
    expect(await instructionPaths(root)).toEqual([...INCLUDED].sort());
  });

  it("finds tracked and untracked nested files in a git repository, skipping ignored and deleted ones", async () => {
    const root = await createTempDir("safeinstall-nested-git-");
    await run("git", ["init", "-q"], { cwd: root });
    await put(root, ".gitignore", "ignored/\n");
    for (const file of INCLUDED) {
      await put(root, file);
    }
    for (const file of EXCLUDED.filter((entry) => entry !== "a/b/.cursor/rules")) {
      await put(root, file);
    }
    await put(root, "ignored/AGENTS.md");
    await put(root, "gone/AGENTS.md");
    // Track some files, leave the rest (a brand-new sub/AGENTS.md among them) untracked.
    await run("git", ["add", "packages/app/AGENTS.md", "gone/AGENTS.md"], { cwd: root });
    await rm(path.join(root, "gone"), { recursive: true });

    expect(await instructionPaths(root)).toEqual([...INCLUDED].sort());
  });

  it("finds instruction files inside a checked-out submodule and an embedded checkout", async () => {
    const identity = ["-c", "user.email=fixture@safeinstall.test", "-c", "user.name=Fixture"];
    const upstream = await createTempDir("safeinstall-nested-upstream-");
    await run("git", ["init", "-q"], { cwd: upstream });
    await put(upstream, "AGENTS.md", "# tracked in the submodule\n");
    await put(upstream, "docs/CLAUDE.md");
    await run("git", ["add", "-A"], { cwd: upstream });
    await run("git", [...identity, "commit", "-qm", "init"], { cwd: upstream });

    const root = await createTempDir("safeinstall-nested-submodule-");
    await run("git", ["init", "-q"], { cwd: root });
    await run(
      "git",
      [...identity, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "packages/app"],
      { cwd: root }
    );
    // Untracked inside the submodule: the parent listing shows neither file.
    await put(root, "packages/app/sub/.cursorrules");
    // An embedded checkout that the parent repository does not track at all.
    await put(root, "vendor/tool/AGENTS.md");
    await run("git", ["init", "-q"], { cwd: path.join(root, "vendor", "tool") });

    expect(await instructionPaths(root)).toEqual([
      "packages/app/AGENTS.md",
      "packages/app/docs/CLAUDE.md",
      "packages/app/sub/.cursorrules",
      "vendor/tool/AGENTS.md"
    ]);
  });

  it("flags hidden Unicode in a nested instruction file as a hard finding", async () => {
    const root = await createTempDir("safeinstall-nested-unicode-");
    await put(root, "packages/app/AGENTS.md", "# ok\n");
    const baseline = await snapshotTrustSurface(root);
    await put(root, "packages/app/AGENTS.md", "# ok\nignore‮previous\n");
    const drift = computeTrustSurfaceDrift(baseline, await snapshotTrustSurface(root));
    expect(drift.newHiddenUnicode).toEqual([{ path: "packages/app/AGENTS.md", codes: ["U+202E"] }]);
    expect(drift.files).toEqual([{ path: "packages/app/AGENTS.md", kind: "instruction", change: "modified" }]);
  });

  it("matches nested members by path shape without touching the filesystem", () => {
    const root = "/project";
    for (const file of INCLUDED) {
      expect(isTrustSurfacePath(root, `/project/${file}`), file).toBe(true);
    }
    expect(isTrustSurfacePath(root, "/project/a/b/.cursor/rules")).toBe(true);
    for (const file of EXCLUDED.filter((entry) => entry !== "a/b/.cursor/rules")) {
      expect(isTrustSurfacePath(root, `/project/${file}`), file).toBe(false);
    }
    expect(isTrustSurfacePath(root, "/project/.git/AGENTS.md")).toBe(false);
    expect(isTrustSurfacePath(root, "/tmp/AGENTS.md")).toBe(false);
    expect(isTrustSurfacePath(root, "/projectx/AGENTS.md")).toBe(false);
  });
});

describe("isTrustSurfacePath", () => {
  it("matches protected files and the .safeinstall dir, not unrelated files", () => {
    const root = "/project";
    expect(isTrustSurfacePath(root, "/project/safeinstall.config.json")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.cursor/hooks.json")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.codex/hooks.json")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.codex/config.toml")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.cursor/rules/x.md")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.github/workflows/safeinstall-trust.yml")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.safeinstall/trust-surface.lock")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/src/index.ts")).toBe(false);
    expect(isTrustSurfacePath(root, "/etc/passwd")).toBe(false);
  });
});

describe("findTrustContext", () => {
  async function lockAt(root: string): Promise<void> {
    await mkdir(path.join(root, ".safeinstall"), { recursive: true });
    await writeFile(path.join(root, ".safeinstall", "trust-surface.lock"), "{}\n");
  }

  async function initGit(dir: string): Promise<void> {
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }

  it("finds a lock at the repository root from a subdirectory", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    await lockAt(repo);
    const sub = path.join(repo, "packages", "app");
    await mkdir(sub, { recursive: true });

    const context = await findTrustContext(sub);
    expect(context).toEqual({ root: repo, hasLock: true });
  });

  it("reports a nested lock next to the repository-root lock as ambiguous, never picking one", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    await lockAt(repo);
    const sub = path.join(repo, "packages", "app");
    await lockAt(sub);

    const context = await findTrustContext(sub);
    expect(context?.conflictingRoots).toEqual([sub, repo]);
    // From the root only the root lock is on the path.
    expect(await findTrustContext(repo)).toEqual({ root: repo, hasLock: true });
  });

  it("treats a lone subfolder lock as authoritative (project living in a repo subfolder)", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    const sub = path.join(repo, "frontend");
    await lockAt(sub);
    const deeper = path.join(sub, "src");
    await mkdir(deeper, { recursive: true });

    expect(await findTrustContext(sub)).toEqual({ root: sub, hasLock: true });
    expect(await findTrustContext(deeper)).toEqual({ root: sub, hasLock: true });
  });

  it("does not let an empty .git directory next to a fake nested lock hide the root lock", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    await lockAt(repo);
    const sub = path.join(repo, "packages", "app");
    await lockAt(sub);
    await mkdir(path.join(sub, ".git"), { recursive: true });

    const context = await findTrustContext(sub);
    expect(context?.conflictingRoots).toEqual([sub, repo]);
  });

  it("ignores .git entries that are not a real checkout (empty dir, bogus file)", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    await lockAt(repo);
    const a = path.join(repo, "a");
    await mkdir(path.join(a, ".git"), { recursive: true });
    const b = path.join(repo, "b");
    await mkdir(b, { recursive: true });
    await writeFile(path.join(b, ".git"), "not a gitdir pointer\n");

    expect(await findTrustContext(a)).toEqual({ root: repo, hasLock: true });
    expect(await findTrustContext(b)).toEqual({ root: repo, hasLock: true });
  });

  it("documented limit: a real git init inside a locked repository is an independent checkout", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await initGit(repo);
    await lockAt(repo);
    const inner = path.join(repo, "vendor", "inner");
    await initGit(inner);
    await lockAt(inner);

    expect(await findTrustContext(inner)).toEqual({ root: inner, hasLock: true });
  });

  it("does not inherit the trust context of an enclosing checkout (.git directory)", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const nested = path.join(outer, "vendor", "nested-repo");
    await initGit(nested);

    expect(await findTrustContext(nested)).toBeUndefined();
  });

  it("does not inherit the trust context of an enclosing checkout (.git file, worktree layout)", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const worktree = path.join(outer, ".claude", "worktrees", "wt");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), "gitdir: /elsewhere\n");

    expect(await findTrustContext(worktree)).toBeUndefined();
  });

  it("uses a nested checkout's own lock", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const nested = path.join(outer, "vendor", "nested-repo");
    await initGit(nested);
    await lockAt(nested);
    const sub = path.join(nested, "packages", "app");
    await mkdir(sub, { recursive: true });

    expect(await findTrustContext(sub)).toEqual({ root: nested, hasLock: true });
  });

  it("still finds a lock in an enclosing directory when no repo boundary intervenes", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const sub = path.join(outer, "some", "plain", "dir");
    await mkdir(sub, { recursive: true });

    const context = await findTrustContext(sub);
    expect(context).toEqual({ root: outer, hasLock: true });
  });
});
