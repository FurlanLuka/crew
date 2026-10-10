// Which logs tab a link opens on: ?tab=server:<project>/<server> or ?tab=setup:<project>, as crew
// server link writes it. Pure.

export interface LogTabTarget {
	key: string;
	project: string;
	// Absent on a setup runner's tab.
	server?: string;
}

const findServerTab = (tabs: LogTabTarget[], value: string): LogTabTarget | undefined => {
	const slash = value.lastIndexOf('/');
	const project = slash < 0 ? '' : value.slice(0, slash);
	const server = value.slice(slash + 1);
	const named = tabs.filter((tab) => tab.server !== undefined && tab.server === server);

	return named.find((tab) => tab.project === project) ?? named[0];
};

// The tab's key, or null for no tab asked or one this worktree does not have (the first tab then).
export const initialTabKey = (search: string, tabs: LogTabTarget[]): string | null => {
	const asked = new URLSearchParams(search).get('tab') ?? '';
	const colon = asked.indexOf(':');
	const kind = asked.slice(0, colon);
	const value = asked.slice(colon + 1);

	if (colon < 0 || !value) {
		return null;
	}

	const tab =
		kind === 'server'
			? findServerTab(tabs, value)
			: kind === 'setup'
				? tabs.find((candidate) => candidate.server === undefined && candidate.project === value)
				: undefined;

	return tab?.key ?? null;
};
