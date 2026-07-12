import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const workflows = path.join(root, ".github", "workflows");

describe("GitHub workflow security boundaries", () => {
  it("pins every third-party action to an immutable commit SHA", async () => {
    for (const name of await readdir(workflows)) {
      const content = await readFile(path.join(workflows, name), "utf8");
      for (const match of content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
        expect(match[1], `${name}: ${match[1]}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("loads the durable trust verifier from the protected base branch", async () => {
    const content = await readFile(path.join(workflows, "safeinstall-trust.yml"), "utf8");
    expect(content).toContain("pull_request_target:");
    expect(content).not.toMatch(/^  pull_request:\s*$/m);
    expect(content).toContain("persist-credentials: false");
    // Verification runs from the external, code-owner-locked verifier action,
    // pinned by full commit SHA (never a tag or branch, so a PR cannot alter
    // what judges it — RFC-001 §13 K1), with the candidate passed as data.
    expect(content).toMatch(/uses:\s*Mickdownunder\/safeinstall-verifier@[0-9a-f]{40}\b/);
    expect(content).toContain("candidate-path: candidate");
  });

  it("keeps untrusted build code outside the OIDC-enabled publish job", async () => {
    const content = await readFile(path.join(workflows, "release.yml"), "utf8");
    const publishJob = content.slice(content.indexOf("  publish:"));
    expect(content).toContain("  verify:");
    expect(publishJob).toContain("environment: npm-publish");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).not.toContain("actions/checkout@");
    expect(publishJob).not.toContain("pnpm install");
    expect(publishJob).toContain("npm publish ./release-artifact/package.tgz --ignore-scripts --provenance");
    expect(publishJob).not.toContain("npm publish release-artifact/package.tgz");
  });
});
