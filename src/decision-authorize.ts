import path from "node:path";

import { loadConfig } from "./config";
import { verifyDecisions, type DecisionVerifyFinding } from "./decision-verify";
import { evaluateRequestedPackages } from "./evaluations";
import { bindFileAsStaged, blobOidAtRef, resolveCommit, resolveGitRepo } from "./git-blob";
import {
  discoverProjectInstallScope,
  inferProjectInstallTargetsForCheck,
  loadProjectInstallScope,
  type LoadedProjectInstallScope,
  type ProjectInstallScopePaths
} from "./project-installs";
import { loadManifestDependencies } from "./project-state";
import { RegistryClient } from "./registry";
import { parseManifestDependency } from "./specs";
import { evaluateTransitiveDependencies } from "./transitive";

/**
 * `decisions authorize` — the online half of L1 (RFC-001 §6, §10).
 *
 * Authorization answers: "is this dependency state acceptable NOW, observed
 * from a machine the author does not control?" It re-derives everything:
 *
 * 1. The committed-state verification (`decisions verify`) must pass first —
 *    authorizing a delta whose record chains do not verify is meaningless,
 *    and the D3 registry trust-root check lives there.
 * 2. The files being evaluated must BE the committed head state: any local
 *    divergence in manifest, lockfile, or policy refuses authorization
 *    (in CI the candidate checkout is the head by construction; locally
 *    this keeps 'authorized' from meaning 'whatever was lying around').
 * 3. A fresh policy evaluation of the head state's direct dependencies plus
 *    the transitive lockfile checks, with registry metadata fetched NOW.
 *    Recorded L0 verdicts are ignored by design (§7, M2). Divergence from
 *    a recorded verdict is legitimate — a package aged past the release
 *    window — and only the re-evaluation gates.
 *
 * Honest scope: the policy itself (thresholds, allowed sources) is read from
 * the committed head config — a weakened policy authorizes against the
 * weakened rules. That is §13 K2: policy changes are enforcement-zone diffs
 * whose boundary is human review, and this command does not pretend
 * otherwise.
 */

export interface DecisionAuthorizeOptions {
  baseRef: string;
  headRef?: string | undefined;
  allowedRegistryUrls?: string[];
}

export interface DecisionAuthorization {
  schemaVersion: 1;
  evaluatedAt: string;
  baseCommit: string;
  headCommit: string;
  /** Lockfile paths whose chains verified, with explicit fresh-evaluation coverage. */
  lockfiles: Array<{
    path: string;
    headBlobOid: string | null;
    evaluation: {
      status: "evaluated" | "removed";
      importers: Array<{ manifestPath: string; headBlobOid: string }>;
      workspaceMetadata: Array<{ path: string; headBlobOid: string | null }>;
    };
  }>;
  /** Blob OID of the policy config the evaluation ran under (K2 residual). */
  policyBlobOid: string | null;
  verdict: "allow" | "block";
  reasons: Array<{ code: string; message: string }>;
  warnings: string[];
}

export interface DecisionAuthorizeResult {
  ok: boolean;
  findings: DecisionVerifyFinding[];
  authorization?: DecisionAuthorization;
  infos: string[];
}

type AuthorizationManager = "npm" | "pnpm";

interface PreparedAuthorizationScope {
  lockfilePath: string;
  manager: AuthorizationManager;
  paths: ProjectInstallScopePaths;
  manifestRepoPaths: string[];
  workspaceMetadataRepoPaths: string[];
  loaded?: LoadedProjectInstallScope;
}

function managerForLockfile(lockfilePath: string): AuthorizationManager | undefined {
  const name = path.posix.basename(lockfilePath);
  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
    return "npm";
  }
  if (name === "pnpm-lock.yaml") {
    return "pnpm";
  }
  return undefined;
}

function repoPathFor(root: string, absolutePath: string): string | undefined {
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

export async function authorizeDecisions(
  cwd: string,
  options: DecisionAuthorizeOptions
): Promise<DecisionAuthorizeResult> {
  // 1. Committed-state verification is the precondition.
  const verified = await verifyDecisions(cwd, options);
  if (!verified.ok) {
    return { ok: false, findings: verified.findings, infos: verified.infos };
  }

  const repo = (await resolveGitRepo(cwd))!;
  const headRef = options.headRef ?? "HEAD";
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(repo, options.baseRef),
    resolveCommit(repo, headRef)
  ]);
  if (!baseCommit || !headCommit) {
    return {
      ok: false,
      findings: [{ code: "decisions-bad-ref", message: "Could not resolve base or head to a commit." }],
      infos: []
    };
  }

  // 2. The working tree must BE the head state for every file the
  //    evaluation reads; otherwise "authorized" would describe bytes that
  //    are not what merges. Discover importer paths from each verified
  //    lockfile, then bind every importer manifest before loading targets.
  const findings: DecisionVerifyFinding[] = [];
  const pinnedHeadOids = new Map<string, string | null>();
  const missingRequiredPaths = new Set<string>();
  const pinHeadFile = async (repoPath: string, required: boolean): Promise<void> => {
    if (pinnedHeadOids.has(repoPath)) {
      if (required && pinnedHeadOids.get(repoPath) === null && !missingRequiredPaths.has(repoPath)) {
        missingRequiredPaths.add(repoPath);
        findings.push({
          code: "decisions-project-state",
          message: `${repoPath} is required by a verified lockfile importer but is absent at ${headRef}.`
        });
      }
      return;
    }
    const [staged, committed] = await Promise.all([
      bindFileAsStaged(repo, repoPath),
      blobOidAtRef(repo, headCommit, repoPath)
    ]);
    pinnedHeadOids.set(repoPath, committed ?? null);
    if (required && committed === undefined) {
      missingRequiredPaths.add(repoPath);
      findings.push({
        code: "decisions-project-state",
        message: `${repoPath} is required by a verified lockfile importer but is absent at ${headRef}.`
      });
      return;
    }
    const stagedOid = staged?.blobOid;
    if (stagedOid !== committed) {
      findings.push({
        code: "decisions-dirty-state",
        message:
          `${repoPath} differs between the working tree and ${headRef}. ` +
          "Authorization evaluates committed state only — commit or stash the change."
      });
    }
  };

  for (const repoPath of ["package.json", "safeinstall.config.json", ...verified.verifiedPaths]) {
    await pinHeadFile(repoPath, false);
  }
  if (findings.length > 0) {
    return { ok: false, findings, infos: [] };
  }

  const verifiedLockfiles = verified.verifiedPaths.map((lockfilePath) => ({
    path: lockfilePath,
    headBlobOid: pinnedHeadOids.get(lockfilePath) ?? null
  }));
  const preparedScopes: PreparedAuthorizationScope[] = [];

  for (const lockfile of verifiedLockfiles) {
    if (lockfile.headBlobOid === null) {
      continue; // A removed lockfile has no remaining dependency state to evaluate.
    }
    const manager = managerForLockfile(lockfile.path);
    if (!manager) {
      findings.push({
        code: "decisions-project-state",
        message: `${lockfile.path} has no supported fresh-authorization evaluator.`
      });
      continue;
    }

    let paths: ProjectInstallScopePaths;
    try {
      paths = await discoverProjectInstallScope(path.join(repo.root, lockfile.path), manager);
    } catch (error) {
      findings.push({
        code: "decisions-project-state",
        message: `${lockfile.path}: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }

    const manifestRepoPaths = paths.manifestPaths.map((manifestPath) =>
      repoPathFor(repo.root, manifestPath)
    );
    const workspaceMetadataRepoPaths = paths.workspaceMetadataPaths.map((metadataPath) =>
      repoPathFor(repo.root, metadataPath)
    );
    if (
      manifestRepoPaths.some((repoPath) => repoPath === undefined) ||
      workspaceMetadataRepoPaths.some((repoPath) => repoPath === undefined)
    ) {
      findings.push({
        code: "decisions-project-state",
        message: `${lockfile.path} resolves an importer or workspace metadata outside the repository.`
      });
      continue;
    }

    preparedScopes.push({
      lockfilePath: lockfile.path,
      manager,
      paths,
      manifestRepoPaths: manifestRepoPaths as string[],
      workspaceMetadataRepoPaths: workspaceMetadataRepoPaths as string[]
    });
  }

  for (const scope of preparedScopes) {
    for (const manifestPath of scope.manifestRepoPaths) {
      await pinHeadFile(manifestPath, true);
    }
    for (const metadataPath of scope.workspaceMetadataRepoPaths) {
      await pinHeadFile(metadataPath, false);
    }
  }
  if (findings.length > 0) {
    return { ok: false, findings, infos: [] };
  }

  for (const scope of preparedScopes) {
    try {
      scope.loaded = await loadProjectInstallScope(scope.paths, scope.manager);
    } catch (error) {
      findings.push({
        code: "decisions-project-state",
        message: `${scope.lockfilePath}: ${error instanceof Error ? error.message : String(error)}`
      });
      continue;
    }
    findings.push(
      ...scope.loaded.targets.issues.map((message) => ({ code: "decisions-project-state", message }))
    );
  }
  if (findings.length > 0) {
    return { ok: false, findings, infos: [] };
  }

  const scopesByLockfile = new Map(preparedScopes.map((scope) => [scope.lockfilePath, scope]));
  for (const lockfile of verifiedLockfiles) {
    if (lockfile.headBlobOid === null) {
      continue;
    }
    const scope = scopesByLockfile.get(lockfile.path);
    if (
      !scope?.loaded ||
      scope.manifestRepoPaths.some((manifestPath) =>
        typeof pinnedHeadOids.get(manifestPath) !== "string"
      )
    ) {
      findings.push({
        code: "decisions-evaluation-incomplete",
        message: `${lockfile.path} does not have pinned evaluation coverage for every importer.`
      });
    }
  }
  if (findings.length > 0) {
    return { ok: false, findings, infos: [] };
  }

  // 3. Fresh evaluation of the head state. The registry identity was already
  //    enforced as a trust root by the verify step (D3): a non-default URL
  //    only reaches this point when explicitly allowlisted verifier-side.
  const { config, path: configPath } = await loadConfig(repo.root);
  const registryClient = new RegistryClient({ registryUrl: config.registryUrl });
  const reasons: Array<{ code: string; message: string }> = [];
  const warnings: string[] = [];
  const appendReasons = (entries: ReadonlyArray<{ code: string; message: string }>): void => {
    reasons.push(...entries.map((reason) => ({ code: reason.code, message: reason.message })));
  };

  if (verified.verifiedPaths.length === 0) {
    // Preserve the existing no-lockfile-delta behavior: authorization still
    // performs a fresh root-project check even though no coverage is emitted.
    const projectTargets = await inferProjectInstallTargetsForCheck(repo.root, repo.root);
    if (projectTargets?.issues.length) {
      return {
        ok: false,
        findings: projectTargets.issues.map((message) => ({ code: "decisions-project-state", message })),
        infos: []
      };
    }
    const requestedPackages = projectTargets
      ? projectTargets.targets.map((target) => target.requested)
      : Object.entries(await loadManifestDependencies(repo.root)).map(([name, spec]) =>
          parseManifestDependency(name, spec)
        );
    const evaluations = await evaluateRequestedPackages(
      repo.root,
      requestedPackages,
      registryClient,
      config
    );
    const transitive = await evaluateTransitiveDependencies({
      lockfilePath: projectTargets?.lockfilePath,
      directNames: new Set(requestedPackages.map((requested) => requested.name)),
      config
    });
    appendReasons([
      ...evaluations.flatMap((evaluation) => evaluation.blockedReasons),
      ...transitive.blockedReasons
    ]);
    warnings.push(...evaluations.flatMap((evaluation) => evaluation.warnings), ...transitive.warnings);
  } else {
    for (const scope of preparedScopes) {
      const loaded = scope.loaded;
      if (!loaded) {
        return {
          ok: false,
          findings: [{
            code: "decisions-project-state",
            message: `${scope.lockfilePath} has no loaded evaluation scope.`
          }],
          infos: []
        };
      }
      for (const importer of loaded.importers) {
        const requestedPackages = importer.targets.targets.map((target) => target.requested);
        const evaluations = await evaluateRequestedPackages(
          importer.packageDir,
          requestedPackages,
          registryClient,
          config
        );
        appendReasons(evaluations.flatMap((evaluation) => evaluation.blockedReasons));
        warnings.push(...evaluations.flatMap((evaluation) => evaluation.warnings));
      }
      const directPackages = loaded.targets.targets.map((target) => target.requested);
      const transitive = await evaluateTransitiveDependencies({
        lockfilePath: loaded.lockfilePath,
        directNames: new Set(directPackages.map((requested) => requested.name)),
        config
      });
      appendReasons(transitive.blockedReasons);
      warnings.push(...transitive.warnings);
    }
  }

  const lockfiles: DecisionAuthorization["lockfiles"] = verifiedLockfiles.map(
    (lockfile): DecisionAuthorization["lockfiles"][number] => {
      if (lockfile.headBlobOid === null) {
        return {
          ...lockfile,
          evaluation: { status: "removed", importers: [], workspaceMetadata: [] }
        };
      }
      const scope = scopesByLockfile.get(lockfile.path) as PreparedAuthorizationScope;
      return {
        ...lockfile,
        evaluation: {
          status: "evaluated",
          importers: scope.manifestRepoPaths.map((manifestPath) => ({
            manifestPath,
            headBlobOid: pinnedHeadOids.get(manifestPath) as string
          })),
          workspaceMetadata: scope.workspaceMetadataRepoPaths.map((metadataPath) => ({
            path: metadataPath,
            headBlobOid: pinnedHeadOids.get(metadataPath) ?? null
          }))
        }
      };
    }
  );
  const policyRepoPath = configPath ? path.relative(repo.root, configPath).split(path.sep).join("/") : null;
  const policyBlobOid = policyRepoPath
    ? ((await blobOidAtRef(repo, headCommit, policyRepoPath)) ?? null)
    : null;

  const authorization: DecisionAuthorization = {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    baseCommit,
    headCommit,
    lockfiles,
    policyBlobOid,
    verdict: reasons.length === 0 ? "allow" : "block",
    reasons,
    warnings
  };

  return {
    ok: reasons.length === 0,
    findings: reasons.length === 0 ? [] : reasons,
    authorization,
    infos: verified.infos
  };
}
