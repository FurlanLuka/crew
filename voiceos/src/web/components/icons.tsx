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
