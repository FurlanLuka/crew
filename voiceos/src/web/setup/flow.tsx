// The pieces crew's guided flows share (the first run, import, export): tick rows, the line of
// steps, and a setup runner's row. Their styles are the first run's, in home.css (.fr-).
import type { ReactNode } from 'react';
import type { RunnerRow } from '../home/first-run.js';

const TICK = (
	<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
		<path
			d="M2.5 6.2 5 8.6l4.5-5"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

interface TickRowProps {
	name: string;
	sub: ReactNode;
	side: string;
	// The side said as a warning (a row that waits, or can't be ticked).
	isSideWarn?: boolean;
	isOn: boolean;
	// Absent: a row that is already decided, shown as it is.
	onToggle?: () => void;
	// Indented under the row it belongs to (a workspace's projects).
	isNested?: boolean;
}

export const TickRow = ({
	name,
	sub,
	side,
	isSideWarn = false,
	isOn,
	onToggle,
	isNested = false,
}: TickRowProps) => (
	<button
		type="button"
		className={`fr-row ${isNested ? 'nested' : ''}`}
		aria-pressed={isOn}
		disabled={!onToggle}
		onClick={onToggle}
		data-row={name}
	>
		<span className="fr-check">{TICK}</span>
		<span className="fr-row-text">
			<b>{name}</b>
			{typeof sub === 'string' ? <span className="m">{sub}</span> : sub}
		</span>
		<span className={`m fr-side ${isSideWarn ? 'c-warn' : ''}`}>{side}</span>
	</button>
);

export const toggle = (list: string[], item: string): string[] =>
	list.includes(item) ? list.filter((other) => other !== item) : [...list, item];

interface StepLineProps {
	titles: string[];
	// The current step's index; past the last, every step is done.
	at: number;
	label: string;
	// In the page's flow rather than pinned under the first run's wordmark.
	isInline?: boolean;
}

export const StepLine = ({ titles, at, label, isInline = false }: StepLineProps) => (
	<ol className={`fr-progress ${isInline ? 'inline' : ''}`} aria-label={label}>
		{titles.map((title, index) => (
			<li
				key={title}
				aria-current={index === at ? 'step' : undefined}
				data-state={index < at ? 'done' : index === at ? 'now' : 'later'}
			>
				{title}
			</li>
		))}
	</ol>
);

export const DOT_BY_STATE: Record<RunnerRow['state'], string> = {
	ok: 'ok',
	failed: 'ask',
	running: 'run',
	waiting: 'ring',
};

export const RunnerLine = ({ row }: { row: RunnerRow }) => (
	<div className="fr-row" data-runner={row.project} data-state={row.state}>
		<span className={`dot ${DOT_BY_STATE[row.state]}`} />
		<span className="fr-row-text">
			<b>{row.project}</b>
			<span className="m">
				{row.steps.length === 0
					? 'starting'
					: row.steps.map((step, index) => (
							<span key={`${step.name} ${index}`} data-step={step.state}>
								{index > 0 && ' · '}
								{step.name}
							</span>
						))}
			</span>
		</span>
		<span className="m fr-side">{row.side}</span>
	</div>
);
