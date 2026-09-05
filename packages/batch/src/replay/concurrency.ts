/**
 * Map with a bounded number of in-flight operations.
 *
 * Replay's extraction pass is thousands of independent model calls. Sequential
 * is hours; unbounded is a rate-limit error and a thundering herd at the
 * database. A small pool is the only sensible middle.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}
