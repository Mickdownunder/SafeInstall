import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  computeTrustSurfaceDrift,
  detectHiddenUnicode,
  findTrustContext,
  isTrustSurfacePath,
  normalizeHiddenUnicode,
  parseMcpServers,
  snapshotTrustSurface
} from "../src/trust-surface";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";

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
    expect(servers[0].unpinned).toBe(false);
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

describe("isTrustSurfacePath", () => {
  it("matches protected files and the .safeinstall dir, not unrelated files", () => {
    const root = "/project";
    expect(isTrustSurfacePath(root, "/project/safeinstall.config.json")).toBe(true);
    expect(isTrustSurfacePath(root, "/project/.cursor/hooks.json")).toBe(true);
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

  it("finds a lock at the repository root from a subdirectory", async () => {
    const repo = await createTempDir("safeinstall-ctx-");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await lockAt(repo);
    const sub = path.join(repo, "packages", "app");
    await mkdir(sub, { recursive: true });

    const context = await findTrustContext(sub);
    expect(context).toEqual({ root: repo, hasLock: true });
  });

  it("does not inherit the trust context of an enclosing checkout (.git directory)", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const nested = path.join(outer, "vendor", "nested-repo");
    await mkdir(path.join(nested, ".git"), { recursive: true });

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

  it("still finds a lock in an enclosing directory when no repo boundary intervenes", async () => {
    const outer = await createTempDir("safeinstall-ctx-");
    await lockAt(outer);
    const sub = path.join(outer, "some", "plain", "dir");
    await mkdir(sub, { recursive: true });

    const context = await findTrustContext(sub);
    expect(context).toEqual({ root: outer, hasLock: true });
  });
});
