import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  cleanupTempDirs,
  createStubPackageManager,
  createTempDir,
  projectRoot,
  readLoggedArgs,
  writeStubExecutable
} from "./cli-e2e-helpers";

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

async function actionSafeInstallStub() {
  const dir = await createTempDir("safeinstall-action-cli-");
  const logPath = path.join(dir, "safeinstall.args.log");
  await writeStubExecutable(
    dir,
    "safeinstall",
    `const args = process.argv.slice(2);
require("node:fs").writeFileSync(${JSON.stringify(logPath)}, args.join("\\n") + "\\n");
process.stdout.write(${JSON.stringify('{"decision":"allow","summary":"Policy passed."}\n')});
`
  );
  if (process.platform === "win32") {
    // The Action step runs under bash, which does not resolve the .cmd shim by
    // its bare name. Give it a sh wrapper, as the npm stub above does.
    const portable = (file: string) => file.split(path.sep).join("/");
    await writeFile(path.join(dir, "safeinstall"), `#!/bin/sh
exec "${portable(process.execPath)}" "${portable(path.join(dir, "safeinstall-stub.js"))}" "$@"
`, { mode: 0o755 });
  }
  return { dir, logPath };
}

async function runActionPolicyStep(
  cwd: string,
  env: Record<string, string>
) {
  const action = parse(await readFile(path.join(projectRoot, "action.yml"), "utf8")) as {
    runs: { steps: Array<{ name: string; run?: string }> };
  };
  const step = action.runs.steps.find(entry => entry.name === "Run SafeInstall")!;
  const bash = process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe")
    : "bash";
  return exec(bash, ["-c", step.run!], { cwd, env: { ...process.env, ...env } });
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

  it.each(["--config /tmp/weak.json", "--config=/tmp/weak.json"])(
    "rejects config overrides in install args: %s",
    async args => {
      const cwd = await createTempDir("safeinstall-action-config-reject-");
      const stub = await actionSafeInstallStub();

      await expect(
        runActionPolicyStep(cwd, {
          PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`,
          SAFEINSTALL_MODE: "install",
          SAFEINSTALL_PM: "pnpm",
          SAFEINSTALL_ARGS: args,
          SAFEINSTALL_CONFIG: "safeinstall.config.json",
          GITHUB_OUTPUT: path.join(cwd, "output"),
          GITHUB_STEP_SUMMARY: path.join(cwd, "summary")
        })
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("args must not contain --config")
      });
      await expect(access(stub.logPath)).rejects.toThrow();
    }
  );

  it("passes the dedicated config and ordinary install args as separate argv entries", async () => {
    const cwd = await createTempDir("safeinstall-action-config-argv-");
    const stub = await actionSafeInstallStub();
    const configPath = path.join(cwd, "policy files", "safeinstall.config.json");

    await runActionPolicyStep(cwd, {
      PATH: `${stub.dir}${path.delimiter}${process.env.PATH ?? ""}`,
      SAFEINSTALL_MODE: "install",
      SAFEINSTALL_PM: "pnpm",
      SAFEINSTALL_ARGS: "--frozen-lockfile --offline",
      SAFEINSTALL_CONFIG: configPath,
      GITHUB_OUTPUT: path.join(cwd, "output"),
      GITHUB_STEP_SUMMARY: path.join(cwd, "summary")
    });

    expect(await readLoggedArgs(stub.logPath)).toEqual([
      "--json",
      "--config",
      configPath,
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--offline"
    ]);
  });
});
