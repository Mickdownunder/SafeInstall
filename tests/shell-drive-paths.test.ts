import { describe, expect, it } from "vitest";

import { nativeShellPath, shellDrivePrefix } from "../src/shell-drive-paths";

describe("drive paths as Git Bash and Cygwin spell them", () => {
  it.each([
    ["/c/Users/dev/.mcp.json", "C:/Users/dev/.mcp.json"],
    ["/d/", "D:/"],
    ["/c", "C:/"],
    ["/cygdrive/e/work/AGENTS.md", "E:/work/AGENTS.md"],
    ["/C/Users", "C:/Users"]
  ])("reads %j as %j on Windows", (shell, native) => {
    expect(nativeShellPath(shell, "win32")).toBe(native);
  });

  it.each(["/cc/x", "/usr/bin", "c/Users", "C:/Users", "./c/x", "/cygdrive", "/c.txt"])(
    "leaves %j alone on Windows",
    (value) => {
      expect(nativeShellPath(value, "win32")).toBe(value);
    }
  );

  it("changes nothing on other platforms, where /c is a directory", () => {
    expect(nativeShellPath("/c/Users", "linux")).toBe("/c/Users");
    expect(nativeShellPath("/cygdrive/c/x", "darwin")).toBe("/cygdrive/c/x");
    expect(shellDrivePrefix("/c/x", "linux")).toBeUndefined();
  });

  it("reports the length of the drive spelling", () => {
    expect(shellDrivePrefix("/c/x", "win32")).toEqual({ length: 3, letter: "C" });
    expect(shellDrivePrefix("/cygdrive/d/x", "win32")).toEqual({ length: 12, letter: "D" });
  });
});
