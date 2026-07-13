/**
 * Narrow a value that `noUncheckedIndexedAccess` typed as `T | undefined` back to
 * `T`, failing the test loudly if it is actually absent. Use it to wrap an index
 * or lookup whose result the surrounding test has already established must exist
 * (e.g. after `expect(arr).toHaveLength(1)` before reading `arr[0]`), so the
 * access is both type-safe and guarded — never silenced with a `!` assertion.
 */
export function present<T>(value: T | undefined, label = "indexed value"): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be present, but it was undefined.`);
  }
  return value;
}
