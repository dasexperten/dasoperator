/** Keep Google requests bounded without waiting for an entire wave to finish. */
export async function gmailMap<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await run(items[index]); }
      catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  return results;
}
