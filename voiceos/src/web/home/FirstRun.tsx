// crew's first run, on this Mac, as one full-screen moment: the opening, then pick projects, make a
// workspace, watch its main worktree being made, and choose Voice OS or Set up. The wordmark stays
// at the top throughout. Nothing about it is stored: crew's own state says where it can start.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { countOf } from '../count.js';
import { nameFromPath, nameFromUrl } from '../setup/AddProject.js';
import { type UseCrew, isOk, useCrew, useCrewAction } from '../setup/api.js';
import { CommandLine } from '../setup/CommandLine.js';
import { FailBlock, ResultLine } from '../setup/common.js';
import { describeIssue } from '../setup/derive.js';
import { isRunning, listFailedProjects } from '../setup/progress.js';
import { readCheckouts } from '../setup/readers.js';
import type { CrewProject, CrewSetupStatus, CrewWorkspace } from '../setup/types.js';
import {
	type FirstRunStep,
	PROGRESS_STEPS,
	type RunnerRow,
	describeReady,
	firstStepFor,
	isCleanFinish,
	listRunnerRows,
	progressOf,
} from './first-run.js';

const POLL_MS = 2000;
// A clean finish stays on screen long enough to be seen before the last step.
const READY_PAUSE_MS = 900;
const SEARCHED = '~/code, ~/projects, ~/dev, ~/src, ~/Developer, ~/work or ~/repos';

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
	sub: string;
	side: string;
	isOn: boolean;
	// Absent: a row that is already decided (a project crew has), shown ticked.
	onToggle?: () => void;
}

const TickRow = ({ name, sub, side, isOn, onToggle }: TickRowProps) => (
	<button
		type="button"
		className="fr-row"
		aria-pressed={isOn}
		disabled={!onToggle}
		onClick={onToggle}
		data-checkout={name}
	>
		<span className="fr-check">{TICK}</span>
		<span className="fr-row-text">
			<b>{name}</b>
			<span className="m">{sub}</span>
		</span>
		<span className="m fr-side">{side}</span>
	</button>
);

const toggle = (list: string[], item: string): string[] =>
	list.includes(item) ? list.filter((other) => other !== item) : [...list, item];

type AdderKind = 'url' | 'path';

// "Add by URL" / "Add a folder": one field in the projects card, crew's own refusal under it.
const Adder = ({ kind, onAdded }: { kind: AdderKind; onAdded: () => void }) => {
	const action = useCrewAction(LOCAL_MACHINE);
	const [value, setValue] = useState('');
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const source = value.trim();

	useEffect(() => fieldRef.current?.focus(), []);
	const name = kind === 'url' ? nameFromUrl(source) : nameFromPath(source);
	const command: SetupCommand | null =
		source && name
			? kind === 'url'
				? { type: 'add_project', name, url: source }
				: { type: 'add_project', name, path: source }
			: null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await action.run(command))) {
			setValue('');
			onAdded();
		}
	};

	return (
		<form className="fr-adder" onSubmit={(event) => void submit(event)}>
			<label className="field">
				<span>{kind === 'url' ? 'Git URL' : 'Folder'}</span>
				<input
					type="text"
					autoComplete="off"
					spellCheck={false}
					ref={fieldRef}
					placeholder={kind === 'url' ? 'https://github.com/acme/payments.git' : '~/code/payments'}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>
			<CommandLine commands={[command]} />
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="row-actions">
				<button type="submit" className="btn" disabled={!command || action.isBusy}>
					{action.isBusy ? 'Adding…' : `Add ${name || 'project'}`}
				</button>
			</div>
		</form>
	);
};

interface ProjectsStepProps {
	pool: CrewProject[];
	onPoolChanged: () => void;
	onNext: () => void;
}

const ProjectsStep = ({ pool, onPoolChanged, onNext }: ProjectsStepProps) => {
	const scan = useCrew<unknown>(LOCAL_MACHINE, { type: 'scan_checkouts' });
	const action = useCrewAction(LOCAL_MACHINE);
	const [unticked, setUnticked] = useState<string[]>([]);
	const [adder, setAdder] = useState<AdderKind | null>(null);
	const known = new Set(pool.map((project) => project.name));
	const found = readCheckouts(scan.data).filter((row) => !row.known && !known.has(row.name));
	const ticked = found.filter((row) => !unticked.includes(row.path));
	const commands: SetupCommand[] = ticked.map((row) => ({
		type: 'add_project',
		name: row.name,
		path: row.path,
	}));
	const label =
		ticked.length > 0
			? `Add ${countOf(ticked.length, 'project')}`
			: pool.length > 0
				? 'Continue'
				: 'Pick a project';

	const next = async () => {
		try {
			for (const command of commands) {
				if (!isOk(await action.run(command))) {
					return;
				}
			}

			onNext();
		} finally {
			// Read again either way: a refusal halfway leaves the ones before it added.
			onPoolChanged();
		}
	};

	return (
		<div className="fr-col">
			<h1>Pick your projects</h1>
			<p className="fr-lead">
				{scan.isLoading
					? 'Looking for git checkouts in your usual code folders…'
					: found.length > 0
						? 'crew found these git checkouts on this Mac. It only lists them: nothing is read or changed until you add one.'
						: `No new git checkouts in ${SEARCHED}. Add one by URL or folder.`}
			</p>
			{(pool.length > 0 || found.length > 0) && (
				<div className="fr-group">
					{pool.map((project) => (
						<TickRow
							key={project.name}
							name={project.name}
							sub={project.path ?? ''}
							side="added"
							isOn
						/>
					))}
					{found.map((row) => (
						<TickRow
							key={row.path}
							name={row.name}
							sub={row.path}
							side={row.remote}
							isOn={!unticked.includes(row.path)}
							onToggle={() => setUnticked(toggle(unticked, row.path))}
						/>
					))}
				</div>
			)}
			<div className="row-actions">
				<button
					type="button"
					className="btn"
					aria-pressed={adder === 'url'}
					onClick={() => setAdder(adder === 'url' ? null : 'url')}
				>
					Add by URL
				</button>
				<button
					type="button"
					className="btn"
					aria-pressed={adder === 'path'}
					onClick={() => setAdder(adder === 'path' ? null : 'path')}
				>
					Add a folder
				</button>
			</div>
			{adder && (
				<Adder
					key={adder}
					kind={adder}
					onAdded={() => {
						setAdder(null);
						onPoolChanged();
					}}
				/>
			)}
			<CommandLine commands={commands} />
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="fr-actions">
				<span className="m">You can add more later in Set up.</span>
				<button
					type="button"
					className="btn primary"
					disabled={(ticked.length === 0 && pool.length === 0) || action.isBusy}
					onClick={() => void next()}
				>
					{action.isBusy ? 'Adding…' : label}
				</button>
			</div>
		</div>
	);
};

interface WorkspaceStepProps {
	pool: CrewProject[];
	onBack: () => void;
	onCreated: (ref: string) => void;
}

const WorkspaceStep = ({ pool, onBack, onCreated }: WorkspaceStepProps) => {
	const workspaces = useCrew<CrewWorkspace[]>(LOCAL_MACHINE, { type: 'ls_workspaces' });
	const action = useCrewAction(LOCAL_MACHINE);
	const [name, setName] = useState<string | null>(null);
	const [unticked, setUnticked] = useState<string[]>([]);
	const workspace = (name ?? pool[0]?.name ?? '').trim();
	const members = pool.map((project) => project.name).filter((each) => !unticked.includes(each));
	// A workspace made earlier from the CLI has no worktree yet: joining it adds only the members it
	// lacks (crew refuses one it has) and makes main itself.
	const existing = (workspaces.data ?? []).find((each) => each.name === workspace);
	const has = new Set((existing?.projects ?? []).map((project) => project.name));
	const joining = members.filter((member) => !has.has(member));
	const commands: SetupCommand[] =
		!workspace || members.length === 0
			? []
			: existing
				? [
						...(joining.length
							? [{ type: 'add_workspace' as const, name: workspace, projects: joining }]
							: []),
						{ type: 'add_worktree', ref: `${workspace}/main` },
					]
				: [{ type: 'add_workspace', name: workspace, projects: members }];

	const create = async () => {
		try {
			for (const command of commands) {
				if (!isOk(await action.run(command))) {
					return;
				}
			}

			onCreated(`${workspace}/main`);
		} finally {
			// Read again either way: a join that went through before main was refused must not be sent
			// twice.
			workspaces.refresh();
		}
	};

	return (
		<div className="fr-col">
			<h1>Make a workspace</h1>
			<p className="fr-lead">
				A workspace is the projects you work on together. crew makes its first working copy,{' '}
				<b>main</b>, and that is where your first session lives.
			</p>
			<div className="fr-group fr-pad">
				<label className="field">
					<span>Name</span>
					<input
						type="text"
						autoComplete="off"
						spellCheck={false}
						value={name ?? pool[0]?.name ?? ''}
						onChange={(event) => setName(event.target.value)}
					/>
					<small>your session: {workspace || '<name>'}/main</small>
				</label>
			</div>
			<div className="fr-group">
				{pool.map((project) => (
					<TickRow
						key={project.name}
						name={project.name}
						sub={project.path ?? ''}
						side="worktree"
						isOn={!unticked.includes(project.name)}
						onToggle={() => setUnticked(toggle(unticked, project.name))}
					/>
				))}
			</div>
			<CommandLine
				commands={commands}
				then="main is checked out, its .env copied and each project installed"
			/>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="fr-actions">
				<button type="button" className="btn ghost" onClick={onBack}>
					Back
				</button>
				<button
					type="button"
					className="btn primary"
					// Which commands Create runs depends on crew's workspaces: never before they are read.
					disabled={commands.length === 0 || workspaces.data === null || action.isBusy}
					onClick={() => void create()}
				>
					{action.isBusy ? 'Creating…' : `Create ${workspace || 'workspace'}`}
				</button>
			</div>
		</div>
	);
};

const RunnerLine = ({ row }: { row: RunnerRow }) => (
	<div className="fr-row" data-runner={row.project} data-state={row.state}>
		<span
			className={`dot ${row.state === 'ok' ? 'ok' : row.state === 'failed' ? 'ask' : row.state === 'running' ? 'run' : 'ring'}`}
		/>
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
						why={`${ref} is ready, except ${project.project}: its install failed, so its session can read and change the code but not run it. Fix it now, or carry on and fix it from Set up.`}
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

const StepLine = ({ step }: { step: FirstRunStep }) => {
	const at = PROGRESS_STEPS.findIndex((each) => each.step === step);

	return (
		<ol className="fr-progress" aria-label="First run">
			{PROGRESS_STEPS.map((each, index) => (
				<li
					key={each.step}
					aria-current={index === at ? 'step' : undefined}
					data-state={index < at ? 'done' : index === at ? 'now' : 'later'}
				>
					{each.title}
				</li>
			))}
		</ol>
	);
};

export interface FirstRunProps {
	// The one worktree still being made when the page was opened: its progress, no opening.
	resume: string | null;
	openVoice: (ref: string) => void;
	askClaude: (prompt: string) => void;
	goSetup: () => void;
}

export const FirstRun = ({ resume, openVoice, askClaude, goSetup }: FirstRunProps) => {
	const projects = useCrew<CrewProject[]>(LOCAL_MACHINE, { type: 'ls_projects' });
	const pool = projects.data ?? [];
	const [step, setStep] = useState<FirstRunStep>(resume ? 'prepare' : 'intro');
	const [created, setCreated] = useState<string | null>(resume);
	const [finished, setFinished] = useState<CrewSetupStatus | null>(null);
	const startRef = useRef<HTMLButtonElement | null>(null);
	const isPoolRead = projects.data !== null;

	// Enter goes in once crew has said what this Mac has: the step after the opening depends on it.
	useEffect(() => {
		if (step === 'intro' && isPoolRead) {
			startRef.current?.focus({ preventScroll: true });
		}
	}, [step, isPoolRead]);

	return (
		<main className="first-run" data-stage={step} aria-label="First run">
			<div className="fr-mark" aria-hidden="true">
				<div className="wordmark">crew</div>
				<div className="tagline">your sessions, every machine</div>
			</div>
			{step === 'intro' && (
				<div className="fr-go">
					<button
						type="button"
						className="btn primary"
						ref={startRef}
						disabled={!isPoolRead}
						onClick={() => setStep(firstStepFor(pool))}
					>
						Get started
					</button>
				</div>
			)}
			{PROGRESS_STEPS.some((each) => each.step === step) && <StepLine step={step} />}
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
