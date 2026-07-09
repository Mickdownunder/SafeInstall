import { statSync } from "node:fs";
import path from "node:path";

/**
 * Windows-safe spawn planning for package managers (CVE-2024-27980 /
 * "BatBadBut").
 *
 * On Windows, npm and pnpm ship as `.cmd` batch shims. Since the
 * CVE-2024-27980 patches, Node throws EINVAL when `spawn()` resolves to a
 * `.cmd`/`.bat` file without `shell: true`, because batch files are always
 * executed by `cmd.exe` and cmd's command-line parsing makes generic argument
 * escaping unsafe. Using `shell: true` is not acceptable in a security
 * product: it routes *every* argument through cmd.exe's parser, where
 * metacharacters (`&`, `|`, `<`, `>`, `%`, `!`, `^`, `"`) can inject
 * commands or silently rewrite arguments.
 *
 * This module takes the fail-closed route instead of the escape-everything one:
 *
 * 1. Resolve the command against PATH + PATHEXT ourselves (libuv would do the
 *    same search, but we need to know *what kind* of file we found before
 *    deciding how to run it). Only files are considered; the working
 *    directory is deliberately never searched (no current-directory binary
 *    planting, unlike raw CreateProcess semantics).
 * 2. `.exe`/`.com` — spawn the resolved absolute path directly with
 *    `shell: false`. No shell is involved; Node quotes arguments per MSVCRT
 *    argv rules, which is safe for native executables.
 * 3. `.cmd`/`.bat` — run via `cmd.exe /d /s /c`, but ONLY when every argument
 *    matches a strict allowlist (see SAFE_CMD_ARG_PATTERN). Anything else is
 *    rejected with a clear error — blocked, never silently degraded.
 *
 * On POSIX platforms `planPackageManagerSpawn` is the identity: the caller
 * spawns exactly what it spawns today.
 */

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Only set for the cmd.exe path, where we build the command line ourselves. */
  windowsVerbatimArguments?: boolean;
}

/** The command could not be resolved on PATH. `code` mirrors spawn's ENOENT. */
export class WindowsCommandResolutionError extends Error {
  readonly code = "ENOENT";

  constructor(command: string) {
    super(`Command "${command}" was not found in PATH (searched with PATHEXT).`);
    this.name = "WindowsCommandResolutionError";
  }
}

/** An argument (or the resolved script path) cannot be passed safely to cmd.exe. */
export class WindowsCmdArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsCmdArgumentError";
  }
}

/**
 * Allowlist for arguments forwarded to a `.cmd`/`.bat` shim.
 *
 * Each argument is placed on the cmd.exe command line wrapped in double
 * quotes. Inside a double-quoted span, cmd treats `&`, `|`, `<`, `>`, `^`,
 * `(`, `)` and spaces as literal text, so the caret in semver ranges like
 * `axios@^1.2.3` survives. Only three characters stay "active" inside
 * quotes and are therefore banned outright:
 *
 * - `"`  — would close our quoted span and re-enable every metacharacter.
 * - `%`  — cmd expands `%VAR%` regardless of quoting.
 * - `!`  — expanded when delayed expansion is on; it is off by default, but
 *          a machine-wide registry setting (Command Processor\DelayedExpansion)
 *          can enable it, so we do not rely on the default.
 *
 * Additionally banned:
 * - `\`  — a trailing backslash would escape our closing quote under the
 *          MSVCRT argv parsing of the final node.exe process (`\"` becomes a
 *          literal quote), merging adjacent arguments. Forward slashes work
 *          in every npm/pnpm/bun path argument, so nothing of value is lost.
 * - whitespace and control characters — argument splitting / line termination.
 *
 * What remains covers real package-manager usage: package names and scopes
 * (`@scope/name`), semver specs (`axios@^1.2.3`, `~1.0.0`, `npm:alias@1.2.3`),
 * flags (`-D`, `--ignore-scripts`, `--prefix=packages/app`), and relative
 * paths with forward slashes (`./packages/local`).
 */
const SAFE_CMD_ARG_PATTERN = /^[A-Za-z0-9._@/:=^~+-]+$/;

/** Human-readable copy of the pattern for error messages. */
const SAFE_CMD_ARG_DESCRIPTION = "[A-Za-z0-9._@/:=^~+-]";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const DIRECT_SPAWN_EXTENSIONS = new Set([".exe", ".com"]);
const CMD_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

/**
 * Windows environment blocks are case-insensitive and `{ ...process.env,
 * PATH: x }` can produce both `Path` (inherited) and `PATH` (override) keys
 * on a plain object. Prefer the exact key (the deliberate override), then
 * fall back to a case-insensitive scan.
 */
function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) {
    return env[name];
  }

  const lowerName = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowerName) {
      return env[key];
    }
  }

  return undefined;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

interface ResolvedWindowsCommand {
  /** Absolute path to the resolved file. */
  path: string;
  /** Lower-cased extension, e.g. ".cmd". */
  extension: string;
}

/**
 * Emulate the cmd/libuv PATH+PATHEXT search, restricted to extensions we
 * know how to execute safely. PATH is split on ";" (the win32 delimiter —
 * hardcoded, not `path.delimiter`, so the logic stays testable from POSIX)
 * and entries may be quoted, which cmd's own PATH parsing allows.
 */
function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): ResolvedWindowsCommand | undefined {
  const rawPath = getEnvCaseInsensitive(env, "PATH") ?? "";
  const rawPathExt = getEnvCaseInsensitive(env, "PATHEXT") ?? DEFAULT_PATHEXT;

  const extensions = rawPathExt
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => DIRECT_SPAWN_EXTENSIONS.has(extension) || CMD_SHIM_EXTENSIONS.has(extension));

  const directories = rawPath
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(path.join(directory, command + extension));
      if (isFile(candidate)) {
        return { path: candidate, extension };
      }
    }
  }

  return undefined;
}

/**
 * Decide how to spawn a package manager. POSIX: identity (byte-identical to
 * a plain `spawn(command, args)`). Windows: resolve and plan as documented
 * in the module header. `platform` is injectable so the win32 logic is unit
 * tested on every OS; production callers omit it.
 */
export function planPackageManagerSpawn(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): SpawnPlan {
  if (platform !== "win32") {
    return { file: command, args };
  }

  // Callers pass bare manager names (npm/pnpm/bun); a path here would bypass
  // the PATH-only resolution below, so treat it as an internal invariant.
  if (command.includes("/") || command.includes("\\")) {
    throw new WindowsCmdArgumentError(
      `Refusing to spawn ${JSON.stringify(command)} on Windows: expected a bare command name, not a path.`
    );
  }

  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) {
    throw new WindowsCommandResolutionError(command);
  }

  if (DIRECT_SPAWN_EXTENSIONS.has(resolved.extension)) {
    // Native executable: no shell involved, Node's default MSVCRT argument
    // quoting is correct and injection-free.
    return { file: resolved.path, args };
  }

  // Batch shim: every argument must clear the allowlist, or we fail closed.
  const unsafeArg = args.find((arg) => !SAFE_CMD_ARG_PATTERN.test(arg));
  if (unsafeArg !== undefined) {
    throw new WindowsCmdArgumentError(
      `Blocked: argument ${JSON.stringify(unsafeArg)} cannot be passed safely to the Windows ` +
        `${resolved.extension} shim for "${command}". Batch shims run under cmd.exe, where some characters ` +
        `stay active even inside quotes, so SafeInstall only forwards arguments matching ` +
        `${SAFE_CMD_ARG_DESCRIPTION}. Rewrite the argument without the unsupported characters ` +
        `(for example, use forward slashes in paths).`
    );
  }

  // The resolved path is quoted below, so spaces are fine — but `%` and `!`
  // are expanded by cmd even inside quotes, and `"` cannot appear in a
  // Windows file name anyway. An install location that cmd would rewrite is
  // not a location we can execute from safely.
  if (/[%!"\r\n]/.test(resolved.path)) {
    throw new WindowsCmdArgumentError(
      `Blocked: the resolved path ${JSON.stringify(resolved.path)} for "${command}" contains characters ` +
        `cmd.exe treats as active ('%', '!'), so it cannot be executed safely as a batch shim.`
    );
  }

  /**
   * Command-line construction for `cmd.exe /d /s /c`:
   *
   * - `/d` skips AutoRun registry scripts (no third-party code runs before
   *   the shim).
   * - `/s` pins down quote handling: cmd strips exactly the first and last
   *   quote of the string after `/c` and executes what is left. We therefore
   *   wrap the whole command line in one outer quote pair and quote the
   *   script path and every argument individually inside it:
   *
   *       cmd.exe /d /s /c ""C:\...\npm.cmd" "install" "--ignore-scripts""
   *
   *   After the /s strip, cmd executes `"C:\...\npm.cmd" "install" ...` —
   *   the quoted spans keep spaces in the shim path together and neutralize
   *   `& | < > ^ ( )` inside arguments; the allowlist above already banned
   *   the only characters that stay active inside quotes.
   * - `windowsVerbatimArguments: true` makes Node join our four argv entries
   *   with single spaces and NO additional quoting, so the line above reaches
   *   cmd.exe byte-for-byte. Node's default quoting implements MSVCRT rules,
   *   which are wrong for cmd's parser — that mismatch is the root of
   *   BatBadBut, and verbatim mode is how we keep full control here.
   */
  const commandLine = `"${[resolved.path, ...args].map((part) => `"${part}"`).join(" ")}"`;
  const comspec = getEnvCaseInsensitive(env, "ComSpec") ?? "cmd.exe";

  return {
    file: comspec,
    args: ["/d", "/s", "/c", commandLine],
    windowsVerbatimArguments: true
  };
}
