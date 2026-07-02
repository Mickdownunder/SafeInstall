import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A stable, old publish date served by the registry fixture. Old enough that
 * any minimumReleaseAgeHours check passes, so age is deterministic.
 */
const FIXTURE_PUBLISH_DATE = "Mon, 01 Jan 2018 00:00:00 GMT";

export interface RegistryFixture {
  url: string;
  close: () => Promise<void>;
}

/**
 * A local stand-in for the npm registry so end-to-end install tests never
 * touch the network (the real registry is the flake source). It serves any
 * package/version generically: a packument with a couple of versions, a
 * version manifest with no lifecycle scripts, and a tarball HEAD carrying an
 * old last-modified date. Set as the config's registryUrl via
 * SAFEINSTALL_TEST_REGISTRY (loopback http, which the CLI allows without a
 * warning, so stderr assertions still hold).
 */
export async function startRegistryFixture(): Promise<RegistryFixture> {
  const server: Server = createServer((req, res) => {
    const requestUrl = decodeURIComponent((req.url ?? "/").split("?")[0]);

    // Tarball request (HEAD or GET): only the last-modified header matters.
    if (requestUrl.includes("/-/")) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "last-modified": FIXTURE_PUBLISH_DATE
      });
      res.end();
      return;
    }

    const segments = requestUrl.split("/").filter(Boolean);
    const name = segments[0];
    const version = segments[1];
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    if (name && version) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          version,
          dist: { tarball: `${base}/${name}/-/${name}-${version}.tgz` },
          scripts: {}
        })
      );
      return;
    }

    if (name) {
      const versions = ["1.13.2", "1.14.0"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          "dist-tags": { latest: "1.14.0" },
          versions: Object.fromEntries(
            versions.map((entry) => [
              entry,
              { version: entry, dist: { tarball: `${base}/${name}/-/${name}-${entry}.tgz` } }
            ])
          ),
          time: Object.fromEntries(versions.map((entry) => [entry, "2018-01-01T00:00:00.000Z"]))
        })
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

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

/**
 * Wait for a spawned child process to emit a specific string on stderr.
 * Rejects if the pattern does not appear within the timeout, with the
 * full stderr buffer in the error message for diagnostics. Coexists
 * with the stderr listener that `spawnCli` already attached; both see
 * all data chunks.
 */
export function waitForStderr(
  child: ReturnType<typeof spawn>,
  pattern: string,
  timeoutMs = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.includes(pattern)) {
        cleanup();
        resolve();
      }
    };

    const onClose = () => {
      cleanup();
      if (buffer.includes(pattern)) {
        resolve();
      } else {
        reject(
          new Error(
            `Child process exited before stderr contained "${pattern}". Buffered stderr:\n${buffer}`
          )
        );
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for stderr to contain "${pattern}". Buffered stderr:\n${buffer}`
        )
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("close", onClose);
    };

    child.stderr?.on("data", onData);
    child.on("close", onClose);
  });
}

export async function writeDefaultConfig(
  cwd: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await writeJson(path.join(cwd, "safeinstall.config.json"), {
    minimumReleaseAgeHours: 0,
    // Default to the local fixture when a test started one (hermetic, no
    // network); fall back to the public registry otherwise.
    registryUrl: process.env.SAFEINSTALL_TEST_REGISTRY ?? "https://registry.npmjs.org",
    allowedScripts: {},
    allowedSources: ["registry"],
    allowedPackages: [],
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
    transitive: {
      mode: "off",
      checks: ["install-script", "untrusted-source"]
    },
    continuity: {
      mode: "off",
      baselineSize: 5
    },
    ...overrides
  });
}
