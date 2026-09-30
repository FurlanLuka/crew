import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
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
};

interface ModeMenuProps {
	mode: InputMode;
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
		itemRefs.current[INPUT_MODES.indexOf(mode)]?.focus();

		const closeOutside = (event: PointerEvent) => {
			if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) {
				setIsOpen(false);
			}
		};

		document.addEventListener('pointerdown', closeOutside);

		return () => document.removeEventListener('pointerdown', closeOutside);
	}, [isOpen, mode]);

	const close = () => {
		setIsOpen(false);
		buttonRef.current?.focus();
	};

	const choose = (chosen: InputMode) => {
		onChoose(chosen);
		close();
	};

	const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const active = document.activeElement;
		const focused = active instanceof HTMLButtonElement ? itemRefs.current.indexOf(active) : -1;

		const move = (step: number) => {
			event.preventDefault();
			itemRefs.current[(focused + step + INPUT_MODES.length) % INPUT_MODES.length]?.focus();
		};

		switch (event.key) {
			case 'ArrowDown':
				move(1);
				break;
			case 'ArrowUp':
				move(-1);
				break;
			case 'Escape':
				event.preventDefault();
				close();
				break;
			case 'Tab':
				setIsOpen(false);
				break;
		}
	};

	const stateClass = [isOn && 'on', isAwake && 'awake', isIgnored && 'ignored', isDenied && 'off']
		.filter(Boolean)
		.join(' ');

	return (
		<div className="mode-wrap" ref={wrapRef}>
			<button
				ref={buttonRef}
				type="button"
				className={`mode-button ${stateClass}`}
				data-mode={mode}
				aria-label="Listening mode"
				aria-haspopup="menu"
				aria-expanded={isOpen}
				title={`${MODE_COPY[mode].name}: ${title}`}
				onClick={() => setIsOpen((wasOpen) => !wasOpen)}
			>
				{MODE_COPY[mode].icon}
			</button>
			{isOpen ? (
				<div
					className="mode-menu"
					role="menu"
					aria-label="Listening mode"
					onKeyDown={handleMenuKey}
				>
					<div className="mode-menu-title" aria-hidden="true">
						How Voice OS listens
					</div>
					{INPUT_MODES.map((option, index) => {
						const copy = MODE_COPY[option];
						const isChosen = option === mode;

						return (
							<button
								key={option}
								ref={(item) => {
									itemRefs.current[index] = item;
								}}
								type="button"
								role="menuitemradio"
								aria-checked={isChosen}
								className="mode-item"
								onClick={() => choose(option)}
							>
								<span className="mode-tile">{copy.icon}</span>
								<span className="mode-text">
									<span className="mode-name">{copy.name}</span>
									<span className="mode-desc">{copy.description}</span>
								</span>
								<span className="mode-check" aria-hidden="true">
									{isChosen ? '✓' : ''}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
};
