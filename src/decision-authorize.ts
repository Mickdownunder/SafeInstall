import path from "node:path";

import { loadConfig } from "./config";
import { verifyDecisions, type DecisionVerifyFinding } from "./decision-verify";
import { evaluateRequestedPackages } from "./evaluations";
import { bindFileAsStaged, blobOidAtRef, resolveCommit, resolveGitRepo } from "./git-blob";
import { inferProjectInstallTargetsForCheck } from "./project-installs";
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
  /** Lockfile paths whose chains verified, with their head blob OIDs. */
  lockfiles: Array<{ path: string; headBlobOid: string | null }>;
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
  //    are not what merges.
  const findings: DecisionVerifyFinding[] = [];
  const filesToPin = ["package.json", "safeinstall.config.json", ...verified.verifiedPaths];
  for (const repoPath of filesToPin) {
    const [staged, committed] = await Promise.all([
      bindFileAsStaged(repo, repoPath),
      blobOidAtRef(repo, headCommit, repoPath)
    ]);
    const stagedOid = staged?.blobOid;
    if (stagedOid !== committed) {
      findings.push({
        code: "decisions-dirty-state",
        message:
          `${repoPath} differs between the working tree and ${headRef}. ` +
          "Authorization evaluates committed state only — commit or stash the change."
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

  const registryClient = new RegistryClient({ registryUrl: config.registryUrl });
  const evaluations = await evaluateRequestedPackages(repo.root, requestedPackages, registryClient, config);
  const transitive = await evaluateTransitiveDependencies({
    lockfilePath: projectTargets?.lockfilePath,
    directNames: new Set(requestedPackages.map((requested) => requested.name)),
    config
  });

  const reasons = [
    ...evaluations.flatMap((evaluation) => evaluation.blockedReasons),
    ...transitive.blockedReasons
  ].map((reason) => ({ code: reason.code, message: reason.message }));
  const warnings = [
    ...evaluations.flatMap((evaluation) => evaluation.warnings),
    ...transitive.warnings
  ];

  const lockfiles = await Promise.all(
    verified.verifiedPaths.map(async (lockfilePath) => ({
      path: lockfilePath,
      headBlobOid: (await blobOidAtRef(repo, headCommit, lockfilePath)) ?? null
    }))
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
