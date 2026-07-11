import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Exclusive, OWNED file lock. Node has no portable flock, but
 * `open(..., "wx")` (O_CREAT|O_EXCL) is an atomic create-or-fail on every
 * platform. Extracted verbatim from the trust ledger's writer lock — the
 * concurrency properties below survived adversarial review there, and the
 * decision-record store must not reimplement them divergently.
 *
 * Two properties make this race-safe where a naive lock is not:
 * - The lock file carries a per-acquisition token, and release removes the
 *   lock ONLY if it still holds our token — so a holder never deletes a lock
 *   that a different holder has since acquired (an unconditional rm-by-path
 *   is exactly what lets two writers interleave).
 * - A stale lock is stolen ATOMICALLY via rename(): of two racing stealers
 *   only one moves the observed file; the other gets ENOENT and retries a
 *   normal create. rm-then-open is never used, so the exclusive create is
 *   never raced.
 */

export interface FileLockOptions {
  /**
   * A lock older than this is presumed abandoned by a crashed process.
   * Callers protect only tiny-file critical sections that finish in
   * milliseconds, so a lock that has survived this long is not a live holder.
   */
  staleMs?: number;
  /** Overall backstop so a wedged lock errors instead of spinning forever. */
  waitMs?: number;
  /** Names the protected resource in the timeout error message. */
  label?: string;
}

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_WAIT_MS = 15_000;

/**
 * True when an exclusive create/rename lost the race for the lock file. POSIX
 * reports this as EEXIST (create) or ENOENT (the observed file already moved).
 * Windows surfaces the same contention — and a file caught mid-deletion by
 * another holder's rm — as EPERM/EBUSY, so those are retryable there too, not
 * hard errors. On POSIX EPERM is a genuine permission fault and still throws.
 */
function isLockContentionError(error: unknown, ...posixCodes: string[]): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && posixCodes.includes(code)) {
    return true;
  }
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

async function acquireFileLock(
  lockFile: string,
  token: string,
  staleMs: number,
  waitMs: number,
  label: string
): Promise<void> {
  const waitUntil = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (!isLockContentionError(error, "EEXIST")) {
        throw error;
      }
    }

    let ageMs: number;
    try {
      ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
    } catch {
      continue; // The lock vanished under us — retry the exclusive create.
    }

    if (ageMs > staleMs) {
      // Steal a presumed-crashed lock atomically: rename moves the exact file
      // we observed; a second stealer racing us gets ENOENT and simply retries.
      try {
        const stolen = `${lockFile}.stale-${token}`;
        await rename(lockFile, stolen);
        await rm(stolen, { force: true });
      } catch (error) {
        // A second stealer already moved the file (ENOENT), or on Windows holds
        // it mid-operation (EPERM/EBUSY) — either way, just retry the create.
        if (!isLockContentionError(error, "ENOENT")) {
          throw error;
        }
      }
      continue;
    }

    if (Date.now() > waitUntil) {
      throw new Error(
        `Timed out waiting for the ${label} lock at ${lockFile}. ` +
          "If no other safeinstall process is running, delete that file and retry."
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)));
  }
}

/** Run `action` while exclusively holding the lock file. */
export async function withFileLock<T>(
  lockFile: string,
  options: FileLockOptions,
  action: () => Promise<T>
): Promise<T> {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;

  await acquireFileLock(
    lockFile,
    token,
    options.staleMs ?? DEFAULT_STALE_MS,
    options.waitMs ?? DEFAULT_WAIT_MS,
    options.label ?? "file"
  );
  try {
    return await action();
  } finally {
    try {
      if ((await readFile(lockFile, "utf8")) === token) {
        await rm(lockFile, { force: true });
      }
    } catch {
      // Already gone, or now owned by someone else — never steal it back.
    }
  }
}
