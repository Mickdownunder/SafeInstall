import { spawn } from "node:child_process";

import { getShutdownSignalError, throwIfAborted } from "./signals";
import { planPackageManagerSpawn, WindowsCommandResolutionError } from "./win32-spawn";
import type { PackageManagerName, SafeInstallConfig } from "./types";

const IGNORE_SCRIPTS_FLAG: Record<PackageManagerName, string> = {
  npm: "--ignore-scripts",
  pnpm: "--ignore-scripts",
  bun: "--ignore-scripts"
};

export interface RunPackageManagerOptions {
  manager: PackageManagerName;
  managerArgs: string[];
  command: string;
  forwardedArgs: string[];
  config: SafeInstallConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  stdio?: "inherit" | "pipe";
}

export interface PackageManagerExecutionResult {
  code: number;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

export function buildPackageManagerCommand(
  manager: PackageManagerName,
  managerArgs: string[],
  command: string,
  forwardedArgs: string[],
  config: SafeInstallConfig
): { command: string; args: string[] } {
  const args = [...managerArgs, command, ...forwardedArgs];
  const ignoreScriptsFlag = IGNORE_SCRIPTS_FLAG[manager];

  if (
    config.packageManagerDefaults[manager].ignoreScripts &&
    !args.includes(ignoreScriptsFlag) &&
    !args.some((arg) => arg.startsWith(`${ignoreScriptsFlag}=`))
  ) {
    args.push(ignoreScriptsFlag);
  }

  return {
    command: manager,
    args
  };
}

export async function runPackageManager(
  options: RunPackageManagerOptions
): Promise<PackageManagerExecutionResult> {
  throwIfAborted(options.signal);

  const built = buildPackageManagerCommand(
    options.manager,
    options.managerArgs,
    options.command,
    options.forwardedArgs,
    options.config
  );

  // On POSIX this is the identity (spawn the manager exactly as before). On
  // Windows it resolves the manager via PATH+PATHEXT and plans a safe spawn:
  // .exe directly, .cmd/.bat via cmd.exe with strictly allowlisted arguments
  // (see win32-spawn.ts). Unsafe arguments throw and fail the install closed.
  let plan: ReturnType<typeof planPackageManagerSpawn>;
  try {
    plan = planPackageManagerSpawn(built.command, built.args, options.env ?? process.env);
  } catch (error) {
    if (error instanceof WindowsCommandResolutionError) {
      // Same message the POSIX path produces when spawn emits ENOENT below.
      throw new Error(`Package manager "${options.manager}" was not found in PATH.`);
    }
    throw error;
  }

  return new Promise<PackageManagerExecutionResult>((resolve, reject) => {
    let settled = false;
    const child = spawn(plan.file, plan.args, {
      stdio: options.stdio ?? "inherit",
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    });

    const onAbort = () => {
      const shutdownError = getShutdownSignalError(options.signal);
      child.kill(shutdownError?.signalName ?? "SIGTERM");
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: PackageManagerExecutionResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    let stdout = "";
    let stderr = "";

    if (options.stdio === "pipe") {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      const shutdownError = getShutdownSignalError(options.signal);
      if (shutdownError) {
        rejectOnce(shutdownError);
        return;
      }

      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectOnce(new Error(`Package manager "${options.manager}" was not found in PATH.`));
        return;
      }

      rejectOnce(error);
    });
    child.on("exit", (code, signal) => {
      const shutdownError = getShutdownSignalError(options.signal);
      if (shutdownError) {
        rejectOnce(shutdownError);
        return;
      }

      if (signal) {
        rejectOnce(new Error(`Package manager exited with signal ${signal}.`));
        return;
      }

      resolveOnce({
        code: code ?? 1,
        stdout: options.stdio === "pipe" ? stdout : undefined,
        stderr: options.stdio === "pipe" ? stderr : undefined
      });
    });
  });
}
