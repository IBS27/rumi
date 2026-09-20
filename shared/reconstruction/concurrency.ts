// Bounded provider work. Preserve input order, cancel siblings on failure, and
// await their cleanup before returning so failed jobs cannot keep writing progress.
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const results: R[] = new Array(items.length);
  let next = 0;
  try {
    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      async () => {
        while (next < items.length && !controller.signal.aborted) {
          const index = next++;
          try {
            results[index] = await work(items[index], index, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
          }
        }
      },
    );
    await Promise.all(workers);
    controller.signal.throwIfAborted();
    return results;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
