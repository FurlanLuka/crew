import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { handleMenuKey, useClickOutside } from '../menu-keys.js';
import { INPUT_MODES, type InputMode } from '../listen-mode.js';

interface ModeCopy {
	name: string;
	description: string;
	icon: ReactNode;
}

const ICON_PROPS = {
	width: 16,
	height: 16,
	viewBox: '0 0 16 16',
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 1.5,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
	'aria-hidden': true,
} as const;

export const MODE_COPY: Record<InputMode, ModeCopy> = {
	push: {
		name: 'Push to talk',
		description: 'Hold Space or the mic while you speak; let go to send.',
		icon: (
			<svg {...ICON_PROPS}>
				<circle cx="8" cy="8" r="5.5" />
				<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	'on-demand': {
		name: 'On demand',
		description: 'Always listening, but acts only on what follows “Voice OS”.',
		icon: (
			<svg {...ICON_PROPS}>
				<path d="M3 3.5h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H7.5L4.5 13.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
				<path d="M5.5 7.25h.01M8 7.25h.01M10.5 7.25h.01" strokeWidth="2" />
			</svg>
		),
	},
	'hands-free': {
		name: 'Hands-free',
		description: 'Always listening; every turn is acted on. Talk over Voice OS to interrupt.',
		icon: (
			<svg {...ICON_PROPS}>
				<path d="M8 5.5v5M5.5 7v2M10.5 7v2M3 7.75v.5M13 7.75v.5" />
			</svg>
		),
	},
	dictation: {
		name: 'Dictation',
		description:
			'For brain dumps: pauses never end it. Click the mic or press Space to start; Send when done.',
		icon: (
			<svg {...ICON_PROPS}>
				<path d="M2.5 4h8M2.5 7h6M2.5 10h4" />
				<path d="m9.5 12.5 3.75-3.75a1.06 1.06 0 0 0-1.5-1.5L8 11v1.5h1.5Z" />
			</svg>
		),
	},
	text: {
		name: 'Text only',
		description: 'No microphone. Type, and Voice OS stays quiet in this tab.',
		icon: (
			<svg {...ICON_PROPS}>
				<rect x="1.75" y="4" width="12.5" height="8" rx="1.75" />
				<path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.25 9.25h5.5" />
			</svg>
		),
	},
};

interface ModeListProps {
	mode: InputMode;
	modes: InputMode[];
	onChoose: (mode: InputMode) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	itemRefs?: { current: (HTMLButtonElement | null)[] };
	// What each mode says where the general copy would read wrong (a phone has no Space key).
	descriptions?: Partial<Record<InputMode, string>>;
}

// The modes as a menu: the voice bar's dropdown, and the phone's sheet over the conversation.
export const ModeList = ({
	mode,
	modes,
	onChoose,
	onKeyDown,
	itemRefs,
	descriptions = {},
}: ModeListProps) => (
	<div className="mode-menu" role="menu" aria-label="Listening mode" onKeyDown={onKeyDown}>
		<div className="mode-menu-title" aria-hidden="true">
			How Voice OS listens
		</div>
		{modes.map((option, index) => {
			const copy = MODE_COPY[option];
			const isChosen = option === mode;

			return (
				<button
					key={option}
					ref={(item) => {
						if (itemRefs) {
							itemRefs.current[index] = item;
						}
					}}
					type="button"
					role="menuitemradio"
					aria-checked={isChosen}
					className="mode-item"
					data-mode={option}
					onClick={() => onChoose(option)}
				>
					<span className="mode-tile">{copy.icon}</span>
					<span className="mode-text">
						<span className="mode-name">{copy.name}</span>
						<span className="mode-desc">{descriptions[option] ?? copy.description}</span>
					</span>
					<span className="mode-check" aria-hidden="true">
						{isChosen ? '✓' : ''}
					</span>
				</button>
			);
		})}
	</div>
);

interface ModeMenuProps {
	mode: InputMode;
	// The modes offered; in a Discord voice channel only the listening ones mean anything.
	modes?: InputMode[];
	onChoose: (mode: InputMode) => void;
	// A listening mode's stream is live.
	isOn: boolean;
	// On demand: "Voice OS" was heard.
	isAwake: boolean;
	// On demand: speech without "Voice OS" was just left alone.
	isIgnored: boolean;
	isDenied: boolean;
	title: string;
}

export const ModeMenu = ({
	mode,
	modes = INPUT_MODES,
	onChoose,
	isOn,
	isAwake,
	isIgnored,
	isDenied,
	title,
}: ModeMenuProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

	useEffect(() => {
		if (!isOpen) {
			return;
		}

		// Opens on the chosen mode, so Enter keeps it and arrows move from it.
		itemRefs.current[modes.indexOf(mode)]?.focus();
	}, [isOpen, mode, modes]);

	const dismiss = useCallback(() => setIsOpen(false), []);

	useClickOutside(isOpen, wrapRef, dismiss);

	const close = () => {
		setIsOpen(false);
		buttonRef.current?.focus();
	};

	const choose = (chosen: InputMode) => {
		onChoose(chosen);
		close();
	};

	const handleKey = (event: KeyboardEvent<HTMLDivElement>) =>
		handleMenuKey(event, { onEscape: close, onTab: dismiss });

	const stateClass = [isOn && 'on', isAwake && 'awake', isIgnored && 'ignored', isDenied && 'off']
		.filter(Boolean)
		.join(' ');

	return (
		<div className="mode-wrap" ref={wrapRef}>
			<button
				ref={buttonRef}
				type="button"
				className={`vo-mode mode-button ${stateClass}`}
				data-mode={mode}
				aria-label="Listening mode"
				aria-haspopup="menu"
				aria-expanded={isOpen}
				title={`${MODE_COPY[mode].name}: ${title}`}
				onClick={() => setIsOpen((wasOpen) => !wasOpen)}
			>
				<span className="mode-dot" aria-hidden="true" />
				{MODE_COPY[mode].name} <span aria-hidden="true">⌄</span>
			</button>
			{isOpen ? (
				<ModeList
					mode={mode}
					modes={modes}
					onChoose={choose}
					onKeyDown={handleKey}
					itemRefs={itemRefs}
				/>
			) : null}
		</div>
	);
};
