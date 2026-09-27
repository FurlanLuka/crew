// A session's image, fetched through Voice OS itself by its stored name — so it loads wherever the
// page is open, over the proxy on a phone too.
export const buildMediaUrl = (name: string): string =>
	`/media?${new URLSearchParams({ name }).toString()}`;
