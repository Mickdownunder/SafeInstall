import { createHash } from "node:crypto";
import path from "node:path";

import type { TrustSurfaceMcpServer } from "./trust-surface";

/**
 * MCP-server declaration parsing for the Agent Trust Surface. An MCP server the
 * agent launches is code the agent trusts; a floating version spec is a standing
 * rug-pull (the server code can change upstream with no config drift). This
 * module extracts the tracked identity of every declared server — a content
 * hash, its env-var keys, and whether its version floats — from an `mcpServers`
 * config block. Kept separate from trust-surface.ts so the runner-spec parsing
 * (npx/uvx/pnpm dlx and their flag grammar) is reviewable in isolation.
 *
 * `sha256` and `isRecord` are re-declared locally rather than shared: the
 * codebase deliberately keeps these one-line helpers file-local (sha256 appears
 * in trust-ledger, decision-*, git-blob, disk-cache; isRecord in guard-setup),
 * and importing them from trust-surface.ts would create a value-import cycle.
 */

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flags that name a package to resolve, per runner. They are not
 * interchangeable: `npx --from=a@1.2.3 floating` ignores `--from` and
 * resolves `floating`, so a flag only counts for the runner that defines it.
 */
const NODE_RUNNER_PACKAGE_FLAGS: ReadonlySet<string> = new Set(["-p", "--package"]);
const UVX_PACKAGE_FLAGS: ReadonlySet<string> = new Set(["--from", "--with"]);
/** Runner flags that consume the following token as their value. */
const RUNNER_VALUE_FLAGS = new Set(["-c", "--call", "--shell", "--cwd"]);
/** Runner flags known to take no value. */
const RUNNER_BOOLEAN_FLAGS = new Set([
  "-y", "--yes", "--no", "-q", "--quiet", "--no-install", "--ignore-existing",
  "--offline", "--prefer-offline", "--prefer-online", "--bun"
]);

/**
 * The package specs a runner would resolve, or undefined when the arguments
 * cannot be read with certainty. Explicit `-p/--package <spec>` options name
 * the packages and all of them count; otherwise it is the first positional
 * argument, skipping flags and the values of value-taking flags (so
 * `--shell bash pkg` resolves to `pkg`, not `bash`).
 *
 * A separate-value option this parser does not know could consume the next
 * token (`--cache cache@1.2.3 floating`), so the exact-looking token after it
 * proves nothing: the result is undefined and the caller treats the server as
 * unpinned. `--option=value` is unambiguous and skipped.
 */
function runnerSpecs(args: string[], packageFlags: ReadonlySet<string>): string[] | undefined {
  const packages: string[] = [];
  let positional: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      positional = args[index + 1];
      break;
    }
    if (packageFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return undefined;
      }
      packages.push(value);
      index += 1;
      continue;
    }
    const attached = [...packageFlags].find((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`));
    if (attached) {
      packages.push(arg.slice(attached.length + 1));
      continue;
    }
    if (arg.startsWith("-")) {
      if (arg.includes("=") || RUNNER_BOOLEAN_FLAGS.has(arg)) {
        continue;
      }
      if (RUNNER_VALUE_FLAGS.has(arg)) {
        index += 1;
        continue;
      }
      return undefined;
    }
    positional = arg;
    break;
  }
  if (packages.length > 0) {
    return packages;
  }
  return positional === undefined ? undefined : [positional];
}

/**
 * True when a runner package spec floats — the server code can change
 * upstream without any config drift (the MCP rug-pull). Only an EXACT semver
 * pin (1.2.3, optionally with prerelease/build) counts as pinned; tags
 * (`latest`, `next`), ranges (`^1`, `~1`, `1.x`, `*`, `>=1`), and a bare name
 * are all floating.
 */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isFloatingSpec(spec: string): boolean {
  const searchFrom = spec.startsWith("@") ? spec.indexOf("/") + 1 : 1;
  const atIndex = spec.indexOf("@", Math.max(searchFrom, 1));
  if (atIndex === -1) {
    return true;
  }
  return !EXACT_SEMVER.test(spec.slice(atIndex + 1).trim());
}

const RUNNER_BINARIES = new Set(["npx", "uvx", "bunx", "pnpx"]);

function isUnpinnedMcpServer(command: string | undefined, args: string[]): boolean {
  if (!command) {
    return false;
  }
  const binary = path.basename(command).toLowerCase().replace(/\.(cmd|exe)$/, "");
  let specs: string[] | undefined;
  if (RUNNER_BINARIES.has(binary)) {
    specs = runnerSpecs(args, binary === "uvx" ? UVX_PACKAGE_FLAGS : NODE_RUNNER_PACKAGE_FLAGS);
  } else if ((binary === "pnpm" || binary === "yarn") && args[0] === "dlx") {
    specs = runnerSpecs(args.slice(1), NODE_RUNNER_PACKAGE_FLAGS);
  } else {
    return false;
  }
  return specs === undefined || specs.some(isFloatingSpec);
}

/** Parse the `mcpServers` block of one config file into tracked entries. */
export function parseMcpServers(source: string, rawJson: string): TrustSurfaceMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return [];
  }

  const servers: TrustSurfaceMcpServer[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(value)) {
      continue;
    }
    const command = typeof value.command === "string" ? value.command : undefined;
    const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
    const url = typeof value.url === "string" ? value.url : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    const envKeys = isRecord(value.env) ? Object.keys(value.env).sort() : [];

    servers.push({
      name,
      source,
      commandHash: sha256(JSON.stringify({ command: command ?? null, args, url: url ?? null, type: type ?? null })),
      envKeys,
      unpinned: isUnpinnedMcpServer(command, args)
    });
  }
  return servers.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}
