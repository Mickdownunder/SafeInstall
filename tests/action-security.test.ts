import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { cleanupTempDirs, createStubPackageManager, createTempDir, projectRoot, readLoggedArgs } from "./cli-e2e-helpers";

const exec = promisify(execFile);
afterAll(cleanupTempDirs);

async function actionNpmStub() {
  const stub = await createStubPackageManager("npm");
  if (process.platform === "win32") {
    const portable = (file: string) => file.split(path.sep).join("/");
    await writeFile(path.join(stub.dir, "npm"), `#!/bin/sh
exec "${portable(process.execPath)}" "${portable(path.join(stub.dir, "npm-stub.js"))}" "$@"
`, { mode: 0o755 });
  }
  return stub;
}

describe("GitHub Action install input boundary", () => {
  it.each(["substitution", "quote-breakout", "backticks"])("passes %s as data, not shell code", async attack => {
    const cwd = await createTempDir("safeinstall-action-security-");
    const marker = path.join(cwd, "injected").split(path.sep).join("/");
    const payload = attack === "substitution" ? `0.15.0$(touch ${marker})` :
      attack === "quote-breakout" ? `0.15.0"; touch ${marker}; #` :
        "0.15.0" + String.fromCharCode(96) + "touch " + marker + String.fromCharCode(96);
    const action = parse(await readFile(path.join(projectRoot, "action.yml"), "utf8")) as {
      runs: { steps: Array<{ name: string; run?: string; env?: Record<string, string> }> };
    };
    const step = action.runs.steps.find(entry => entry.name === "Install SafeInstall CLI")!;
    const stub = await actionNpmStub();
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) =>
      [key, value.replace("${{ inputs.version }}", payload)]));
    const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe") : "bash";
    await expect(exec(bash, ["-c", step.run!.replace("${{ inputs.version }}", payload)], {
      cwd, env: { ...process.env, ...env, PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}` }
    })).rejects.toMatchObject({ code: 2 });
    await expect(access(marker)).rejects.toThrow();
    await expect(access(stub.logPath)).rejects.toThrow();
  });

  it.each(["latest", "0.15.0", "0.15.0-rc.1"])("accepts a literal version or tag: %s", async version => {
    const action = parse(await readFile(path.join(projectRoot, "action.yml"), "utf8")) as {
      runs: { steps: Array<{ name: string; run?: string }> };
    };
    const step = action.runs.steps.find(entry => entry.name === "Install SafeInstall CLI")!;
    const stub = await actionNpmStub();
    const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe") : "bash";
    await exec(bash, ["-c", step.run!], { env: { ...process.env, SAFEINSTALL_CLI_VERSION: version,
      PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}` } });
    expect(await readLoggedArgs(stub.logPath)).toEqual(["install", "-g", `safeinstall-cli@${version}`, "--ignore-scripts"]);
  });
});
