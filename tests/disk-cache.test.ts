import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DiskCache } from "../src/disk-cache";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createDiskCache(): Promise<DiskCache> {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "safeinstall-disk-cache-"));
  tempDirs.push(cacheDir);
  return new DiskCache({ cacheDir, ttlMs: 60_000 });
}

describe("DiskCache", () => {
  it("rejects cache envelopes dated in the future", async () => {
    const diskCache = await createDiskCache();
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    await diskCache.setJson("example", "key", { trusted: false });
    now.mockReturnValue(1_000_000);

    await expect(diskCache.getJson("example", "key")).resolves.toBeUndefined();
  });

  it("returns a current cache envelope", async () => {
    const diskCache = await createDiskCache();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await diskCache.setJson("example", "key", { value: "current" });

    await expect(diskCache.getJson("example", "key")).resolves.toEqual({ value: "current" });
  });
});
