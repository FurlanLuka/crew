// Home: the crew wordmark and two frosted cards, Voice OS and Set up. The last choice is outlined
// and focused, so Enter goes straight in. On a first run Voice OS is greyed: it needs a worktree.
import { useEffect, useRef, useState } from 'react';
import { listActiveRefs } from '../../shared/active.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { listWaitingRefs } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { useCrew } from '../setup/api.js';
import { type FirstRunStage, countNeedsYou, deriveFirstRun, isNotSetUp } from '../setup/derive.js';
import type { CrewProject, CrewWorktree } from '../setup/types.js';
import { type Half, readAlwaysVoice, readLastHalf, writeAlwaysVoice } from './prefs.js';
import { countOf } from '../count.js';

interface HomeProps {
	state: State;
	onPick: (half: Half) => void;
	// Once per visit, when crew's reads arrive: whether this is a first run (no worktree yet).
	onStage?: (isFirstRun: boolean) => void;
}

const VOICE_COPY: Record<FirstRunStage, { sub: string; meta: string }> = {
	empty: {
		sub: 'Add a project first: your sessions live here once you have one.',
		meta: 'nothing set up yet',
	},
	'has-projects': {
		sub: 'Make a workspace first: a session works in one of its worktrees.',
		meta: 'no worktree yet',
	},
	ready: {
		sub: 'Talk to your sessions on every machine: answer, follow along, switch.',
		meta: '',
	},
};

const describeVoiceMeta = (state: State): string => {
	const active = listActiveRefs(state);
	const waiting = listWaitingRefs(state).filter((ref) => active.includes(ref)).length;

	return [`${active.length} active`, waiting > 0 ? `${waiting} waiting on you` : '']
		.filter(Boolean)
		.join(' · ');
};

const describeSetupMeta = (projects: CrewProject[], worktrees: CrewWorktree[]): string => {
	const needs = countNeedsYou(projects, worktrees);

	if (needs > 0) {
		return `${countOf(needs, 'thing needs', 'things need')} you`;
	}

	const notSetUp = projects.filter(isNotSetUp).length;

	return notSetUp > 0
		? `${countOf(notSetUp, 'project')} not set up`
		: `${countOf(projects.length, 'project')} on This Mac`;
};

export const Home = ({ state, onPick, onStage }: HomeProps) => {
	const projects = useCrew<CrewProject[]>(LOCAL_MACHINE, { type: 'ls_projects' });
	const worktrees = useCrew<CrewWorktree[]>(LOCAL_MACHINE, { type: 'ls_worktrees' });
	const stage = deriveFirstRun(projects.data, worktrees.data);
	const isFirstRun = stage !== 'ready';
	const last: Half = isFirstRun ? 'setup' : readLastHalf();
	const voiceRef = useRef<HTMLButtonElement | null>(null);
	const setupRef = useRef<HTMLButtonElement | null>(null);
	const [isAlwaysVoice, setIsAlwaysVoice] = useState(readAlwaysVoice);

	const isLoaded = projects.data !== null && worktrees.data !== null;
	const hasDecided = useRef(false);

	useEffect(() => {
		(last === 'setup' ? setupRef : voiceRef).current?.focus({ preventScroll: true });
	}, [last]);

	useEffect(() => {
		if (!isLoaded || hasDecided.current) {
			return;
		}

		hasDecided.current = true;
		onStage?.(isFirstRun);
	}, [isLoaded]);

	return (
		<main className="launcher" aria-label="Home">
			<div className="launch-inner">
				<div className="home-title">
					<div className="wordmark lm">crew</div>
					<p>What would you like to do?</p>
				</div>
				<div className="launch-choices">
					<button
						ref={voiceRef}
						type="button"
						className={`launch-choice ${last === 'voice' ? 'last' : ''}`}
						disabled={isFirstRun}
						onClick={() => onPick('voice')}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							aria-hidden="true"
						>
							<path d="M3 12h3.5l2-6 3.5 12 2-6H21" />
						</svg>
						<b>Voice OS</b>
						<span>{VOICE_COPY[stage].sub}</span>
						<small>{isFirstRun ? VOICE_COPY[stage].meta : describeVoiceMeta(state)}</small>
					</button>
					<button
						ref={setupRef}
						type="button"
						className={`launch-choice ${last === 'setup' ? 'last' : ''}`}
						onClick={() => onPick('setup')}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
						</svg>
						<b>Set up</b>
						<span>Projects, workspaces and machines, with Claude to help.</span>
						<small>
							{isFirstRun
								? 'start here'
								: projects.data && worktrees.data
									? describeSetupMeta(projects.data, worktrees.data)
									: ' '}
						</small>
					</button>
				</div>
				{!isFirstRun && (
					<label className="launch-skip">
						<input
							type="checkbox"
							checked={isAlwaysVoice}
							onChange={(event) => {
								writeAlwaysVoice(event.target.checked);
								setIsAlwaysVoice(event.target.checked);
							}}
						/>{' '}
						Always open Voice OS
					</label>
				)}
				<div className="launch-say">Enter opens the highlighted one</div>
			</div>
		</main>
	);
};
