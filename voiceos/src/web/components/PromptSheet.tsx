// The parts every prompt docked above the voice bar is built from: the raised sheet with its dot,
// title and reason, the one line of words that answer it by voice, a command drawn for reading, and
// the field that opens inside the sheet for an answer in your own words.
import { type FormEvent, type KeyboardEvent, type ReactNode, useState } from 'react';
import { isSetupRef } from '../../shared/machine-ref.js';
import type { CommandSegment } from '../prompts.js';
import { focusOnMount } from './focus-on-mount.js';

type SheetTone = 'crit' | 'amber' | 'plain';

// Also the sheet's class: the styles and the tests find each kind by it.
type SheetKind = 'permission' | 'question' | 'plan' | 'confirm' | 'switch' | 'peer' | 'denied';

const DOT_CLASS: Record<SheetTone, string> = { crit: 'ask', amber: 'run', plain: 'plain' };

interface SheetProps {
	kind: SheetKind;
	label: string;
	tone: SheetTone;
	title: ReactNode;
	reason?: ReactNode;
	meta?: ReactNode;
	// One row: the question and its two answers side by side, for prompts with nothing to read.
	isRow?: boolean;
	children: ReactNode;
}

export const Sheet = ({
	kind,
	label,
	tone,
	title,
	reason,
	meta,
	isRow = false,
	children,
}: SheetProps) => (
	<section className={`sheet ${kind}${isRow ? ' row' : ''}`} aria-label={label}>
		<div className="sh-head">
			<i className={`dot ${DOT_CLASS[tone]}`} aria-hidden="true" />
			<div className="sh-title">
				<span>{title}</span>
				{reason ? <span className="sh-reason">{reason}</span> : null}
			</div>
			{meta ? <div className="sh-meta">{meta}</div> : null}
		</div>
		{children}
	</section>
);

interface SheetFootProps {
	sessionRef: string;
	say: string;
	children: ReactNode;
}

// A setup session's prompts are answered in Set up's chat and never heard: no words to say.
export const SheetFoot = ({ sessionRef, say, children }: SheetFootProps) => (
	<div className="sh-foot">
		{isSetupRef(sessionRef) ? null : <span className="sh-say">{say}</span>}
		<div className="sh-btns">{children}</div>
	</div>
);

export const CommandBlock = ({ segments }: { segments: CommandSegment[] }) => (
	<pre className="sh-cmd">
		<span className="pr" aria-hidden="true">
			$
		</span>
		{segments.map((segment, index) => (
			<span key={index} className={segment.role === 'arg' ? undefined : segment.role}>
				{segment.text}
			</span>
		))}
	</pre>
);

interface OwnAnswerProps {
	// Says what sending does, before the field ("Deny, and tell it").
	lead?: string;
	placeholder: string;
	submitLabel: string;
	onSubmit: (text: string) => void;
	onCancel: () => void;
}

export const OwnAnswer = ({
	lead,
	placeholder,
	submitLabel,
	onSubmit,
	onCancel,
}: OwnAnswerProps) => {
	const [text, setText] = useState('');
	const trimmed = text.trim();

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		if (trimmed) {
			onSubmit(trimmed);
		}
	};

	const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Escape') {
			// Handled here: Esc in the field backs out of the answer, nothing else.
			event.preventDefault();
			onCancel();
		}
	};

	return (
		<form className="sh-own" onSubmit={handleSubmit}>
			{lead ? <span className="sh-own-lead">{lead}</span> : null}
			<input
				ref={focusOnMount}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={handleKey}
				placeholder={placeholder}
				aria-label={placeholder}
				autoComplete="off"
			/>
			<button type="button" className="btn ghost" onClick={onCancel}>
				Cancel
			</button>
			<button type="submit" className="btn primary" disabled={!trimmed}>
				{submitLabel}
			</button>
		</form>
	);
};

export interface OwnAnswerState {
	isOpen: boolean;
	open: () => void;
	cancel: () => void;
	// On the button that opens the field: focus is back on it after Cancel or Esc, not on first show.
	openerRef: ((element: HTMLElement | null) => void) | undefined;
}

export const useOwnAnswer = (): OwnAnswerState => {
	const [isOpen, setIsOpen] = useState(false);
	const [wasCancelled, setWasCancelled] = useState(false);

	return {
		isOpen,
		open: () => setIsOpen(true),
		cancel: () => {
			setIsOpen(false);
			setWasCancelled(true);
		},
		openerRef: wasCancelled ? focusOnMount : undefined,
	};
};
