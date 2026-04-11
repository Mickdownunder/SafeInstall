import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const projectRoot = path.resolve(__dirname, "..");
export const cliPath = path.join(projectRoot, "dist", "cli.js");
const tscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
let buildPromise: Promise<void> | undefined;

const tempDirs: string[] = [];

export async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
}

export async function ensureBuiltCli(): Promise<void> {
  if (buildPromise) {
    await buildPromise;
    return;
  }

  buildPromise = (async () => {
    try {
      await stat(cliPath);
      return;
    } catch {
      await execFileAsync(process.execPath, [tscPath, "-p", "tsconfig.build.json"], {
        cwd: projectRoot
      });
    }
  })();

  await buildPromise;
}

export async function runCli(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cacheDir = await createTempDir("safeinstall-cli-cache-");

  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: {
        ...options.env,
        SAFEINSTALL_CACHE_DIR: options.env?.SAFEINSTALL_CACHE_DIR ?? cacheDir
      }
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: 0
    };
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? "",
      code: execError.code ?? null
    };
  }
}

export async function spawnCli(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{
  child: ReturnType<typeof spawn>;
  result: Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const cacheDir = await createTempDir("safeinstall-cli-cache-");
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      SAFEINSTALL_CACHE_DIR: options.env?.SAFEINSTALL_CACHE_DIR ?? cacheDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const result = new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => {
        resolve({
          stdout,
          stderr,
          code,
          signal
        });
      });
    }
  );

  return { child, result };
}

export async function createStubPackageManager(
  name: "npm" | "pnpm",
  behavior?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    script?: string;
  }
): Promise<{ dir: string; logPath: string }> {
  const dir = await createTempDir(`safeinstall-stub-${name}-`);
  const logPath = path.join(dir, `${name}.args.log`);
  const scriptPath = path.join(dir, name);
  const stdout = behavior?.stdout ?? "";
  const stderr = behavior?.stderr ?? "";
  const exitCode = behavior?.exitCode ?? 0;

  const script =
    behavior?.script ??
    `#!/bin/sh
printf '%s\n' "$@" > "${logPath}"
${stdout ? `printf '%s\\n' ${JSON.stringify(stdout)}\n` : ""}${stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2\n` : ""}exit ${exitCode}
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await stat(scriptPath);

  return { dir, logPath };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function mkdirp(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readLoggedArgs(logPath: string): Promise<string[]> {
  return (await readFile(logPath, "utf8")).trim().split("\n");
}

export async function writeDefaultConfig(
  cwd: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await writeJson(path.join(cwd, "safeinstall.config.json"), {
    minimumReleaseAgeHours: 0,
    registryUrl: "https://registry.npmjs.org",
    allowedScripts: {},
    allowedSources: ["registry"],
    allowedPackages: [],
    ciMode: false,
    packageManagerDefaults: {
      npm: { ignoreScripts: true },
      pnpm: { ignoreScripts: true },
      bun: { ignoreScripts: true }
    },
    typoSquat: {
      mode: "off",
      minNameLength: 4,
      ignore: []
    },
    provenance: {
      mode: "off",
      requireFor: [],
      trustedPublishers: {},
      offlineBehavior: "fail-closed"
    },
    ...overrides
  });
}
