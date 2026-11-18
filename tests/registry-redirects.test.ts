import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDefaultContinuityDependencies } from "../src/continuity";
import { createDefaultProvenanceDependencies } from "../src/provenance";
import { RegistryClient } from "../src/registry";
import { scaffoldCiWorkflow } from "../src/trust-ci";

/**
 * A registry answer is data from the configured registry. A redirect would
 * let that registry, or whoever sits in front of it, send the request to any
 * other address, including services that only listen on the local machine.
 * Two real servers: the "registry" redirects everything to the "internal"
 * one, which must never receive a request.
 */

let registry: Server;
let internal: Server;
let registryUrl: string;
let internalHits: string[] = [];
const tempDirs: string[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

beforeAll(async () => {
  internal = createServer((request, response) => {
    internalHits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "axios", version: "1.0.0", versions: {}, time: {}, attestations: [] }));
  });
  const internalUrl = await listen(internal);
  registry = createServer((request, response) => {
    response.writeHead(302, { location: `${internalUrl}/internal${request.url}` });
    response.end();
  });
  registryUrl = await listen(registry);
});

afterEach(async () => {
  internalHits = [];
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await Promise.all([registry, internal].map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("registry requests do not follow redirects", () => {
  it("package metadata", async () => {
    const client = new RegistryClient({ registryUrl });

    await expect(
      client.resolvePackage({
        name: "axios",
        raw: "axios@1.0.0",
        requested: "1.0.0",
        sourceType: "registry",
        registrySpecKind: "version"
      })
    ).rejects.toThrow(/302/);
    expect(internalHits).toEqual([]);
  });

  it("provenance attestations", async () => {
    const { fetchAttestations } = createDefaultProvenanceDependencies();

    await expect(fetchAttestations(`${registryUrl}/-/npm/v1/attestations/axios@1.0.0`)).rejects.toThrow(/302/);
    expect(internalHits).toEqual([]);
  });

  it("version history for continuity", async () => {
    const { fetchVersionHistory } = createDefaultContinuityDependencies();

    await expect(fetchVersionHistory("axios", registryUrl)).rejects.toThrow(/302/);
    expect(internalHits).toEqual([]);
  });

  it("the verifier distribution for the CI scaffold, leaving no workflow behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "safeinstall-redirect-"));
    tempDirs.push(root);

    await expect(scaffoldCiWorkflow(root, "github", { registryUrl })).rejects.toThrow(/302/);
    expect(internalHits).toEqual([]);
    await expect(access(path.join(root, ".github", "workflows", "safeinstall-trust.yml"))).rejects.toThrow();
  });
});
