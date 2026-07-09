import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  planPackageManagerSpawn,
  WindowsCmdArgumentError,
  WindowsCommandResolutionError
} from "../src/win32-spawn";

/**
 * The planner takes the platform as an injectable parameter, so the win32
 * resolution and command-line construction logic is asserted on every OS.
 * PATH strings use ";" (the win32 delimiter, hardcoded in the planner), and
 * the actual candidate files live in real temp directories on the host fs.
 */

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

async function createBinDir(files: string[]): Promise<string> {
  const dir = await createTempDir("safeinstall-win32-spawn-");
  await Promise.all(files.map((file) => writeFile(path.join(dir, file), "")));
  return dir;
}

const PATHEXT_DEFAULT = ".COM;.EXE;.BAT;.CMD";

describe("planPackageManagerSpawn on POSIX", () => {
  it("is the identity: same command, same args, no verbatim flag", () => {
    const args = ["add", "axios@^1.2.3", "--ignore-scripts"];
    const plan = planPackageManagerSpawn("pnpm", args, { PATH: "/usr/bin" }, "linux");

    expect(plan.file).toBe("pnpm");
    expect(plan.args).toBe(args);
    expect(plan.windowsVerbatimArguments).toBeUndefined();
  });
});

describe("planPackageManagerSpawn on win32", () => {
  it("spawns a resolved .exe directly, without argument restrictions", async () => {
    const dir = await createBinDir(["pnpm.exe"]);
    // Arguments that would be rejected for a .cmd shim are fine for a
    // native executable: no shell is involved.
    const args = ["add", "a package with spaces & metachars %CD%"];
    const plan = planPackageManagerSpawn("pnpm", args, { PATH: dir, PATHEXT: PATHEXT_DEFAULT }, "win32");

    expect(plan.file).toBe(path.resolve(dir, "pnpm.exe"));
    expect(plan.args).toBe(args);
    expect(plan.windowsVerbatimArguments).toBeUndefined();
  });

  it("respects PATHEXT order when both .exe and .cmd exist", async () => {
    const dir = await createBinDir(["pnpm.exe", "pnpm.cmd"]);
    const plan = planPackageManagerSpawn("pnpm", [], { PATH: dir, PATHEXT: PATHEXT_DEFAULT }, "win32");
    expect(plan.file).toBe(path.resolve(dir, "pnpm.exe"));
  });

  it("resolves from the first matching PATH entry", async () => {
    const first = await createBinDir(["npm.cmd"]);
    const second = await createBinDir(["npm.cmd"]);
    const plan = planPackageManagerSpawn(
      "npm",
      [],
      { PATH: `${first};${second}`, PATHEXT: PATHEXT_DEFAULT, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      "win32"
    );
    expect(plan.args[3]).toContain(path.resolve(first, "npm.cmd"));
  });

  it("supports quoted PATH entries", async () => {
    const dir = await createBinDir(["bun.exe"]);
    const plan = planPackageManagerSpawn("bun", [], { PATH: `"${dir}"`, PATHEXT: PATHEXT_DEFAULT }, "win32");
    expect(plan.file).toBe(path.resolve(dir, "bun.exe"));
  });

  it("plans a .cmd shim via cmd.exe /d /s /c with every part individually quoted", async () => {
    const dir = await createBinDir(["npm.cmd"]);
    const comspec = "C:\\Windows\\system32\\cmd.exe";
    const plan = planPackageManagerSpawn(
      "npm",
      ["install", "axios@^1.2.3", "--ignore-scripts"],
      { PATH: dir, PATHEXT: PATHEXT_DEFAULT, ComSpec: comspec },
      "win32"
    );

    const resolved = path.resolve(dir, "npm.cmd");
    expect(plan.file).toBe(comspec);
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      `""${resolved}" "install" "axios@^1.2.3" "--ignore-scripts""`
    ]);
  });

  it("plans a .cmd shim with no arguments as a bare quoted script", async () => {
    const dir = await createBinDir(["npm.cmd"]);
    const plan = planPackageManagerSpawn("npm", [], { PATH: dir, PATHEXT: ".CMD" }, "win32");
    expect(plan.file).toBe("cmd.exe"); // ComSpec default when unset
    expect(plan.args[3]).toBe(`""${path.resolve(dir, "npm.cmd")}""`);
  });

  it.each([
    ["space", "a b"],
    ["double quote", 'a"b'],
    ["ampersand", "a&b"],
    ["pipe", "a|b"],
    ["redirect", "a>b"],
    ["percent expansion", "%CD%"],
    ["delayed expansion", "a!b"],
    ["backslash", "packages\\app"],
    ["empty string", ""],
    ["newline", "a\nb"]
  ])("fails closed on unsafe .cmd argument: %s", async (_label, unsafe) => {
    const dir = await createBinDir(["pnpm.cmd"]);
    const attempt = () =>
      planPackageManagerSpawn("pnpm", ["add", unsafe], { PATH: dir, PATHEXT: ".CMD" }, "win32");

    expect(attempt).toThrow(WindowsCmdArgumentError);
    expect(attempt).toThrow("cannot be passed safely");
  });

  it("fails closed when the resolved shim path contains cmd-active characters", async () => {
    const parent = await createTempDir("safeinstall-win32-pct-");
    const dir = path.join(parent, "has%percent");
    await mkdir(dir);
    await writeFile(path.join(dir, "pnpm.cmd"), "");

    expect(() => planPackageManagerSpawn("pnpm", ["add"], { PATH: dir, PATHEXT: ".CMD" }, "win32")).toThrow(
      WindowsCmdArgumentError
    );
  });

  it("throws a resolution error with code ENOENT when nothing matches", () => {
    const attempt = () => planPackageManagerSpawn("pnpm", [], { PATH: "" }, "win32");
    expect(attempt).toThrow(WindowsCommandResolutionError);
    try {
      attempt();
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  it("does not treat unknown PATHEXT entries (.ps1, .js) as executable", async () => {
    const dir = await createBinDir(["pnpm.ps1", "pnpm.js"]);
    expect(() =>
      planPackageManagerSpawn("pnpm", [], { PATH: dir, PATHEXT: ".PS1;.JS;.CMD" }, "win32")
    ).toThrow(WindowsCommandResolutionError);
  });

  it("reads PATH and PATHEXT case-insensitively", async () => {
    const dir = await createBinDir(["npm.cmd"]);
    const plan = planPackageManagerSpawn("npm", [], { Path: dir, PathExt: ".CMD" }, "win32");
    expect(plan.args[3]).toContain(path.resolve(dir, "npm.cmd"));
  });

  it("prefers the exact-case env key over an inherited variant", async () => {
    const empty = await createBinDir([]);
    const real = await createBinDir(["npm.cmd"]);
    // `{ ...process.env, PATH: override }` on Windows can leave both `Path`
    // (inherited) and `PATH` (override) on the object; the override must win.
    const plan = planPackageManagerSpawn("npm", [], { Path: empty, PATH: real, PATHEXT: ".CMD" }, "win32");
    expect(plan.args[3]).toContain(path.resolve(real, "npm.cmd"));
  });

  it("refuses commands that look like paths", () => {
    expect(() => planPackageManagerSpawn("tools/pnpm", [], { PATH: "" }, "win32")).toThrow(
      WindowsCmdArgumentError
    );
    expect(() => planPackageManagerSpawn("tools\\pnpm", [], { PATH: "" }, "win32")).toThrow(
      WindowsCmdArgumentError
    );
  });
});
