import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_REGISTRY_URL } from "./config";
import { fileExists } from "./project-discovery";
import { CI_TRUST_WORKFLOW_RELATIVE_PATH } from "./trust-surface";

/**
 * Scaffolding for the CI re-verification that is the durable anchor of the
 * Agent Trust Surface. Local reconciliation catches mistakes; only a check on
 * a machine the agent does not control survives a scheme-aware in-account
 * rewrite. `trust lock --ci <provider>` writes that workflow so the guarantee
 * is actually wired up, not just documented.
 *
 * The generated workflow is trust-only, PR-independent, and pins the CLI by
 * content hash (RFC-001 §13, K1(b)):
 * - trust-only (`trust status --require-lock`, not the full policy check) so it
 *   does not fail on a repo without a package.json and has no dependency-check
 *   coupling;
 * - the CLI is installed from a tarball whose sha512 is verified against the
 *   digest recorded here at scaffold time (trust on first use). An exact
 *   version alone can never resolve to a `@latest` CLI that predates the
 *   `trust` command (the "silent no-op anchor" failure mode), but it still
 *   trusts the registry to serve the same bytes for that version forever —
 *   the content hash removes that trust. The pinned version is the running
 *   CLI's own version, which by construction supports `trust`;
 * - `pull_request_target` loads the workflow definition from the protected
 *   base branch. The PR checkout is treated only as data and never executed.
 */

export type CiProvider = "github";

const SUPPORTED_PROVIDERS: CiProvider[] = ["github"];

const REGISTRY_FETCH_TIMEOUT_MS = 15_000;

export interface CiScaffoldResult {
  status: "created" | "exists";
  path: string;
  /** The exact safeinstall-cli version the workflow pins. */
  pinnedVersion: string;
  /**
   * Hex-encoded sha512 of the pinned tarball, as embedded in the workflow.
   * Absent when an existing workflow was left untouched (nothing was fetched).
   */
  pinnedSha512Hex?: string;
}

export interface CiScaffoldOptions {
  /** Registry the TOFU integrity is recorded from. Defaults to the public npm registry. */
  registryUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** The running CLI's own package identity — what the scaffold pins the workflow to. */
function cliPackage(): { name: string; version: string } {
  const pkg = require("../package.json") as { name?: string; version?: string };
  return {
    name: String(pkg.name ?? "safeinstall-cli"),
    version: String(pkg.version ?? "0.0.0")
  };
}

/** Parse the optional `--ci <provider>` / `--ci=<provider>` flag. */
export function parseCiProvider(argv: string[]): CiProvider | undefined | Error {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    let value: string | undefined;
    if (token === "--ci") {
      value = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--ci=")) {
      value = token.slice("--ci=".length);
    } else {
      continue;
    }
    if (value === undefined || !SUPPORTED_PROVIDERS.includes(value as CiProvider)) {
      return new Error(
        `Unsupported --ci value ${JSON.stringify(value ?? "")}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`
      );
    }
    return value as CiProvider;
  }
  return undefined;
}

const GITHUB_WORKFLOW_RELATIVE_PATH = path.join(...CI_TRUST_WORKFLOW_RELATIVE_PATH.split("/"));

/** What the workflow embeds about the pinned CLI distribution. */
interface VerifierDistribution {
  tarballUrl: string;
  /** Hex-encoded sha512 of the tarball, in the format `sha512sum -c` expects. */
  sha512Hex: string;
}

/**
 * Both values below are embedded verbatim in a double-quoted shell word inside
 * the generated workflow's `run:` block. Only characters that are inert there
 * — and inside a YAML literal block scalar — may pass; anything else fails the
 * scaffold rather than risking the registry injecting shell into the workflow.
 */
const SAFE_TARBALL_URL = /^https:\/\/[A-Za-z0-9._~:/@%+-]+\.tgz$/;
const SAFE_VERSION = /^[A-Za-z0-9.+-]+$/;

/** Convert the sha512 entry of an SRI string to the hex digest `sha512sum` expects. */
function sriSha512ToHex(integrity: string): string | undefined {
  // SRI allows several space-separated entries; use the sha512 one.
  for (const entry of integrity.trim().split(/\s+/)) {
    if (!entry.startsWith("sha512-")) {
      continue;
    }
    const digest = Buffer.from(entry.slice("sha512-".length), "base64");
    if (digest.length === 64) {
      return digest.toString("hex");
    }
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Fetch the registry's dist info for the CLI version the workflow pins and
 * reduce it to what the workflow embeds: tarball URL and hex sha512 digest.
 *
 * Trust on first use: the registry's answer at scaffold time becomes the
 * durable anchor — from then on, a registry serving different bytes for the
 * same version fails the workflow. Every validation failure here throws;
 * the scaffold must never fall back to a weaker, version-only pin.
 */
async function fetchVerifierDistribution(
  name: string,
  version: string,
  options?: CiScaffoldOptions
): Promise<VerifierDistribution> {
  const registryUrl = (options?.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/+$/, "");
  const fetchImpl = options?.fetchImpl ?? fetch;
  const label = `${name}@${version}`;
  // Same registry-URL shape as RegistryClient: keep a scoped package's "@".
  const encodedName = encodeURIComponent(name).replace(/^%40/, "@");

  let response: Response;
  try {
    response = await fetchImpl(`${registryUrl}/${encodedName}/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`Registry error: timed out while fetching ${label}.`);
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Registry error: could not fetch ${label} (${response.status}).`);
  }

  let manifest: { dist?: { tarball?: string; integrity?: string } };
  try {
    manifest = (await response.json()) as typeof manifest;
  } catch {
    throw new Error(`Registry error: invalid JSON manifest for ${label}.`);
  }

  const tarballUrl = manifest.dist?.tarball;
  if (!tarballUrl || !SAFE_TARBALL_URL.test(tarballUrl)) {
    throw new Error(
      `Registry error: ${label} has no https .tgz tarball URL safe to embed in a workflow (got ${JSON.stringify(tarballUrl ?? "")}).`
    );
  }

  const integrity = manifest.dist?.integrity;
  if (!integrity) {
    throw new Error(
      `Registry error: ${label} reported no dist.integrity; refusing to scaffold a weaker, version-only pin.`
    );
  }

  const sha512Hex = sriSha512ToHex(integrity);
  if (!sha512Hex) {
    throw new Error(
      `Registry error: ${label} integrity ${JSON.stringify(integrity)} is not a valid sha512 SRI; refusing to scaffold a weaker, version-only pin.`
    );
  }

  return { tarballUrl, sha512Hex };
}

function githubWorkflow(version: string, dist: VerifierDistribution): string {
  return `name: SafeInstall Trusted Base Verification

# This workflow is loaded from the PR's protected base branch, not from the
# proposed PR revision. It checks out the candidate only as inert data and runs
# an exact, immutable SafeInstall CLI version against it. No PR code executes.
#
# Generated by \`safeinstall trust lock --ci github\`. The CLI is pinned to an
# exact version AND its sha512 content hash — a floating version could predate
# the trust command and silently pass, and a version-only pin would still trust
# the registry to serve the same bytes forever. Bump both deliberately when you
# upgrade.
#
# Require the \`trust-base\` status in branch protection. A fully consistent
# rewrite of policy plus baseline still needs independent human review.
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  trust-base:
    runs-on: ubuntu-latest
    steps:
      - name: Check out pull request candidate as data
        if: github.event_name == 'pull_request_target'
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.head.sha }}
          path: candidate
          persist-credentials: false

      - name: Check out protected main revision
        if: github.event_name == 'push'
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          path: candidate
          persist-credentials: false

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 22

      # The verifier is pinned by content hash, not just version (RFC-001 §13,
      # K1(b)): a registry that serves different bytes for the same version
      # cannot swap the verification logic. The digest is the sha512 the
      # registry reported for safeinstall-cli@${version} when this workflow was
      # scaffolded (trust on first use) — verify it against an independent
      # source before relying on it as a hard guarantee.
      - name: Install integrity-pinned verifier
        run: |
          curl -fsSL "${dist.tarballUrl}" -o /tmp/safeinstall-cli-${version}.tgz
          echo "${dist.sha512Hex}  /tmp/safeinstall-cli-${version}.tgz" | sha512sum -c -
          npm install -g /tmp/safeinstall-cli-${version}.tgz

      - run: safeinstall trust status --require-lock
        working-directory: candidate
`;
}

/**
 * Write the CI workflow for a provider. Never overwrites an existing file — an
 * existing workflow may be customized, so a re-run reports "exists" and leaves
 * it untouched (idempotent and conservative, like guard setup). The TOFU
 * registry fetch happens after that check (no network on the idempotent
 * re-run) and before any write: a registry failure aborts with nothing on
 * disk, never a workflow with a weaker, version-only pin.
 */
export async function scaffoldCiWorkflow(
  root: string,
  _provider: CiProvider,
  options?: CiScaffoldOptions
): Promise<CiScaffoldResult> {
  // Only GitHub Actions is supported today; parseCiProvider guarantees it.
  const workflowPath = path.join(root, GITHUB_WORKFLOW_RELATIVE_PATH);
  const { name, version } = cliPackage();

  if (await fileExists(workflowPath)) {
    return { status: "exists", path: workflowPath, pinnedVersion: version };
  }

  if (!SAFE_VERSION.test(version)) {
    throw new Error(`Refusing to embed version ${JSON.stringify(version)} in a workflow.`);
  }

  const dist = await fetchVerifierDistribution(name, version, options);

  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, githubWorkflow(version, dist), "utf8");
  return {
    status: "created",
    path: workflowPath,
    pinnedVersion: version,
    pinnedSha512Hex: dist.sha512Hex
  };
}
