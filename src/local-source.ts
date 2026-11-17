import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { RequestedPackage } from "./types";

/**
 * How a local dependency (`workspace:`, `file:`, `link:`, a directory path or a
 * local tarball) relates to the repository it is declared in.
 *
 * - "member": a first-party workspace package (the `workspace:` protocol, or a
 *   path that is matched by the workspace globs). Never a supply-chain source,
 *   so `allowedSources` does not apply to it.
 * - "directory": any other local directory (inside the repository but not a
 *   workspace member, or outside the repository). Governed by the
 *   `directory` entry of `allowedSources`.
 * - "file": a local tarball or other file. An unverifiable artifact, governed
 *   by the `file` entry of `allowedSources`.
 */
export type LocalSourceClass = "member" | "directory" | "file";

export interface LocalSourceClassification {
  kind: LocalSourceClass;
  /** True when the target resolves outside the repository (or workspace) root. */
  outsideRepository: boolean;
}

const LOCAL_SOURCE_TYPES = new Set<RequestedPackage["sourceType"]>(["workspace", "file", "directory"]);

export function isLocalSourceType(sourceType: RequestedPackage["sourceType"]): boolean {
  return LOCAL_SOURCE_TYPES.has(sourceType);
}

const TARBALL_PATTERN = /\.(tgz|tar\.gz|tar)$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const LOCAL_PROTOCOLS = ["file:", "link:", "portal:", "workspace:"];

/** The manifest specifier of a requested package, without the `name@` prefix. */
export function declaredSpecifier(requested: RequestedPackage): string {
  const prefix = `${requested.name}@`;
  return requested.raw.startsWith(prefix) ? requested.raw.slice(prefix.length) : requested.raw;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** realpath of the nearest existing ancestor, re-joined with the missing tail. */
async function canonicalize(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface WorkspaceRoot {
  dir: string;
  patterns: string[];
}

async function readWorkspacePatterns(dir: string): Promise<string[] | undefined> {
  try {
    const parsed = parseYaml(await readFile(path.join(dir, "pnpm-workspace.yaml"), "utf8")) as {
      packages?: unknown;
    } | null;
    if (parsed && Array.isArray(parsed.packages)) {
      return parsed.packages.filter((entry): entry is string => typeof entry === "string");
    }
    return [];
  } catch {
    // No pnpm-workspace.yaml; try package.json below.
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    const workspaces = manifest.workspaces;
    const list = Array.isArray(workspaces)
      ? workspaces
      : typeof workspaces === "object" &&
          workspaces !== null &&
          Array.isArray((workspaces as { packages?: unknown }).packages)
        ? (workspaces as { packages: unknown[] }).packages
        : undefined;
    return list?.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return undefined;
  }
}

/** Expand `{a,b}` alternatives (nested ones too) into separate patterns. */
function expandBraces(pattern: string): string[] {
  let depth = 0;
  let open = -1;
  const commas: number[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      if (depth === 0) {
        open = index;
        commas.length = 0;
      }
      depth += 1;
    } else if (character === "," && depth === 1) {
      commas.push(index);
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && commas.length > 0) {
        const bounds = [open, ...commas, index];
        const alternatives: string[] = [];
        for (let part = 0; part < bounds.length - 1; part += 1) {
          alternatives.push(pattern.slice((bounds[part] as number) + 1, bounds[part + 1]));
        }
        const prefix = pattern.slice(0, open);
        const suffix = pattern.slice(index + 1);
        return alternatives.flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`));
      }
    }
  }
  return [pattern];
}

/** One path segment of a workspace glob: `*`, `?` and `[...]` classes. */
function segmentToRegExpSource(segment: string): string {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index] as string;
    if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        continue;
      }
      let body = segment.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) {
        body = body.slice(1);
      }
      source += `[${negated ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      index = close;
    } else if (character === "\\" && index + 1 < segment.length) {
      index += 1;
      source += (segment[index] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}

function patternToRegExps(pattern: string): RegExp[] {
  return expandBraces(pattern).map((expanded) => {
    const segments = expanded.split("/").filter((segment) => segment !== "" && segment !== ".");
    let source = "^";
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") {
        source += last ? ".*" : "(?:[^/]+/)*";
        return;
      }
      source += segmentToRegExpSource(segment);
      source += last ? "" : "/";
    });
    return new RegExp(`${source}/?$`);
  });
}

/**
 * Extended glob operators (`+(a|b)`, `@(a)`, `!(a)`) are not modelled. A
 * pattern that uses one cannot make a path a member, and as an exclusion it
 * excludes everything, so an unreadable pattern never grants the exemption
 * from `allowedSources` that membership carries.
 */
const EXTENDED_GLOB = /[@!+*?]\(/;

function matchesWorkspace(patterns: readonly string[], relativePath: string): boolean {
  let member = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (EXTENDED_GLOB.test(body)) {
      if (negated) {
        member = false;
      }
      continue;
    }
    if (patternToRegExps(body).some((regexp) => regexp.test(relativePath))) {
      member = !negated;
    }
  }
  return member;
}

/**
 * Resolves the repository boundary and workspace layout once per evaluation
 * and classifies local dependency specifiers against it.
 */
export class LocalSourceClassifier {
  private context: Promise<{ boundary: string; workspace: WorkspaceRoot | undefined }> | undefined;

  constructor(private readonly projectDir: string) {}

  private async load(): Promise<{ boundary: string; workspace: WorkspaceRoot | undefined }> {
    const start = await canonicalize(this.projectDir);
    let gitRoot: string | undefined;
    let workspace: WorkspaceRoot | undefined;
    let current = start;
    while (true) {
      if (!workspace) {
        const patterns = await readWorkspacePatterns(current);
        if (patterns !== undefined) {
          workspace = { dir: current, patterns };
        }
      }
      if (await exists(path.join(current, ".git"))) {
        gitRoot = current;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    // Do not trust a workspace root that sits above the git root.
    if (gitRoot && workspace && !isInside(gitRoot, workspace.dir)) {
      workspace = undefined;
    }
    return { boundary: gitRoot ?? workspace?.dir ?? start, workspace };
  }

  async classify(requested: RequestedPackage): Promise<LocalSourceClassification | undefined> {
    if (!isLocalSourceType(requested.sourceType)) {
      return undefined;
    }
    let spec = declaredSpecifier(requested).trim();

    const workspaceProtocol = spec.startsWith("workspace:");
    if (workspaceProtocol) {
      spec = spec.slice("workspace:".length);
      // workspace:*, workspace:^1.2.3, workspace:~ resolve only to members.
      if (!/^(?:\.{1,2}[\\/]|\/|~[\\/]|[A-Za-z]:[\\/])/.test(spec)) {
        return { kind: "member", outsideRepository: false };
      }
    }
    for (const protocol of LOCAL_PROTOCOLS) {
      if (spec.startsWith(protocol)) {
        spec = spec.slice(protocol.length);
        break;
      }
    }
    if (spec.startsWith("//")) {
      spec = spec.slice(2); // file://host-less URL form
    }

    const artifactByName = TARBALL_PATTERN.test(spec);
    if ((spec.startsWith("~") || WINDOWS_ABSOLUTE.test(spec)) && !path.isAbsolute(spec)) {
      // Home-relative and foreign-platform absolute paths are never in the repository.
      return { kind: artifactByName ? "file" : "directory", outsideRepository: true };
    }
    this.context ??= this.load();
    const { boundary, workspace } = await this.context;
    const target = await canonicalize(path.resolve(this.projectDir, spec));
    const outsideRepository = !isInside(boundary, target);

    let isFile = artifactByName;
    if (!isFile && (await exists(target))) {
      isFile = !(await stat(target)).isDirectory();
    }
    if (isFile) {
      return { kind: "file", outsideRepository };
    }
    if (outsideRepository) {
      return { kind: "directory", outsideRepository: true };
    }
    if (workspace) {
      const relative = path.relative(workspace.dir, target).split(path.sep).join("/");
      if (relative === "" || (isInside(workspace.dir, target) && matchesWorkspace(workspace.patterns, relative))) {
        return { kind: "member", outsideRepository: false };
      }
    }
    return { kind: "directory", outsideRepository: false };
  }
}
