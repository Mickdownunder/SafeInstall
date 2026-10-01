import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { evaluateRequestedPackages } from "./evaluations";
import { runPackageManager, type PackageManagerExecutionResult } from "./package-managers";
import { loadProjectInstallTargetsForManager, type ProjectInstallTargetsResult } from "./project-installs";
import { RegistryClient } from "./registry";
import { FLAGS_WITH_VALUES } from "./specs";
import { evaluateTransitiveDependencies } from "./transitive";
import type { CliReason, InstallPlan, PackageEvaluation, SafeInstallConfig } from "./types";

export class InstallBindingError extends Error {
  constructor(readonly reasons: CliReason[], readonly ranPackageManager = false) {
    super(reasons.map((reason) => reason.message).join(" "));
    this.name = "InstallBindingError";
  }
}

function fail(message: string, ranPackageManager = false): never {
  throw new InstallBindingError([{ code: "artifact-binding-failed", message }], ranPackageManager);
}

export function sha512Integrity(raw: string | undefined): string | undefined {
  const entry = (raw ?? "").trim();
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry)) return undefined;
  const encoded = entry.slice(7);
  const digest = Buffer.from(encoded, "base64");
  return digest.length === 64 && digest.toString("base64") === encoded ? entry : undefined;
}

interface ApprovedArtifact {
  name: string;
  version: string;
  tarballUrl: string;
  integrity: string;
}

function approve(evaluations: PackageEvaluation[], registryUrl: string, ran = false): ApprovedArtifact[] {
  const registry = new URL(registryUrl);
  return evaluations.filter((evaluation) => evaluation.requested.sourceType === "registry").map((evaluation) => {
    const resolved = evaluation.resolvedRegistryPackage;
    const integrity = sha512Integrity(resolved?.artifact?.integrity);
    if (!resolved?.artifact || !integrity) {
      fail(`Install blocked: ${evaluation.requested.name} has no valid SHA-512 artifact binding in the checked registry manifest.`, ran);
    }
    let tarball: URL;
    try { tarball = new URL(resolved.artifact.tarballUrl); }
    catch { return fail(`Install blocked: invalid tarball URL for ${evaluation.requested.name}.`, ran); }
    if (tarball.username || tarball.password || tarball.hash ||
        (tarball.protocol !== "https:" && !(registry.protocol === "http:" && tarball.origin === registry.origin))) {
      fail(`Install blocked: unsafe tarball URL for ${evaluation.requested.name}.`, ran);
    }
    return Object.freeze({ name: evaluation.requested.name, version: resolved.resolvedVersion,
      tarballUrl: tarball.href, integrity });
  });
}

const BOOLEAN_FLAGS = new Set([
  "-D", "-P", "-O", "-E", "--save", "--save-dev", "--save-prod", "--save-optional", "--save-exact",
  "--ignore-scripts", "--frozen-lockfile", "--audit", "--no-audit", "--fund", "--no-fund", "--legacy-peer-deps", "--strict-peer-deps"
]);
const VALUE_FLAGS = new Set(["-C", "--dir", "--cwd", "--prefix", "--registry", "--cache", "--store-dir", "--save-prefix"]);

/** Unknown switches are not forwarded across the reviewed lockfile boundary. */
export function installOptionReasons(plan: InstallPlan, config: SafeInstallConfig): CliReason[] {
  const args = [...plan.managerArgs, ...plan.forwardedArgs];
  let positional = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") { positional = true; continue; }
    if (positional || !arg.startsWith("-")) continue;
    const [flag, ...valueParts] = arg.split("=");
    const value = valueParts.length ? valueParts.join("=") : undefined;
    if (!BOOLEAN_FLAGS.has(flag!) && !VALUE_FLAGS.has(flag!)) {
      return [{ code: "unsafe-install-option", message: `Install blocked: option ${JSON.stringify(arg)} is not supported by the artifact-bound install path.` }];
    }
    if (BOOLEAN_FLAGS.has(flag!) && value !== undefined && value !== "true") {
      return [{ code: "unsafe-install-option", message: `Install blocked: option ${JSON.stringify(arg)} can weaken installation controls.` }];
    }
    if (VALUE_FLAGS.has(flag!)) {
      const resolvedValue = value ?? args[++index];
      if (!resolvedValue || resolvedValue.startsWith("-")) {
        return [{ code: "unsafe-install-option", message: `Install blocked: missing value for ${flag}.` }];
      }
      if (flag === "--registry" && resolvedValue.replace(/\/+$/, "") !== config.registryUrl.replace(/\/+$/, "")) {
        return [{ code: "registry-mismatch", message: "Install blocked: the package-manager registry differs from the checked SafeInstall registry.",
          suggestion: "Set registryUrl in the reviewed SafeInstall configuration instead of overriding it on the command line." }];
      }
    }
  }
  return [];
}

export function pinPackageArguments(plan: InstallPlan, evaluations: PackageEvaluation[]): string[] {
  const replacements = new Map(evaluations.map((evaluation) => [evaluation.requested.raw,
    evaluation.resolvedRegistryPackage ? `${evaluation.requested.name}@${evaluation.resolvedRegistryPackage.resolvedVersion}` : evaluation.requested.raw]));
  const pinned: string[] = [];
  let positional = false;
  for (let index = 0; index < plan.forwardedArgs.length; index += 1) {
    const arg = plan.forwardedArgs[index]!;
    if (arg === "--") { positional = true; continue; }
    if (!positional && arg.startsWith("-")) {
      pinned.push(arg);
      if (!arg.includes("=") && FLAGS_WITH_VALUES.has(arg)) pinned.push(plan.forwardedArgs[++index]!);
    } else {
      const replacement = replacements.get(arg);
      if (!replacement) fail(`Install blocked: package argument ${JSON.stringify(arg)} has no policy evaluation.`);
      pinned.push(replacement);
    }
  }
  return pinned;
}

function verifyTargets(targets: ProjectInstallTargetsResult, artifacts: ApprovedArtifact[], ran: boolean): void {
  if (targets.issues.length || !targets.lockfilePath) fail(`Install blocked: ${targets.issues.join(" ") || "no resolved lockfile was produced."}`, ran);
  for (const artifact of artifacts) {
    const matches = targets.targets.filter((entry) => entry.requested.name === artifact.name && entry.requested.requested === artifact.version);
    if (!matches.length) fail(`Install blocked: the lockfile has no target for ${artifact.name}@${artifact.version}.`, ran);
    for (const target of matches) {
      if (target.requested.sourceType !== "registry" ||
          sha512Integrity(target.integrity) !== artifact.integrity) {
        fail(`Install blocked: the lockfile does not bind ${artifact.name}@${artifact.version} to its approved SHA-512.`, ran);
      }
      if (target.tarballUrl) {
        let actual: string;
        try { actual = new URL(target.tarballUrl).href; }
        catch { return fail(`Install blocked: invalid lockfile tarball URL for ${artifact.name}.`, ran); }
        if (actual !== artifact.tarballUrl) fail(`Install blocked: the lockfile tarball for ${artifact.name} differs from the checked artifact.`, ran);
      }
    }
  }
}

/** A frozen workspace install can affect every importer in the shared lockfile. */
async function loadInstallScope(packageDir: string, manager: "npm" | "pnpm", ran: boolean) {
  const selected = await loadProjectInstallTargetsForManager(packageDir, packageDir, manager);
  if (!selected?.lockfilePath) fail("Install blocked: no supported lockfile binding.", ran);
  const root = path.dirname(selected.lockfilePath);
  const raw = await readFile(selected.lockfilePath, "utf8");
  const lockDigest = createHash("sha256").update(raw).digest("hex");
  const document = (manager === "npm" ? JSON.parse(raw) : parseYaml(raw)) as {
    packages?: Record<string, unknown>; importers?: Record<string, unknown>;
  };
  const keys = manager === "npm"
    ? Object.keys(document.packages ?? {}).filter((key) => !key.split("/").includes("node_modules"))
    : Object.keys(document.importers ?? {});
  const dirs = new Set([packageDir, ...keys.map((key) => path.resolve(root, key || "."))]);
  const results: ProjectInstallTargetsResult[] = [];
  const manifests: string[] = [];
  const manifestDigests: string[] = [];
  for (const dir of dirs) {
    const relative = path.relative(root, dir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail("Install blocked: a lockfile importer escapes the project root.", ran);
    const manifest = path.join(dir, "package.json");
    manifests.push(manifest);
    manifestDigests.push(await fileDigest(manifest));
    const result = await loadProjectInstallTargetsForManager(dir, dir, manager);
    if (!result || result.lockfilePath !== selected.lockfilePath) fail("Install blocked: inconsistent workspace lockfile scope.", ran);
    results.push(result);
  }
  return { root, manifests, manifestDigests, lockDigest,
    targets: { targets: results.flatMap((result) => result.targets),
      issues: results.flatMap((result) => result.issues), lockfilePath: selected.lockfilePath } };
}

async function fileDigest(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function frozenOptions(args: string[]): string[] {
  // Dependency save options belong to resolution, not to the frozen install.
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    const hasValue = !arg.includes("=") && VALUE_FLAGS.has(arg);
    if (!arg.startsWith("--save") && !["-D", "-P", "-O", "-E"].includes(arg)) {
      result.push(arg);
      if (hasValue) result.push(args[index + 1]!);
    }
    if (hasValue) index += 1;
  }
  return result;
}

export async function runBoundInstall(options: {
  plan: InstallPlan;
  evaluations: PackageEvaluation[];
  registryClient: RegistryClient;
  config: SafeInstallConfig;
  cwd: string;
  packageDir: string;
  signal?: AbortSignal | undefined;
  stdio: "inherit" | "pipe";
}): Promise<{ execution: PackageManagerExecutionResult; evaluations: PackageEvaluation[]; warnings: string[] }> {
  const { plan, config, packageDir, registryClient } = options;
  if (plan.manager === "bun") {
    throw new InstallBindingError([{ code: "artifact-binding-unsupported", message: "Install blocked: Bun artifact-bound lockfile installation is not implemented. Use npm or pnpm; safeinstall check remains available." }]);
  }
  if (!plan.projectInstall && options.evaluations.some((evaluation) => evaluation.requested.sourceType !== "registry")) {
    fail("Install blocked: explicit non-registry sources cannot be bound to a checked registry artifact.");
  }
  const initialArtifacts = approve(options.evaluations, config.registryUrl);
  const portableDir = packageDir.split(path.sep).join("/");
  const context = plan.manager === "npm" ? `--prefix=${portableDir}` : `--dir=${portableDir}`;
  const base = { manager: plan.manager, config, cwd: options.cwd, signal: options.signal, stdio: options.stdio };
  let preparation: PackageManagerExecutionResult | undefined;
  if (!plan.projectInstall) {
    preparation = await runPackageManager({ ...base, managerArgs: plan.managerArgs, command: plan.command,
      forwardedArgs: [...pinPackageArguments(plan, options.evaluations), context, "--global=false",
        plan.manager === "npm" ? "--package-lock-only" : "--lockfile-only",
        plan.manager === "npm" ? "--package-lock=true" : "--lockfile=true"] });
    if (preparation.code !== 0) return { execution: preparation, evaluations: options.evaluations, warnings: [] };
  }
  const scope = await loadInstallScope(packageDir, plan.manager, Boolean(preparation));
  const { targets } = scope;
  verifyTargets(targets, initialArtifacts, Boolean(preparation));
  const initialKeys = new Set(options.evaluations.map((evaluation) => JSON.stringify([evaluation.requested.name,
    evaluation.resolvedRegistryPackage?.resolvedVersion ?? evaluation.requested.requested])));
  const remaining = [...new Map(targets.targets.filter((target) =>
    !initialKeys.has(JSON.stringify([target.requested.name, target.requested.requested])))
    .map((target) => [target.requested.raw, target.requested])).values()];
  const additional = await evaluateRequestedPackages(packageDir,
    remaining,
    registryClient, config, options.signal);
  const evaluations = [...options.evaluations, ...additional];
  const transitive = await evaluateTransitiveDependencies({ lockfilePath: targets.lockfilePath,
    directNames: new Set(evaluations.map((evaluation) => evaluation.requested.name)), config });
  const reasons = [...additional.flatMap((evaluation) => evaluation.blockedReasons), ...transitive.blockedReasons];
  if (reasons.length) throw new InstallBindingError(reasons, Boolean(preparation));
  verifyTargets(targets, approve(evaluations, config.registryUrl, Boolean(preparation)), Boolean(preparation));
  const lockfile = targets.lockfilePath!;
  const { lockDigest: lockedDigest, manifestDigests } = scope;
  const beforeDigests = await Promise.all(scope.manifests.map(fileDigest));
  if (await fileDigest(lockfile) !== lockedDigest || beforeDigests.some((digest, index) => digest !== manifestDigests[index])) {
    fail("Install blocked: the reviewed manifest or lockfile changed during policy evaluation.", Boolean(preparation));
  }
  const frozenContext = plan.manager === "npm" ? `--prefix=${scope.root.split(path.sep).join("/")}` : context;
  const execution = await runPackageManager({ ...base, managerArgs: frozenOptions(plan.managerArgs),
    command: plan.manager === "npm" ? "ci" : "install",
    forwardedArgs: [...frozenOptions(plan.forwardedArgs),
      frozenContext, "--global=false", ...(plan.manager === "pnpm" ? ["--frozen-lockfile"] : [])] });
  const afterDigests = await Promise.all(scope.manifests.map(fileDigest));
  if (await fileDigest(lockfile) !== lockedDigest || afterDigests.some((digest, index) => digest !== manifestDigests[index])) {
    fail("Install failed: the reviewed manifest or lockfile changed during the frozen installation.", true);
  }
  return { execution: { ...execution,
    stdout: options.stdio === "pipe" ? (preparation?.stdout ?? "") + (execution.stdout ?? "") : undefined,
    stderr: options.stdio === "pipe" ? (preparation?.stderr ?? "") + (execution.stderr ?? "") : undefined },
    evaluations, warnings: transitive.warnings };
}
