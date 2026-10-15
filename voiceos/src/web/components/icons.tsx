// Small stroke icons shared by more than one component.
export const PlusIcon = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.8"
		strokeLinecap="round"
		aria-hidden="true"
	>
		<path d="M8 3v10M3 8h10" />
	</svg>
);

export const LockIcon = () => (
	<svg
		className="lock-icon"
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.6"
		aria-hidden="true"
	>
		<rect x="3" y="7" width="10" height="7" rx="1.5" />
		<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
	</svg>
);

export const PencilIcon = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.6"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M10.5 2.5l3 3L6 13H3v-3z" />
	</svg>
);

// Voice OS's spoken line: a still waveform, so the caption reads as something said aloud.
export const WaveIcon = () => (
	<svg
		className="wave-icon"
		width="14"
		height="12"
		viewBox="0 0 14 12"
		fill="currentColor"
		aria-hidden="true"
	>
		<rect x="0" y="4" width="2" height="4" rx="1" />
		<rect x="3" y="2" width="2" height="8" rx="1" />
		<rect x="6" y="0" width="2" height="12" rx="1" />
		<rect x="9" y="3" width="2" height="6" rx="1" />
		<rect x="12" y="5" width="2" height="2" rx="1" />
	</svg>
);
