import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import { DiskCache } from "../src/disk-cache";
import { RegistryClient } from "../src/registry";
import type { RequestedPackage } from "../src/types";
import { present } from "./helpers/present";

const tempDirs: string[] = [];

function createRequestedPackage(overrides: Partial<RequestedPackage> = {}): RequestedPackage {
  return {
    name: "axios",
    raw: "axios",
    requested: "latest",
    sourceType: "registry",
    registrySpecKind: "tag",
    ...overrides
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

async function createClient(
  options: ConstructorParameters<typeof RegistryClient>[0] = {}
): Promise<RegistryClient> {
  return new RegistryClient({
    cacheDir: await createTempDir("safeinstall-registry-client-"),
    ...options
  });
}

describe("RegistryClient", () => {
  it.each([{ name: "different-package", version: "1.14.0" }, { name: "axios", version: "9.9.9" }])(
    "rejects version manifests with a different identity: %j", async (manifest) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(manifest));
      vi.stubGlobal("fetch", fetchMock);
      await expect((await createClient()).resolvePackage(createRequestedPackage({
        raw: "axios@1.14.0", requested: "1.14.0", registrySpecKind: "version"
      }))).rejects.toThrow("identity");
    });

  it("takes the publish time from the registry time map as the primary source", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": {
            latest: "1.14.0"
          },
          versions: {
            "1.14.0": {
              version: "1.14.0"
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: "1.14.0",
          scripts: {
            postinstall: "node install.js"
          },
          dist: {
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
            integrity: "sha512-checked-artifact"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          time: {
            "1.14.0": "2026-03-27T19:01:42.000Z"
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await (await createClient()).resolvePackage(createRequestedPackage());

    expect(result.resolvedVersion).toBe("1.14.0");
    expect(result.artifact).toEqual({
      tarballUrl: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
      integrity: "sha512-checked-artifact"
    });
    expect(result.lifecycleScripts).toEqual(["postinstall"]);
    expect(result.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    expect(result.publishTimeSource).toBe("registry-time");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(present(fetchMock.mock.calls[0])[0]).toBe("https://registry.npmjs.org/axios");
    expect(present(fetchMock.mock.calls[0])[1]).toMatchObject({
      headers: {
        Accept: "application/vnd.npm.install-v1+json"
      }
    });
    expect(present(fetchMock.mock.calls[0])[1]?.signal).toBeDefined();
    // The publish-time lookup is the full packument, not a tarball HEAD probe.
    expect(present(fetchMock.mock.calls[2])[0]).toBe("https://registry.npmjs.org/axios");
    expect(present(fetchMock.mock.calls[2])[1]?.method).toBeUndefined();
  });

  it("builds registry metadata requests against a configured mirror URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": {
            latest: "1.14.0"
          },
          versions: {
            "1.14.0": {
              version: "1.14.0"
            }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          version: "1.14.0",
          dist: {
            tarball: "https://mirror.example.internal/artifacts/axios-1.14.0.tgz"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          time: {
            "1.14.0": "2026-03-27T19:01:42.000Z"
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    await (await createClient({
      registryUrl: "https://mirror.example.internal/npm/"
    })).resolvePackage(createRequestedPackage());

    expect(present(fetchMock.mock.calls[0])[0]).toBe("https://mirror.example.internal/npm/axios");
    expect(present(fetchMock.mock.calls[1])[0]).toBe("https://mirror.example.internal/npm/axios/1.14.0");
    expect(present(fetchMock.mock.calls[2])[0]).toBe("https://mirror.example.internal/npm/axios");
  });

  it("ignores planted disk metadata and fetches exact-version policy facts", async () => {
    const cacheDir = await createTempDir("safeinstall-registry-cache-");
    const requested = createRequestedPackage({
      requested: "1.14.0",
      registrySpecKind: "version"
    });
    const diskCache = new DiskCache({ cacheDir, ttlMs: 60_000 });
    const persistentKey = "https://registry.npmjs.org|axios@1.14.0";
    await diskCache.setJson("registry-version-manifests-v1", persistentKey, {
      version: "1.14.0",
      scripts: {},
      dist: {
        tarball: "https://attacker.invalid/axios.tgz",
        integrity: "sha512-attacker-selected"
      }
    });
    await diskCache.setJson("registry-publish-times-v2", persistentKey, {
      publishedAt: "2020-01-01T00:00:00.000Z",
      source: "registry-time"
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          version: "1.14.0",
          scripts: {
            postinstall: "node install.js"
          },
          dist: {
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
            integrity: "sha512-registry-observed"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          time: {
            "1.14.0": "2026-03-27T19:01:42.000Z"
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await new RegistryClient({
      cacheDir,
      cacheTtlMs: 60_000
    }).resolvePackage(requested);

    expect(result.lifecycleScripts).toEqual(["postinstall"]);
    expect(result.artifact).toEqual({
      tarballUrl: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
      integrity: "sha512-registry-observed"
    });
    expect(result.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    expect(result.publishTimeSource).toBe("registry-time");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  function tarballFallbackMock(tarball: string, headResponse?: Response) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ "dist-tags": { latest: "1.14.0" }, versions: { "1.14.0": { version: "1.14.0" } } })
      )
      .mockResolvedValueOnce(jsonResponse({ version: "1.14.0", dist: { tarball } }))
      .mockResolvedValueOnce(jsonResponse({ time: { created: "2020-01-01T00:00:00.000Z" } }));
    if (headResponse) {
      fetchMock.mockResolvedValueOnce(headResponse);
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("falls back to the tarball last-modified header for a same-origin tarball, without following redirects", async () => {
    const fetchMock = tarballFallbackMock(
      "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
      new Response(null, { status: 200, headers: { "last-modified": "Fri, 27 Mar 2026 19:01:42 GMT" } })
    );

    const result = await (await createClient()).resolvePackage(createRequestedPackage());

    expect(result.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    expect(result.publishTimeSource).toBe("tarball-last-modified");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(present(fetchMock.mock.calls[3])[1]).toMatchObject({ method: "HEAD", redirect: "manual" });
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://localhost:8080/axios.tgz",
    "https://attacker.invalid/axios.tgz",
    "http://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
    "https://user:pw@registry.npmjs.org/axios/-/axios-1.14.0.tgz",
    "not a url"
  ])("never requests an off-origin tarball (%s) and fails closed on the publish time", async (tarball) => {
    const fetchMock = tarballFallbackMock(tarball);

    await expect((await createClient()).resolvePackage(createRequestedPackage())).rejects.toThrow(
      "Registry error: missing publish time for axios@1.14.0."
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats a redirecting tarball HEAD as no publish time", async () => {
    tarballFallbackMock(
      "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    );

    await expect((await createClient()).resolvePackage(createRequestedPackage())).rejects.toThrow(
      "Registry error: missing publish time for axios@1.14.0."
    );
  });

  it("errors when neither the time map nor the tarball header provide a publish time", async () => {
    tarballFallbackMock(
      "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz",
      new Response(null, { status: 200 })
    );

    await expect((await createClient()).resolvePackage(createRequestedPackage())).rejects.toThrow(
      "Registry error: missing publish time for axios@1.14.0."
    );
  });

  it("turns timed out registry requests into a stable runtime error", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new DOMException("Timeout", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect((await createClient()).resolvePackage(createRequestedPackage())).rejects.toThrow(
      "Registry error: timed out while fetching axios."
    );
  });

  it("returns no prior lifecycle scripts when a historical version no longer exists", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const scripts = await (await createClient()).getLifecycleScripts("axios", "0.0.1");

    expect(scripts).toEqual([]);
  });
});
