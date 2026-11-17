import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  blobOidAtRef,
  pathsAtRef,
  readBlob,
  resolveCommit,
  resolveGitRepo,
  toRepoRelative,
  type GitRepoContext
} from "./git-blob";
import { classifyDeclaredSource, parseManifestDependencies } from "./project-state";
import type { DependencySourceBaseline, SafeInstallConfig, SourceType } from "./types";

/**
 * Where a dependency's PRIOR source comes from (the "trust level dropped"
 * check). The prior source must never be derived from the working-tree
 * manifest being evaluated: whoever edits that manifest could erase the
 * evidence of a registry -> git/url/tarball swap. Instead it comes from a
 * committed manifest (the base commit for `decisions authorize`, HEAD for
 * local checks and installs). Configured `sourceBaselines` are only a
 * fallback when no committed manifest exists.
 */

interface ParsedManifest {
  name: string | undefined;
  sourceTypes: Record<string, SourceType>;
}

function parseManifest(raw: string): ParsedManifest {
  const document = JSON.parse(raw) as { name?: unknown };
  const sourceTypes: Record<string, SourceType> = {};
  for (const [name, spec] of Object.entries(parseManifestDependencies(raw))) {
    sourceTypes[name.toLowerCase()] = classifyDeclaredSource(String(spec));
  }
  return {
    name: typeof document?.name === "string" ? document.name : undefined,
    sourceTypes
  };
}

/** Merge per-manifest maps; a registry declaration anywhere wins (strictest). */
function mergeSourceTypes(
  into: Record<string, SourceType>,
  from: Readonly<Record<string, SourceType>>
): void {
  for (const [name, sourceType] of Object.entries(from)) {
    if (into[name] !== "registry") {
      into[name] = sourceType;
    }
  }
}

async function readManifestAt(
  repo: GitRepoContext,
  ref: string,
  repoPath: string
): Promise<ParsedManifest | undefined> {
  const oid = await blobOidAtRef(repo, ref, repoPath);
  if (!oid) {
    return undefined;
  }
  return parseManifest((await readBlob(repo, oid)).toString("utf8"));
}

/**
 * Baseline resolver for `decisions authorize`: manifests are read from the
 * trusted base commit only; the config `sourceBaselines` never participates.
 *
 * When an importer's manifest is absent at the base commit, it is either new
 * or moved. A moved package must keep its history, so the base tree is
 * searched for package.json files with the same package name. Only when none
 * exists is the importer genuinely new and the baseline an empty complete one.
 * A nameless package cannot be matched and fails closed.
 *
 * Throws when a manifest at the base commit is not valid JSON.
 */
export function createBaseSourceBaselineResolver(
  repo: GitRepoContext,
  baseCommit: string,
  headCommit: string
): (manifestRepoPath: string) => Promise<DependencySourceBaseline> {
  let baseManifestsByName: Map<string, ParsedManifest[]> | undefined;

  const scanBaseTree = async (): Promise<Map<string, ParsedManifest[]>> => {
    if (baseManifestsByName) {
      return baseManifestsByName;
    }
    const byName = new Map<string, ParsedManifest[]>();
    const candidates = (await pathsAtRef(repo, baseCommit, ".")).filter(
      (file) =>
        path.posix.basename(file) === "package.json" && !file.split("/").includes("node_modules")
    );
    for (const file of candidates) {
      let manifest: ParsedManifest | undefined;
      try {
        manifest = await readManifestAt(repo, baseCommit, file);
      } catch {
        continue; // An unrelated unparsable manifest cannot be a baseline.
      }
      if (manifest?.name !== undefined) {
        byName.set(manifest.name, [...(byName.get(manifest.name) ?? []), manifest]);
      }
    }
    baseManifestsByName = byName;
    return byName;
  };

  return async (manifestRepoPath) => {
    const atBase = await readManifestAt(repo, baseCommit, manifestRepoPath);
    if (atBase) {
      return { complete: true, sourceTypes: atBase.sourceTypes };
    }

    const atHead = await readManifestAt(repo, headCommit, manifestRepoPath);
    if (atHead?.name === undefined) {
      return { complete: false, sourceTypes: {} };
    }
    const sourceTypes: Record<string, SourceType> = {};
    for (const manifest of (await scanBaseTree()).get(atHead.name) ?? []) {
      mergeSourceTypes(sourceTypes, manifest.sourceTypes);
    }
    return { complete: true, sourceTypes };
  };
}

function configuredBaseline(config: SafeInstallConfig): DependencySourceBaseline {
  return { complete: false, sourceTypes: config.sourceBaselines ?? {} };
}

/**
 * Baseline for local project checks and installs: the manifests at git HEAD.
 * `manifestPaths` are the working-tree manifests under evaluation (one for a
 * plain project, several for a shared workspace lockfile); each is read from
 * HEAD once. When every manifest exists at HEAD the baseline is complete and
 * config `sourceBaselines` is ignored. Otherwise (no git, unborn HEAD,
 * untracked or unparsable manifest) the configured baselines are the
 * fail-closed fallback for names HEAD does not cover.
 */
export async function loadHeadSourceBaseline(
  manifestPaths: readonly string[],
  config: SafeInstallConfig
): Promise<DependencySourceBaseline> {
  const first = manifestPaths[0];
  if (first === undefined) {
    return configuredBaseline(config);
  }
  const repo = await resolveGitRepo(path.dirname(first));
  if (!repo || !(await resolveCommit(repo, "HEAD"))) {
    return configuredBaseline(config);
  }

  const sourceTypes: Record<string, SourceType> = {};
  let complete = true;
  for (const manifestPath of manifestPaths) {
    let manifest: ParsedManifest | undefined;
    try {
      const repoPath = toRepoRelative(repo.root, await realpath(manifestPath));
      if (repoPath.startsWith("..") || path.isAbsolute(repoPath)) {
        throw new Error("outside repository");
      }
      manifest = await readManifestAt(repo, "HEAD", repoPath);
    } catch {
      manifest = undefined;
    }
    if (!manifest) {
      complete = false;
      continue;
    }
    mergeSourceTypes(sourceTypes, manifest.sourceTypes);
  }
  if (complete) {
    return { complete: true, sourceTypes };
  }
  return { complete: false, sourceTypes: { ...(config.sourceBaselines ?? {}), ...sourceTypes } };
}

