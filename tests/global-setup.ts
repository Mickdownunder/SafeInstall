import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Build the CLI once, before any test file runs. Test files run in separate
 * worker processes; when each of them built `dist/` on demand, one worker
 * could execute a half-written `dist/cli.js` while another was still
 * compiling, and an unrelated end-to-end test failed with exit code 1.
 *
 * An existing `dist/` is kept as is, matching `ensureBuiltCli`.
 */
export default function setup(): void {
  const projectRoot = path.resolve(__dirname, "..");
  if (process.env.SAFEINSTALL_TEST_CLI_PATH || existsSync(path.join(projectRoot, "dist", "cli.js"))) {
    return;
  }
  execFileSync(
    process.execPath,
    [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: projectRoot, stdio: "inherit" }
  );
}
