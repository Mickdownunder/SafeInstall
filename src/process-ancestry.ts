import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Look for environment markers in the processes that started this one.
 *
 * A marker such as CLAUDECODE is inherited, so a child can drop it with
 * `env -u` or by spawning a pseudo-terminal from a script that deletes it
 * first. The process that did the dropping, and the agent above it, still
 * carry the marker in their own environment, which the child cannot edit.
 *
 * This is best effort: an ancestor whose environment cannot be read is
 * skipped, a process that detaches from its parents (double fork, a
 * multiplexer server) is not connected to them any more, and Windows is not
 * inspected at all. It raises the cost of faking a human context; it does
 * not prove one.
 */

export interface ProcessInfo {
  parentPid: number;
  /** Environment of the process, or undefined when it cannot be read. */
  env: Record<string, string> | undefined;
}

export type ProcessReader = (pid: number) => ProcessInfo | undefined;

const MAX_ANCESTOR_DEPTH = 64;

export function isActiveMarkerValue(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function parseEnvironBlock(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of block.split("\0")) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return env;
}

function readLinuxProcess(pid: number): ProcessInfo | undefined {
  let parentPid: number;
  try {
    // /proc/<pid>/stat is "pid (comm) state ppid ..."; comm may itself
    // contain spaces and parentheses, so parse from the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    parentPid = Number.parseInt(fields[1] ?? "", 10);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(parentPid)) {
    return undefined;
  }

  let env: Record<string, string> | undefined;
  try {
    env = parseEnvironBlock(readFileSync(`/proc/${pid}/environ`, "utf8"));
  } catch {
    env = undefined;
  }
  return { parentPid, env };
}

function readDarwinProcess(pid: number, markers: readonly string[]): ProcessInfo | undefined {
  const run = (args: string[]): string =>
    execFileSync("/bin/ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });

  let parentPid: number;
  try {
    parentPid = Number.parseInt(run(["-o", "ppid=", "-p", String(pid)]).trim(), 10);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(parentPid)) {
    return undefined;
  }

  let env: Record<string, string> | undefined;
  try {
    // `ps eww` appends the environment to the command line for processes of
    // the same user. It cannot be split reliably, so only the wanted
    // NAME=value tokens are picked out.
    const commandWithEnv = run(["eww", "-o", "command=", "-p", String(pid)]);
    env = {};
    for (const name of markers) {
      const match = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(commandWithEnv);
      if (match) {
        env[name] = match[1] ?? "";
      }
    }
  } catch {
    env = undefined;
  }
  return { parentPid, env };
}

export function defaultProcessReader(markers: readonly string[]): ProcessReader | undefined {
  if (process.platform === "linux") {
    return readLinuxProcess;
  }
  if (process.platform === "darwin") {
    return (pid) => readDarwinProcess(pid, markers);
  }
  return undefined;
}

/**
 * Return the first marker that is active in the environment of an ancestor
 * process, walking up from `startPid` (normally `process.ppid`).
 */
export function findAncestorMarker(
  markers: readonly string[],
  startPid: number = process.ppid,
  reader: ProcessReader | undefined = defaultProcessReader(markers)
): string | undefined {
  if (!reader) {
    return undefined;
  }

  const seen = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid > 1 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const info = reader(pid);
    if (!info) {
      return undefined;
    }
    const env = info.env;
    if (env) {
      const marker = markers.find((name) => isActiveMarkerValue(env[name]));
      if (marker) {
        return marker;
      }
    }
    pid = info.parentPid;
  }
  return undefined;
}
