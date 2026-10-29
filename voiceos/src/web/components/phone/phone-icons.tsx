// The phone layout's own drawings: back, ⋯, close, send, the hold mic, and the browser's Share and
// Add to Home Screen marks the install guide points at.
export const BackIcon = () => (
	<svg width="12" height="20" viewBox="0 0 12 20" aria-hidden="true">
		<path
			d="M10 2 2 10l8 8"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

export const DotsIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
		<circle cx="5" cy="12" r="2" fill="currentColor" />
		<circle cx="12" cy="12" r="2" fill="currentColor" />
		<circle cx="19" cy="12" r="2" fill="currentColor" />
	</svg>
);

export const SendIcon = () => (
	<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
		<path
			d="M12 19V5M6 11l6-6 6 6"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

export const HoldMicIcon = () => (
	<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
		<rect x="8.5" y="2.5" width="7" height="12" rx="3.5" fill="currentColor" />
		<path
			d="M5 11a7 7 0 0 0 14 0M12 18v3.5"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
		/>
	</svg>
);

export const ShareIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
		<path
			d="M12 3v12M7.5 7.5 12 3l4.5 4.5"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
		<path
			d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
		/>
	</svg>
);

export const AddBoxIcon = () => (
	<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
		<rect
			x="3.5"
			y="3.5"
			width="17"
			height="17"
			rx="4"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
		/>
		<path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
	</svg>
);
