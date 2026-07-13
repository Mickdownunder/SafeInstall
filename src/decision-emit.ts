import { realpath } from "node:fs/promises";
import path from "node:path";

import { PACKAGE_VERSION } from "./cli-version";
import { DEFAULT_REGISTRY_URL } from "./config";
import { appendDecisionRecord, type DecisionRecordDraft } from "./decision-store";
import { DECISIONS_RELATIVE_DIR, type DecisionObservation } from "./decision-record";
import { fileExists } from "./project-discovery";
import { nonHumanContextMarker } from "./trust-flow";
import { TRUST_LOCK_RELATIVE_PATH } from "./trust-surface";
import {
  bindFileAsStaged,
  resolveGitRepo,
  toRepoRelative,
  type GitFileBinding,
  type GitRepoContext
} from "./git-blob";
import type {
  CliReason,
  PackageEvaluation,
  PackageManagerName,
  SafeInstallConfig
} from "./types";

/**
 * L0 emission: turn one install/check decision into a decision record
 * (RFC-001 §5). Records are audit evidence, never a gate — emission failures
 * therefore degrade to a warning on the result and must never block or crash
 * the flow that produced the decision. But they degrade LOUDLY: a
 * state-changing install without a record is exactly the silent gap the
 * records exist to close.
 *
 * Emission requires a git repository (D2: bindings are staged blob
 * identities). Outside one, the flow reports why no record was written
 * instead of pretending nothing was skipped.
 */

/** Everything bound BEFORE the package manager may change the world. */
export interface DecisionCapture {
  repo: GitRepoContext;
  lockfileRepoPath: string;
  manifestRepoPath: string | null;
  lockfileBefore: GitFileBinding | null;
  manifestBefore: GitFileBinding | null;
  policyBinding: GitFileBinding | null;
  trustLockBinding: GitFileBinding | null;
}

export type DecisionCaptureResult =
  | { captured: DecisionCapture }
  | { captured?: undefined; skippedReason: string };

/** The lockfile a manager maintains in `packageDir`, by convention. */
async function conventionalLockfilePath(
  packageDir: string,
  manager: PackageManagerName
): Promise<string> {
  if (manager === "pnpm") {
    return path.join(packageDir, "pnpm-lock.yaml");
  }
  if (manager === "bun") {
    const binary = path.join(packageDir, "bun.lockb");
    return (await fileExists(binary)) ? binary : path.join(packageDir, "bun.lock");
  }
  const shrinkwrap = path.join(packageDir, "npm-shrinkwrap.json");
  return (await fileExists(shrinkwrap)) ? shrinkwrap : path.join(packageDir, "package-lock.json");
}

async function bindRepoFile(
  repo: GitRepoContext,
  repoRelativePath: string | null
): Promise<GitFileBinding | null> {
  if (repoRelativePath === null) {
    return null;
  }
  return (await bindFileAsStaged(repo, repoRelativePath)) ?? null;
}

/** A repo-relative path for `absolutePath`, or null when it escapes the repo. */
function insideRepo(repo: GitRepoContext, absolutePath: string): string | null {
  const relative = toRepoRelative(repo.root, absolutePath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : relative;
}

export async function captureDecisionState(options: {
  packageDir: string;
  manager?: PackageManagerName;
  /** Absolute lockfile path when the flow already resolved one. */
  lockfilePath?: string | undefined;
  /** Absolute path of the loaded config file, when one exists. */
  configPath?: string | undefined;
}): Promise<DecisionCaptureResult> {
  try {
    // Canonicalize before comparing against the repo root: Windows 8.3
    // short paths and macOS /var symlinks otherwise make in-repo files look
    // like they escape it (observed as skipped records on the Windows CI leg).
    const packageDir = await realpath(options.packageDir);
    const repo = await resolveGitRepo(packageDir);
    if (!repo) {
      return { skippedReason: "not a git repository (records bind git blob identities, RFC-001 D2)" };
    }

    const canonicalizeExpected = async (filePath: string): Promise<string> =>
      path.join(await realpath(path.dirname(filePath)), path.basename(filePath));

    const rawLockfilePath =
      options.lockfilePath ??
      (options.manager ? await conventionalLockfilePath(packageDir, options.manager) : undefined);
    if (!rawLockfilePath) {
      return { skippedReason: "no lockfile path could be established for this command" };
    }
    const lockfileAbsolute = await canonicalizeExpected(rawLockfilePath);
    const lockfileRepoPath = insideRepo(repo, lockfileAbsolute);
    if (!lockfileRepoPath) {
      return { skippedReason: `lockfile ${lockfileAbsolute} lies outside the repository` };
    }

    const manifestRepoPath = insideRepo(repo, path.join(packageDir, "package.json"));
    const policyRepoPath = options.configPath
      ? insideRepo(repo, await canonicalizeExpected(options.configPath))
      : null;

    return {
      captured: {
        repo,
        lockfileRepoPath,
        manifestRepoPath,
        lockfileBefore: await bindRepoFile(repo, lockfileRepoPath),
        manifestBefore: await bindRepoFile(repo, manifestRepoPath),
        policyBinding: await bindRepoFile(repo, policyRepoPath),
        trustLockBinding: await bindRepoFile(repo, TRUST_LOCK_RELATIVE_PATH)
      }
    };
  } catch (error) {
    return {
      skippedReason: `could not bind repository state (${error instanceof Error ? error.message : String(error)})`
    };
  }
}

/**
 * Per-package observation with the D4 guarantees: non-registry sources carry
 * an explicit finding, and signals that could not be computed are explicit
 * `notEvaluable` reasons — never empty fields that read as "clean".
 */
export function toObservation(
  evaluation: PackageEvaluation,
  config: SafeInstallConfig
): DecisionObservation {
  const { requested, resolvedRegistryPackage, blockedReasons } = evaluation;
  const sourceType = requested.sourceType;
  const findings: CliReason[] = [];
  let releaseAgeNotEvaluable: string | null = null;
  let provenanceNotEvaluable: string | null = null;

  if (sourceType === "workspace") {
    findings.push({
      code: "workspace-source",
      message: `${requested.name} resolves from the workspace, not the registry.`
    });
    releaseAgeNotEvaluable = "workspace sources have no registry publish time";
    provenanceNotEvaluable = "workspace sources have no registry provenance";
  } else if (sourceType !== "registry") {
    findings.push({
      code: "non-registry-source",
      message:
        `${requested.name} resolves from a ${sourceType} source: release-age, provenance, and ` +
        "continuity signals are structurally not evaluable for it (RFC-001 §5.4)."
    });
    releaseAgeNotEvaluable = `${sourceType} sources have no registry publish time`;
    provenanceNotEvaluable = `${sourceType} sources have no registry provenance`;
  } else if (!resolvedRegistryPackage) {
    releaseAgeNotEvaluable = "package resolution failed";
    provenanceNotEvaluable = "package resolution failed";
  } else if (config.provenance.mode === "off") {
    provenanceNotEvaluable = "provenance checks are disabled by policy";
  }

  return {
    name: requested.name,
    requestedSpec: requested.raw,
    sourceType,
    resolvedVersion: resolvedRegistryPackage?.resolvedVersion ?? null,
    publishedAt: resolvedRegistryPackage?.publishedAt.toISOString() ?? null,
    publishTimeSource: resolvedRegistryPackage?.publishTimeSource ?? null,
    findings: [
      ...findings,
      ...blockedReasons.map((reason) => ({ code: reason.code, message: reason.message }))
    ],
    notEvaluable: {
      releaseAge: releaseAgeNotEvaluable,
      provenance: provenanceNotEvaluable
    }
  };
}

export async function emitDecisionRecord(options: {
  capture: DecisionCapture;
  recordType: "install" | "check";
  argv: string[];
  packageManager: PackageManagerName | null;
  config: SafeInstallConfig;
  evaluations: PackageEvaluation[];
  decision: "allow" | "block" | "error";
  reasons: CliReason[];
  installed: boolean | null;
}): Promise<{ info?: string; warning?: string }> {
  try {
    const { capture } = options;
    const observations = options.evaluations.map((evaluation) =>
      toObservation(evaluation, options.config)
    );
    const registryUrl = options.config.registryUrl.replace(/\/+$/, "");

    const draft: DecisionRecordDraft = {
      schemaVersion: 1,
      recordType: options.recordType,
      actor: nonHumanContextMarker() ? "agent" : "human-unverified",
      createdAt: new Date().toISOString(),
      cliVersion: PACKAGE_VERSION,
      request: {
        command: options.argv,
        packageManager: options.packageManager
      },
      policy: {
        binding: capture.policyBinding,
        effective: {
          minimumReleaseAgeHours: options.config.minimumReleaseAgeHours,
          allowedSources: options.config.allowedSources,
          provenanceMode: options.config.provenance.mode,
          typoSquatMode: options.config.typoSquat.mode,
          transitiveMode: options.config.transitive.mode,
          continuityMode: options.config.continuity.mode,
          registryUrl,
          registryDefault: registryUrl === DEFAULT_REGISTRY_URL
        }
      },
      observations,
      verdict: {
        decision: options.decision,
        reasons: options.reasons.map((reason) => ({ code: reason.code, message: reason.message })),
        notEvaluableCount: observations.filter(
          (observation) =>
            observation.notEvaluable.releaseAge !== null || observation.notEvaluable.provenance !== null
        ).length
      },
      manifest: {
        path: capture.manifestRepoPath,
        before: capture.manifestBefore,
        after: await bindRepoFile(capture.repo, capture.manifestRepoPath)
      },
      lockfile: {
        path: capture.lockfileRepoPath,
        before: capture.lockfileBefore,
        after: await bindRepoFile(capture.repo, capture.lockfileRepoPath)
      },
      trust: {
        lockBinding: capture.trustLockBinding
      },
      installed: options.installed
    };

    const stored = await appendDecisionRecord(capture.repo.root, draft);
    return {
      info: `Decision record written: seq ${stored.seq} for ${capture.lockfileRepoPath} (${stored.digest.slice(0, 12)}). Commit ${DECISIONS_RELATIVE_DIR}/ with the dependency change.`
    };
  } catch (error) {
    return {
      warning: `Decision record NOT written for this ${options.recordType} decision: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}
