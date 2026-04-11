import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const packDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-pack-"));
  const installDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-install-"));

  try {
    await execFileAsync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: projectRoot
    });

    const tarballs = (await readdir(packDir)).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`Expected exactly one tarball from pnpm pack, found ${tarballs.length}.`);
    }

    const tarballPath = path.join(packDir, tarballs[0]);

    await execFileAsync("npm", ["init", "-y"], {
      cwd: installDir
    });

    await execFileAsync("npm", ["install", tarballPath], {
      cwd: installDir
    });

    const initResult = await execFileAsync(
      process.execPath,
      [path.join(installDir, "node_modules", ".bin", "safeinstall"), "init", "--json"],
      {
        cwd: installDir
      }
    );
    const initPayload = JSON.parse(initResult.stdout);

    if (initPayload.decision !== "allow" || initPayload.mode !== "init") {
      throw new Error("Installed CLI failed the init smoke test.");
    }

    const configPath = path.join(installDir, "safeinstall.config.json");
    const configContents = await readFile(configPath, "utf8");
    if (!configContents.includes("\"minimumReleaseAgeHours\": 72")) {
      throw new Error("Installed CLI created an unexpected starter config.");
    }

    let blocked = false;
    try {
      await execFileAsync(
        process.execPath,
        [
          path.join(installDir, "node_modules", ".bin", "safeinstall"),
          "--json",
          "npm",
          "install",
          "github:axios/axios"
        ],
        {
          cwd: installDir
        }
      );
    } catch (error) {
      const execError = error;
      const stdout = typeof execError?.stdout === "string" ? execError.stdout : "";
      const payload = stdout ? JSON.parse(stdout) : undefined;

      if (payload?.decision === "block" && payload?.exitCode === 2) {
        blocked = true;
      } else {
        throw error;
      }
    }

    if (!blocked) {
      throw new Error("Installed CLI failed to block a git install during the smoke test.");
    }

    console.log(`Smoke test passed for ${path.basename(tarballPath)}.`);
  } finally {
    await rm(packDir, { recursive: true, force: true });
    await rm(installDir, { recursive: true, force: true });
  }
}

void main();
