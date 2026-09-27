export interface ResolveClaudeBinParams {
	override: string | undefined;
	compiled: boolean;
	which: (command: string) => string | null;
}

export const resolveClaudeBin = ({
	override,
	compiled,
	which,
}: ResolveClaudeBinParams): string | null | undefined => {
	if (override) {
		return override;
	}

	// From source the SDK's pinned claude runs (undefined lets the SDK decide).
	if (!compiled) {
		return undefined;
	}

	// A compiled build can't reach the SDK's bundled claude in node_modules; null means none on PATH.
	return which('claude');
};

export const isCompiled = (main: string = Bun.main): boolean => {
	return main.startsWith('/$bunfs/') || main.includes('~BUN');
};
