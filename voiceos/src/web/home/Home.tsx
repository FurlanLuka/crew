// Home: the crew wordmark and two frosted cards, Voice OS and Set up. The last choice is outlined
// and focused, so Enter goes straight in. On a first run Home is the first run instead.
import { useEffect, useRef, useState } from 'react';
import { listActiveRefs } from '../../shared/active.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { listWaitingRefs } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { useCrew } from '../setup/api.js';
import { type FirstRunDecision, decideFirstRun, describeSetupMeta } from '../setup/derive.js';
import type { CrewProject, CrewWorktree } from '../setup/types.js';
import { FirstRun } from './FirstRun.js';
import { type Half, readAlwaysVoice, readLastHalf, writeAlwaysVoice } from './prefs.js';

interface HomeProps {
	state: State;
	onPick: (half: Half) => void;
	// Once per visit, when crew's reads arrive: whether this is a first run (no worktree yet, or its
	// one worktree still installing).
	onStage?: (isFirstRun: boolean) => void;
	openVoice: (ref: string) => void;
	askClaude: (prompt: string) => void;
	goSetup: () => void;
}

const describeVoiceMeta = (state: State): string => {
	const active = listActiveRefs(state);
	const waiting = listWaitingRefs(state).filter((ref) => active.includes(ref)).length;

	return [`${active.length} active`, waiting > 0 ? `${waiting} waiting on you` : '']
		.filter(Boolean)
		.join(' · ');
};

export const Home = ({ state, onPick, onStage, openVoice, askClaude, goSetup }: HomeProps) => {
	const projects = useCrew<CrewProject[]>(LOCAL_MACHINE, { type: 'ls_projects' });
	const worktrees = useCrew<CrewWorktree[]>(LOCAL_MACHINE, { type: 'ls_worktrees' });
	// Decided once per visit: the first run makes a worktree, and must not be swapped for the
	// launcher under the developer while it does.
	const [decision, setDecision] = useState<FirstRunDecision | null>(null);
	const read = decideFirstRun(projects.data, worktrees.data);

	useEffect(() => {
		if (decision || !read) {
			return;
		}

		setDecision(read);
		onStage?.(read.isFirstRun);
	}, [decision, read]);

	if (!decision) {
		return <main className="launcher" aria-label="Home" aria-busy="true" />;
	}

	if (decision.isFirstRun) {
		return (
			<FirstRun
				resume={decision.installing}
				openVoice={openVoice}
				askClaude={askClaude}
				goSetup={goSetup}
			/>
		);
	}

	return (
		<Launcher
			state={state}
			onPick={onPick}
			setupMeta={
				projects.data && worktrees.data ? describeSetupMeta(projects.data, worktrees.data) : ' '
			}
		/>
	);
};

interface LauncherProps {
	state: State;
	onPick: (half: Half) => void;
	setupMeta: string;
}

const Launcher = ({ state, onPick, setupMeta }: LauncherProps) => {
	const last = readLastHalf();
	const voiceRef = useRef<HTMLButtonElement | null>(null);
	const setupRef = useRef<HTMLButtonElement | null>(null);
	const [isAlwaysVoice, setIsAlwaysVoice] = useState(readAlwaysVoice);

	useEffect(() => {
		(last === 'setup' ? setupRef : voiceRef).current?.focus({ preventScroll: true });
	}, [last]);

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
						<span>Talk to your sessions on every machine: answer, follow along, switch.</span>
						<small>{describeVoiceMeta(state)}</small>
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
						<small>{setupMeta}</small>
					</button>
				</div>
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
				<div className="launch-say">Enter opens the highlighted one</div>
			</div>
		</main>
	);
};
