export const mapPool = async <T, R>(
	items: T[],
	limit: number,
	mapItem: (item: T) => Promise<R>,
): Promise<R[]> => {
	// Bounded concurrency so a burst of eval calls does not trip rate limits.
	const results: R[] = new Array(items.length);
	// A cursor shared by the workers: each takes the next unclaimed item.
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			results[index] = await mapItem(items[index] as T);
		}
	});
	await Promise.all(workers);

	return results;
};

export type Attempt<R> = { ok: true; value: R } | { ok: false; error: string };

export const attempt = async <R>(operation: () => Promise<R>): Promise<Attempt<R>> => {
	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		// API failures are infrastructure, not model behaviour: counted apart, never scored as wrong.
		return { ok: false, error: String(error) };
	}
};
