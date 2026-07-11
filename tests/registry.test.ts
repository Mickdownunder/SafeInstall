import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import { RegistryClient } from "../src/registry";
import type { RequestedPackage } from "../src/types";

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
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
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
    expect(result.lifecycleScripts).toEqual(["postinstall"]);
    expect(result.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    expect(result.publishTimeSource).toBe("registry-time");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("https://registry.npmjs.org/axios");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: {
        Accept: "application/vnd.npm.install-v1+json"
      }
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
    // The publish-time lookup is the full packument, not a tarball HEAD probe.
    expect(fetchMock.mock.calls[2][0]).toBe("https://registry.npmjs.org/axios");
    expect(fetchMock.mock.calls[2][1]?.method).toBeUndefined();
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

    expect(fetchMock.mock.calls[0][0]).toBe("https://mirror.example.internal/npm/axios");
    expect(fetchMock.mock.calls[1][0]).toBe("https://mirror.example.internal/npm/axios/1.14.0");
    expect(fetchMock.mock.calls[2][0]).toBe("https://mirror.example.internal/npm/axios");
  });

  it("reuses exact-version metadata from the disk cache across client instances", async () => {
    const cacheDir = await createTempDir("safeinstall-registry-cache-");
    const requested = createRequestedPackage({
      requested: "1.14.0",
      registrySpecKind: "version"
    });

    const firstFetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          version: "1.14.0",
          scripts: {
            postinstall: "node install.js"
          },
          dist: {
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
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

    vi.stubGlobal("fetch", firstFetchMock);

    const firstResult = await new RegistryClient({
      cacheDir,
      cacheTtlMs: 60_000
    }).resolvePackage(requested);

    expect(firstResult.lifecycleScripts).toEqual(["postinstall"]);
    expect(firstFetchMock).toHaveBeenCalledTimes(2);

    const secondFetchMock = vi.fn().mockRejectedValue(new Error("network should not be used"));
    vi.stubGlobal("fetch", secondFetchMock);

    const secondResult = await new RegistryClient({
      cacheDir,
      cacheTtlMs: 60_000
    }).resolvePackage(requested);

    expect(secondResult.resolvedVersion).toBe("1.14.0");
    expect(secondResult.lifecycleScripts).toEqual(["postinstall"]);
    expect(secondResult.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    // The cache preserves the publish-time provenance, not just the date.
    expect(secondResult.publishTimeSource).toBe("registry-time");
    expect(secondFetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the tarball last-modified header when the time map lacks the version", async () => {
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
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          time: {
            created: "2020-01-01T00:00:00.000Z"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "last-modified": "Fri, 27 Mar 2026 19:01:42 GMT"
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = await (await createClient()).resolvePackage(createRequestedPackage());

    expect(result.publishedAt.toISOString()).toBe("2026-03-27T19:01:42.000Z");
    expect(result.publishTimeSource).toBe("tarball-last-modified");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: "HEAD"
    });
  });

  it("errors when neither the time map nor the tarball header provide a publish time", async () => {
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
            tarball: "https://registry.npmjs.org/axios/-/axios-1.14.0.tgz"
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

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
