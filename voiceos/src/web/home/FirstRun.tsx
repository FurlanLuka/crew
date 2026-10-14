// crew's first run, on this Mac, as one full-screen moment: the opening's three ways in (Import,
// step by step, Skip); step by step picks projects, makes a workspace, watches its main worktree
// being made, then offers Voice OS or Set up. The wordmark stays at the top throughout. It shows
// until it is finished or skipped (onboarded.json); crew's own state says where its steps start.
import { useEffect, useRef, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { type UseCrew, isOk, useCrew, useCrewAction } from '../setup/api.js';
import { FailBlock, ResultLine } from '../setup/common.js';
import { describeIssue } from '../setup/derive.js';
import { isRunning, listFailedProjects } from '../setup/progress.js';
import { RunnerLine, StepLine } from '../setup/flow.js';
import type { CrewProject, CrewSetupStatus } from '../setup/types.js';
import { ProjectsStep } from './ProjectsStep.js';
import { WorkspaceStep } from './WorkspaceStep.js';
import {
	type FirstRunStep,
	PROGRESS_STEPS,
	describeReady,
	firstStepFor,
	isCleanFinish,
	listRunnerRows,
	progressOf,
} from './first-run.js';

const POLL_MS = 2000;
// A clean finish stays on screen long enough to be seen before the last step.
const READY_PAUSE_MS = 900;

interface PrepareStepProps {
	worktreeRef: string;
	onAskClaude: (prompt: string) => void;
	onReady: (status: CrewSetupStatus | null) => void;
}

const PrepareStep = ({ worktreeRef: ref, onAskClaude, onReady }: PrepareStepProps) => {
	const status: UseCrew<CrewSetupStatus> = useCrew<CrewSetupStatus>(
		LOCAL_MACHINE,
		{ type: 'setup_status', ref },
		{ pollMs: POLL_MS },
	);
	const action = useCrewAction(LOCAL_MACHINE);
	const data = status.data;
	const rows = listRunnerRows(data);
	const failed = listFailedProjects(data);
	const isClean = isCleanFinish(data);
	const isFinished = !isRunning(data);
	const percent = Math.round(progressOf(data) * 100);

	useEffect(() => {
		if (!isClean) {
			return;
		}

		const timer = setTimeout(() => onReady(data), READY_PAUSE_MS);

		return () => clearTimeout(timer);
	}, [isClean]);

	return (
		<div className="fr-col">
			<h1>Getting {ref} ready</h1>
			<p className="fr-lead">
				Checking out each project, copying its .env and installing its packages. This moves on by
				itself.
			</p>
			<div
				className="fr-bar"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
			>
				<div style={{ width: `${percent}%` }} />
			</div>
			<div className="fr-group">
				{rows.map((row) => (
					<RunnerLine key={row.project} row={row} />
				))}
				{rows.length === 0 && (
					<div className="fr-row">
						<span className="dot ring" />
						<span className="fr-row-text">
							<span className="m">Waiting for crew's runners…</span>
						</span>
					</div>
				)}
			</div>
			{failed.map((project) => {
				const issue = project.issues[0];
				const what = issue ? describeIssue(issue, { isNamed: false }) : 'failed';

				return (
					<FailBlock
						key={project.project}
						title={`${project.project}: ${what}`}
						log={issue?.detail}
						why={`Its install failed, so ${ref}'s session can read and change ${project.project}'s code but not run it. Fix it now, or carry on and fix it from Set up.`}
					>
						<button
							type="button"
							className="btn"
							onClick={() => onAskClaude(`Fix ${project.project} in ${ref}: ${what}.`)}
						>
							Fix with Claude
						</button>
						<button
							type="button"
							className="btn"
							disabled={action.isBusy}
							onClick={async () => {
								await action.run({ type: 'setup_rerun', ref, projects: [project.project] });
								status.refresh();
							}}
						>
							Retry
						</button>
					</FailBlock>
				);
			})}
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			{isFinished && failed.length > 0 && (
				<div className="fr-actions">
					<span />
					<button type="button" className="btn primary" onClick={() => onReady(data)}>
						Continue
					</button>
				</div>
			)}
		</div>
	);
};

interface ReadyStepProps {
	worktreeRef: string;
	status: CrewSetupStatus | null;
	onOpenVoice: () => void;
	onSetUp: () => void;
}

const ReadyStep = ({ worktreeRef: ref, status, onOpenVoice, onSetUp }: ReadyStepProps) => {
	const { lead, isNothingInstalled } = describeReady(status);
	const voiceRef = useRef<HTMLButtonElement | null>(null);
	const setupRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		(isNothingInstalled ? setupRef : voiceRef).current?.focus({ preventScroll: true });
	}, [isNothingInstalled]);

	return (
		<div className="fr-col fr-ready">
			<h1>{ref} is ready</h1>
			<p className="fr-lead">{lead}</p>
			<div className="launch-choices">
				<button
					ref={voiceRef}
					type="button"
					className={`launch-choice ${isNothingInstalled ? '' : 'last'}`}
					onClick={onOpenVoice}
				>
					<b>Open Voice OS</b>
					<span>Talk to your first session. It opens on {ref}.</span>
					<small>asks for the mic and keys first</small>
				</button>
				<button
					ref={setupRef}
					type="button"
					className={`launch-choice ${isNothingInstalled ? 'last' : ''}`}
					onClick={onSetUp}
				>
					<b>Go to Set up</b>
					<span>Projects, workspaces and machines. Add dev servers when you need them.</span>
					<small>crew's Home after this</small>
				</button>
			</div>
			<div className="launch-say">Enter opens the highlighted one</div>
		</div>
	);
};

export interface FirstRunProps {
	// The one worktree still being made when the page was opened: its progress, no opening.
	resume: string | null;
	openVoice: (ref: string) => void;
	askClaude: (prompt: string) => void;
	goSetup: () => void;
	goImport: () => void;
	markOnboarded: () => void;
}

interface WaysInProps {
	isReady: boolean;
	onImport: () => void;
	onStepByStep: () => void;
	onSkip: () => void;
}

// The opening's three ways in. Step by step is the one Enter takes.
const WaysIn = ({ isReady, onImport, onStepByStep, onSkip }: WaysInProps) => {
	const stepRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (isReady) {
			stepRef.current?.focus({ preventScroll: true });
		}
	}, [isReady]);

	return (
		<div className="fr-ways">
			<p className="fr-lead">
				Parallel worktrees of your projects, each on its own branch and ports, wired to each other.
				How do you want to start?
			</p>
			<div className="launch-choices">
				<button type="button" className="launch-choice" disabled={!isReady} onClick={onImport}>
					<b>Import</b>
					<span>Projects and workspaces from another machine's crew export.</span>
					<small>a crew-export.json</small>
				</button>
				<button
					ref={stepRef}
					type="button"
					className="launch-choice last"
					disabled={!isReady}
					onClick={onStepByStep}
				>
					<b>Set it up step by step</b>
					<span>
						Pick projects, group them into a workspace and watch its first worktree get ready.
					</span>
					<small>a few minutes</small>
				</button>
				<button type="button" className="launch-choice" onClick={onSkip}>
					<b>Skip</b>
					<span>Go straight to Set up and add things yourself, or ask Claude to.</span>
				</button>
			</div>
		</div>
	);
};

export const FirstRun = ({
	resume,
	openVoice,
	askClaude,
	goSetup,
	goImport,
	markOnboarded,
}: FirstRunProps) => {
	const projects = useCrew<CrewProject[]>(LOCAL_MACHINE, { type: 'ls_projects' });
	const pool = projects.data ?? [];
	const [step, setStep] = useState<FirstRunStep>(resume ? 'prepare' : 'intro');
	const [created, setCreated] = useState<string | null>(resume);
	const [finished, setFinished] = useState<CrewSetupStatus | null>(null);
	const isPoolRead = projects.data !== null;

	// Reaching the last step is the first run done: an emptied Mac later gets the empty board.
	useEffect(() => {
		if (step === 'ready') {
			markOnboarded();
		}
	}, [step]);

	return (
		<main className="first-run" data-stage={step} aria-label="First run">
			<div className="fr-mark" aria-hidden="true">
				<div className="wordmark">crew</div>
				<div className="tagline">your sessions, every machine</div>
			</div>
			{step === 'intro' && (
				// Step by step starts past what crew already has: never before its projects are read.
				<WaysIn
					isReady={isPoolRead}
					onImport={() => {
						markOnboarded();
						goImport();
					}}
					onStepByStep={() => setStep(firstStepFor(pool))}
					onSkip={() => {
						markOnboarded();
						goSetup();
					}}
				/>
			)}
			{PROGRESS_STEPS.some((each) => each.step === step) && (
				<StepLine
					titles={PROGRESS_STEPS.map((each) => each.title)}
					at={PROGRESS_STEPS.findIndex((each) => each.step === step)}
					label="First run"
				/>
			)}
			{step !== 'intro' && (
				<section className="fr-stage" key={step}>
					{step === 'projects' && (
						<ProjectsStep
							pool={pool}
							onPoolChanged={projects.refresh}
							onNext={() => setStep('workspace')}
						/>
					)}
					{step === 'workspace' && (
						<WorkspaceStep
							pool={pool}
							onBack={() => setStep('projects')}
							onCreated={(ref) => {
								setCreated(ref);
								setStep('prepare');
							}}
						/>
					)}
					{step === 'prepare' && created && (
						<PrepareStep
							worktreeRef={created}
							onAskClaude={askClaude}
							onReady={(status) => {
								setFinished(status);
								setStep('ready');
							}}
						/>
					)}
					{step === 'ready' && created && (
						<ReadyStep
							worktreeRef={created}
							status={finished}
							onOpenVoice={() => openVoice(created)}
							onSetUp={goSetup}
						/>
					)}
				</section>
			)}
		</main>
	);
};
