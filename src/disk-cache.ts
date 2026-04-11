import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface CacheEnvelope<TValue> {
  cachedAt: number;
  value: TValue;
}

function defaultCacheDir(): string {
  if (process.env.SAFEINSTALL_CACHE_DIR) {
    return process.env.SAFEINSTALL_CACHE_DIR;
  }

  if (process.env.XDG_CACHE_HOME) {
    return path.join(process.env.XDG_CACHE_HOME, "safeinstall");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "SafeInstall");
  }

  return path.join(os.homedir(), ".cache", "safeinstall");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface DiskCacheOptions {
  cacheDir?: string;
  ttlMs: number;
}

export class DiskCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;

  constructor(options: DiskCacheOptions) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    this.ttlMs = options.ttlMs;
  }

  async getJson<TValue>(namespace: string, key: string): Promise<TValue | undefined> {
    try {
      const raw = await readFile(this.cacheFilePath(namespace, key), "utf8");
      const entry = JSON.parse(raw) as CacheEnvelope<TValue>;
      if (typeof entry.cachedAt !== "number") {
        return undefined;
      }

      if (Date.now() - entry.cachedAt > this.ttlMs) {
        return undefined;
      }

      return entry.value;
    } catch {
      return undefined;
    }
  }

  async setJson<TValue>(namespace: string, key: string, value: TValue): Promise<void> {
    try {
      // Restrict permissions so a co-located user cannot poison cached
      // publish timestamps and bypass release-age policy checks. The mode
      // flags are a no-op on Windows, where ACLs gate access instead.
      const namespaceDir = path.join(this.cacheDir, namespace);
      await mkdir(namespaceDir, { recursive: true, mode: 0o700 });
      const payload: CacheEnvelope<TValue> = {
        cachedAt: Date.now(),
        value
      };
      await writeFile(this.cacheFilePath(namespace, key), `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    } catch {
      // Cache failures must never block installs or checks.
    }
  }

  private cacheFilePath(namespace: string, key: string): string {
    return path.join(this.cacheDir, namespace, `${hashKey(key)}.json`);
  }
}
