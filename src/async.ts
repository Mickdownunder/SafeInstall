export async function mapConcurrent<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Concurrency must be a positive integer. Received: ${concurrency}.`);
  }

  if (values.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(values.length);

  // Shared iterator hands out [index, value] pairs in order. entries() yields
  // [number, TInput] (never undefined), and next() is synchronous, so it is safe
  // to pull from concurrently: no two workers can interleave inside a single next().
  const pending = values.entries();

  async function runWorker(): Promise<void> {
    while (true) {
      const next = pending.next();
      if (next.done) {
        return;
      }

      const [currentIndex, value] = next.value;
      results[currentIndex] = await mapper(value, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
