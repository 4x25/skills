export async function mapLimit(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be an integer >= 1');
  }

  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;

        try {
          results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
        } catch (error) {
          results[index] = { status: 'rejected', reason: error };
        }
      }
    },
  );

  await Promise.all(workers);
  return results;
}
