// One screen listens and speaks at a time: the main one. The server names it by the tab's own id
// (hello_tab), which survives a dropped socket and the page's own reloads — iOS drops sockets
// silently, and a tab must never lock itself out by coming back under a new connection.
const TAB_ID_KEY = 'voiceos-tab-id';
// This tab held the main screen when it last knew: kept across the reload a restarted server causes.
const WAS_MAIN_KEY = 'voiceos-was-main';
// Set just before a reload the page did on its own (a restarted server): the reloaded page is the
// same tab coming back, and must not take the main screen as a fresh load would.
const AUTO_RELOAD_KEY = 'voiceos-auto-reloaded';

export interface TabMemory {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
}

const readMemory = (): TabMemory | null => {
	try {
		return sessionStorage;
	} catch {
		return null;
	}
};

const createTabId = (): string =>
	typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// Once per tab: read back on every load of this tab, new in a new tab. Without storage, one per load.
export const readTabId = (memory: TabMemory | null = readMemory()): string => {
	try {
		const kept = memory?.getItem(TAB_ID_KEY);

		if (kept) {
			return kept;
		}

		const created = createTabId();
		memory?.setItem(TAB_ID_KEY, created);

		return created;
	} catch {
		return createTabId();
	}
};

// The server said another live page has this id ("Duplicate tab" copies sessionStorage): this tab
// takes a new one for good, and forgets having been main, which was the other page's.
let isTabRenewed = false;

// This load was a duplicated tab's: its own load's claim must not run after it took a new id.
export const wasTabRenewed = (): boolean => isTabRenewed;

export const renewTabId = (memory: TabMemory | null = readMemory()): string => {
	const created = createTabId();

	isTabRenewed = true;

	try {
		memory?.setItem(TAB_ID_KEY, created);
		memory?.removeItem(WAS_MAIN_KEY);
	} catch {
		// Blocked storage: the new id lasts for this load.
	}

	return created;
};

export interface MainClient {
	tabId: string | null;
	device: string;
}

// here: this tab listens and speaks. elsewhere: another tab does, and this one steps aside.
// none: no tab does (a restarted server) — this one stays quiet until it is used here.
// unknown: the server has not said yet.
export type MainState = 'here' | 'elsewhere' | 'none' | 'unknown';

export const readMainState = (main: MainClient | null, tabId: string): MainState => {
	if (!main) {
		return 'unknown';
	}

	if (!main.tabId) {
		return 'none';
	}

	return main.tabId === tabId ? 'here' : 'elsewhere';
};

// Keeps what main_client says about this tab, and answers whether it held the main screen. No main
// at all (null) changes nothing: that is the moment the memory is for.
export const rememberMain = (
	main: MainClient,
	tabId: string,
	memory: TabMemory | null = readMemory(),
): boolean => {
	try {
		if (main.tabId === tabId) {
			memory?.setItem(WAS_MAIN_KEY, '1');
		} else if (main.tabId) {
			memory?.removeItem(WAS_MAIN_KEY);
		}

		return memory?.getItem(WAS_MAIN_KEY) === '1';
	} catch {
		return false;
	}
};

// A restarted server knows no main: only the tab that held it takes it back.
export const shouldReclaim = (main: MainClient, wasMain: boolean): boolean =>
	main.tabId === null && wasMain;

export const markReloadByPage = (memory: TabMemory | null = readMemory()): void => {
	try {
		memory?.setItem(AUTO_RELOAD_KEY, '1');
	} catch {
		// Blocked storage: the reloaded page claims as a fresh load would.
	}
};

// Read once per load, and cleared: whether this load came from the developer or from the page.
export const wasReloadedByPage = (memory: TabMemory | null = readMemory()): boolean => {
	try {
		const wasAuto = memory?.getItem(AUTO_RELOAD_KEY) === '1';
		memory?.removeItem(AUTO_RELOAD_KEY);

		return wasAuto;
	} catch {
		return false;
	}
};
