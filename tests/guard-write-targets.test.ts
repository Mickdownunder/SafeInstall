import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decideGuard } from "../src/guard-flow";
import { runTrustLockFlow } from "../src/trust-flow";
import { cleanupTempDirs, createTempDir } from "./cli-e2e-helpers";

/**
 * Write targets are resolved against the shell's effective working directory
 * and matched, as paths or patterns, against the Agent Trust Surface. Each row
 * is one shell command with its expected guard decision under an active lock.
 */

let root: string;
let link: string;

beforeAll(async () => {
  process.env.SAFEINSTALL_STATE_DIR = await createTempDir("safeinstall-state-");
  root = await realpath(await createTempDir("safeinstall-write-targets-"));
  for (const directory of ["sub", "src", "docs", ".claude", ".cursor", "node_modules"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, "safeinstall.config.json"), "{}\n");
  await writeFile(path.join(root, ".claude", "settings.json"), "{}\n");
  await writeFile(path.join(root, ".mcp.json"), "{}\n");
  await writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify({ version: 1 }));
  await writeFile(path.join(root, "AGENTS.md"), "# rules\n");
  await runTrustLockFlow(root, ["trust", "lock"]);
  if (process.platform !== "win32") {
    link = path.join(await createTempDir("safeinstall-write-link-"), "alias");
    await symlink(root, link);
  }
});

afterAll(async () => {
  await cleanupTempDirs();
});

const DENIED: string[] = [
  // Plain cwd tracking.
  "cd .claude && rm settings.json",
  "cd .claude; rm settings.json",
  "cd .claude\necho {} > settings.json",
  "cd sub && echo x > ../.mcp.json",
  "cd sub/../.claude && rm settings.json",
  "cd .safeinstall && rm -f trust-surface.lock",
  "pushd .claude && echo {} > settings.json",
  "cd .claude; cd -; echo x > settings.json",
  'cd "$PWD/.claude" && echo {} > settings.json',
  "cd $(pwd)/.claude && echo {} > settings.json",
  "env -C .claude tee settings.json",
  "env --chdir=.claude tee settings.json",
  "builtin cd .claude && rm settings.json",
  "command cd .claude && rm settings.json",
  "if cd .claude; then echo {} > settings.json; fi",
  "for d in .claude; do cd $d; echo {} > settings.json; done",
  "cat > .mcp.json <<EOF\n{}\nEOF",
  "cd .claude && echo x | tee settings.json",
  // Groups.
  "(cd .claude && echo {} > settings.json)",
  "{ cd .claude; echo {} > settings.json; }",
  "cd .claude && ( rm settings.json )",
  "(cd sub; (cd ..; echo x > .mcp.json))",
  // The cd effect inside a group that is part of a pipeline.
  "echo x | (cd .claude && tee settings.json)",
  "echo x | (cd .claude; tee settings.json)",
  "echo x | { cd .claude; tee settings.json; }",
  "true | { cd .claude; rm settings.json; }",
  "echo x | (cd .claude && cat > settings.json)",
  // A command word that could be cd, aliases, function bodies, case arms.
  "cd${IFS}.claude; rm settings.json",
  "c=cd; $c .claude && rm settings.json",
  "c=cd; ${c} .claude && rm settings.json",
  "$(echo cd) .claude && rm settings.json",
  "alias x='cd .claude'; x; rm settings.json",
  "f() { cd .claude; }; f; echo x > settings.json",
  "function f { cd .claude; }; f; echo x > settings.json",
  "case x in x) cd .claude;; esac; echo x > settings.json",
  // Globs that can reach the surface.
  "rm -rf *",
  "rm -rf .*",
  "rm *",
  "echo x > .mcp.jso?",
  "rm .claude/set*",
  "rm -f .c[l]aude/settings.json",
  // Whole directories and their parents.
  "rm -rf .claude",
  "rm -r ./.safeinstall/",
  "rm -rf .safeinstall",
  "rm -rf .cursor",
  "mv .claude x",
  "cd sub && rm -rf ../.claude",
  // sed in place, long form.
  "sed --in-place s/a/b/ .mcp.json",
  "sed --in-place=.bak s/a/b/ AGENTS.md",
  // Unresolved expansions next to a literal protected name.
  "echo x > $X/.mcp.json",
  "echo x > .claude/$F",
  'echo x > "$D/settings.json"',
  "rm $DIR/trust-surface.lock",
  "echo x > .safeinstall/$(date).json",
  // An expansion can be empty, so the literal remainder may already be the protected path.
  "echo x > .mcp.json$EMPTY",
  "echo x > .claude/$E/settings.json",
  "echo x > .mcp$E.json",
  // Unknown cwd followed by a relative target that could be protected from somewhere.
  "cd $DIR && rm settings.json",
  "source x && echo {} > .mcp.json",
  "cd $D && rm trust-surface.lock",
  "cd $D && echo x > AGENTS.md",
  "cd $(mktemp -d) && echo x > settings.json",
  // Nested instruction files, at any depth.
  "echo x > packages/app/AGENTS.md",
  "cd packages/app && echo x > CLAUDE.md",
  "cd sub && echo x > AGENTS.md",
  "cd sub && echo x > .cursorrules",
  "rm sub/.cursorrules",
  "echo x > a/b/.cursor/rules/r.mdc",
  "cd a/b/.cursor/rules && echo x > r.mdc",
  "rm -rf packages/app/.cursor",
  "rm -rf packages/*/.cursor",
  "echo x > $X/CLAUDE.md",
  "echo x > packages/*/AGENTS.md",
  "rm packages/app/AGENTS.m?",
  "sed -i s/a/b/ packages/app/CLAUDE.md",
  "echo x > .claude/CLAUDE.md",
  "echo x > .claude/rules/style.md",
  "rm -rf .claude/rules",
  // A copy or move into a directory writes <directory>/<name of the source>.
  "cp /tmp/evil/settings.json .claude/",
  "cp /tmp/evil/settings.json .claude",
  "cp /tmp/evil/.mcp.json .",
  "cp /tmp/evil/safeinstall.config.json ./",
  "cp -t .claude /tmp/evil/settings.json",
  "cp --target-directory=.claude /tmp/evil/settings.json",
  "cp --target-directory .claude /tmp/evil/settings.json",
  "cp /tmp/evil/a.txt /tmp/evil/AGENTS.md sub/",
  "cp /tmp/evil/* .claude/",
  "cp $SRC .claude/",
  "cd .claude && cp /tmp/evil/settings.json .",
  "mv /tmp/evil/AGENTS.md sub/",
  "mv /tmp/evil/CLAUDE.md packages/app",
  "mv -t sub /tmp/evil/.cursorrules",
  "install -m 644 /tmp/evil/settings.json .claude/",
  "install /tmp/evil/settings.json .claude/settings.json",
  "install -t .claude /tmp/evil/settings.json",
  // A recursive copy writes a whole subtree below its destination.
  "cp -r /tmp/evil/.claude .",
  "cp -R /tmp/evil/ .claude",
  "cp -a /tmp/evil/. .",
  "cp --recursive /tmp/evil/.cursor sub"
];

const ALLOWED: string[] = [
  // Nested paths and other directories are not protected.
  "cd /tmp && echo x > settings.json",
  "cd sub && echo x > .mcp.json",
  "cd sub && echo x > safeinstall.config.json",
  "echo x > packages/app/README.md",
  "echo x > node_modules/pkg/AGENTS.md",
  "cd node_modules && echo x > AGENTS.md",
  "echo x > /tmp/AGENTS.md",
  "cat packages/app/AGENTS.md",
  "echo x > docs/CLAUDE.md.bak",
  "echo x > sub/.cursor/mcp.json",
  "rm -rf packages/*",
  "echo x > packages/*/README.md",
  "cd src && echo x > notes.txt",
  "cd sub && rm -rf node_modules",
  "cd docs && sed -i s/a/b/ README.md",
  "cd .claude && ls",
  "cd .claude && cat settings.json",
  'git commit -m "wip: cd .claude && rm settings.json"',
  "cat .claude/settings.json",
  "cd src && cd .. && echo ok > build.stamp",
  // Home, PWD and TMPDIR resolve.
  "echo hi > ~/x",
  "echo hi > $HOME/x",
  "echo hi > ${HOME}/x",
  "echo hi > $PWD/out.txt",
  "echo hi > ${PWD}/out.txt",
  "echo hi > $TMPDIR/x",
  "echo hi > /tmp/y",
  "cd ~/proj && echo x > settings.json",
  "rm -rf $TMPDIR/foo",
  // Globs that cannot match a protected path.
  "rm *.log",
  "rm -rf dist/*",
  "rm -rf ./tmp-*",
  "cp -r src/* build/",
  "cp [ab].txt dest/",
  "rm file[12].txt",
  "echo test > file?.txt",
  // Unresolvable expansions without a protected literal part.
  "echo x > $OUT",
  'echo x > "$LOG"',
  'echo x > "$(mktemp)"',
  "echo x > /tmp/$(date +%s).txt",
  'echo x > "out-$(date +%F).txt"',
  'sed -i s/a/b/ "$FILE"',
  "tee >(cat)",
  "for f in *.txt; do echo $f > out/$f; done",
  "for i in 1 2 3; do echo $i > out$i.txt; done",
  // Unknown cwd followed by a target that cannot be protected.
  "cd $DIR && echo hi > out.txt",
  'cd "$(mktemp -d)" && echo x > a.txt',
  "cd /tmp && cd - && echo x > out.txt",
  "time cd sub && echo x > a",
  ". ./env.sh && echo x > out.txt",
  "source .env && echo x > out.txt",
  // Groups keep their cd to themselves.
  "(cd sub && echo x > out.txt)",
  "{ cd sub; echo x > out.txt; }",
  "echo x | (cd sub && cat > out.txt)",
  "(cd .claude); echo x > out.txt",
  // Copies and moves whose destination file is not protected.
  "cp /tmp/a.txt .",
  "cp /tmp/a.txt sub/",
  "cp /tmp/evil/settings.json sub/",
  "cp /tmp/evil/.mcp.json sub",
  "cp src/a.txt src/b.txt docs/",
  "cp -r docs docs2",
  "cp -r /tmp/assets sub/",
  "mv /tmp/a.txt sub/",
  "mv /tmp/a.txt sub/b.txt",
  "install -d build/out",
  "install -m 755 /tmp/tool sub/"
];

describe("guard write targets under an active trust lock", () => {
  it.each(DENIED)("denies %j", async (command) => {
    const decision = await decideGuard(command, root);
    expect(decision.action, command).toBe("deny");
  });

  it.each(ALLOWED)("allows %j", async (command) => {
    expect(await decideGuard(command, root), command).toEqual({ action: "allow" });
  });

  it("resolves the event cwd when it is below the root", async () => {
    expect((await decideGuard("cd .. && echo x > .mcp.json", path.join(root, "sub"))).action).toBe("deny");
    expect((await decideGuard("echo x > ../.mcp.json", path.join(root, "sub"))).action).toBe("deny");
    expect((await decideGuard("cd .. && echo x > a.txt", path.join(root, "sub"))).action).toBe("allow");
  });

  it("says whether a target is protected or only could be", async () => {
    const exact = await decideGuard("echo x > .mcp.json", root);
    expect(exact.userMessage).toContain("protected file");
    const possible = await decideGuard("cd $DIR && rm settings.json", root);
    expect(possible.userMessage).toContain("could not be resolved safely");
  });

  it.skipIf(process.platform === "win32")("compares real paths through a symlinked alias of the root", async () => {
    for (const command of [
      `cd ${link}/.claude && rm settings.json`,
      `cd ${link} && echo x > .mcp.json`,
      `echo x > ${link}/.mcp.json`
    ]) {
      expect((await decideGuard(command, root)).action, command).toBe("deny");
    }
    expect((await decideGuard("echo x > .mcp.json", link)).action).toBe("deny");
    expect((await decideGuard("cd .claude && rm settings.json", link)).action).toBe("deny");
    expect(await decideGuard(`cd ${link}/sub && echo x > .mcp.json`, root)).toEqual({ action: "allow" });
  });

  // The lock is found from the hook event's cwd. A write that reaches a locked
  // project from a cwd outside of it has to be judged by that project's lock.
  describe("from a working directory outside the locked project", () => {
    it.each([
      "rm ROOT/.mcp.json",
      "echo x > ROOT/safeinstall.config.json",
      "cd ROOT && rm .mcp.json",
      "cd ROOT/.claude && echo {} > settings.json",
      "cd ROOT/sub && echo x > ../AGENTS.md",
      "rm -rf ROOT/.safeinstall"
    ])("denies %j", async (template) => {
      const outside = await realpath(await createTempDir("safeinstall-write-outside-"));
      const command = template.replace("ROOT", root);
      expect((await decideGuard(command, outside)).action, command).toBe("deny");
    });

    it("leaves other writes alone", async () => {
      const outside = await realpath(await createTempDir("safeinstall-write-outside-"));
      expect(await decideGuard(`echo x > ${root}/sub/notes.txt`, outside)).toEqual({ action: "allow" });
      expect(await decideGuard("echo x > .mcp.json", outside)).toEqual({ action: "allow" });
    });
  });

  // A `.git` file is a checkout boundary only when the directory it points
  // to is a git directory; otherwise anyone could end the lock's scope.
  it("is not stopped by a .git file that points nowhere", async () => {
    const planted = path.join(root, "planted");
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(planted, ".git"), "gitdir: /nonexistent/safeinstall-git-dir\n");

    for (const command of ["rm ../.mcp.json", `rm ${root}/.mcp.json`, `echo x > ${root}/safeinstall.config.json`]) {
      expect((await decideGuard(command, planted)).action, command).toBe("deny");
    }
  });
});
