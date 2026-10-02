// Import a crew export: the file, then every choice made up front (what needs one first, what will
// just happen, the workspaces those choices allow), then one Import that runs it all and makes each
// workspace's main worktree, then Voice OS or the board. Nothing happens until Import.
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { countOf } from '../count.js';
import { type RunnerRow, isCleanFinish, listRunnerRows } from '../home/first-run.js';
import { isOk, readCrewLine, runCrew, useCrew } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, type SetupContext } from './common.js';
import { DOT_BY_STATE, RunnerLine, StepLine, TickRow, toggle } from './flow.js';
import {
	CHOICE_LABELS,
	type Choice,
	type ChoiceKind,
	type ImportRun,
	blankChoice,
	buildRun,
	countOpen,
	describeSummary,
	optionsFor,
	readWorkspace,
	sectionOf,
	startChoices,
} from './import-plan.js';
import { isRunning } from './progress.js';
import { type PlanRow, readBundleMembers, readPlan } from './readers.js';
import type { CrewSetupStatus, CrewWorkspace } from './types.js';

const STEPS = ['File', 'Choose', 'Getting it ready'];
const POLL_MS = 2000;

type Step = 'file' | 'choose' | 'run' | 'done';

interface Loaded {
	bundle: string;
	fileName: string;
	rows: PlanRow[];
}

interface FileStepProps {
	ctx: SetupContext;
	onLoaded: (loaded: Loaded) => void;
}

const FileStep = ({ ctx, onLoaded }: FileStepProps) => {
	const [line, setLine] = useState('');
	const [isOver, setIsOver] = useState(false);

	const load = async (file: File) => {
		const bundle = await file.text();
		const reply = await runCrew(ctx.machine, { type: 'import_plan', bundle });

		if (isOk(reply) && reply.json !== undefined) {
			setLine('');
			onLoaded({ bundle, fileName: file.name, rows: readPlan(reply.json) });
		} else {
			setLine(readCrewLine(reply) || 'crew could not read that file.');
		}
	};

	const drop = (event: DragEvent) => {
		event.preventDefault();
		setIsOver(false);
		const file = event.dataTransfer.files[0];

		if (file) {
			void load(file);
		}
	};

	return (
		<>
			<label
				className={`fr-drop ${isOver ? 'over' : ''}`}
				onDragOver={(event) => {
					event.preventDefault();
					setIsOver(true);
				}}
				onDragLeave={() => setIsOver(false)}
				onDrop={drop}
			>
				<b>Drop crew-export.json here</b>
				<span className="fr-drop-note">
					saved by Export on the other machine, or by <code>crew export</code> there
				</span>
				<span className="btn sm">Choose a file</span>
				<input
					type="file"
					accept="application/json,.json"
					aria-label="Export file"
					hidden
					onChange={(event) => event.target.files?.[0] && void load(event.target.files[0])}
				/>
			</label>
			{line && (
				<p className="result-line bad" role="status">
					! {line}
				</p>
			)}
		</>
	);
};

interface ProjectChoiceRowProps {
	row: PlanRow;
	choice: Choice;
	// Why Replace mine is not offered here, if it isn't.
	replaceRefusal: string | null;
	onChange: (choice: Choice) => void;
}

const ProjectChoiceRow = ({ row, choice, replaceRefusal, onChange }: ProjectChoiceRowProps) => {
	const { options } = optionsFor(row);
	const isDecided = choice.kind !== null;

	return (
		<div className="fr-row fr-choice-row" data-project={row.name}>
			<span className={`dot ${isDecided ? 'ok' : 'ask'}`} />
			<span className="fr-row-text">
				<b>{row.name}</b>
				<span className="m">{describeRow(row)}</span>
			</span>
			<span className="m fr-side">
				{row.status === 'found' && choice.kind === 'mine' ? 'use mine' : ''}
			</span>
			{options.length > 1 && (
				<div className="fr-choice">
					<div className="seg">
						{options.map((kind) => (
							<button
								key={kind}
								type="button"
								aria-pressed={choice.kind === kind}
								disabled={kind === 'replace' && replaceRefusal !== null}
								title={kind === 'replace' ? (replaceRefusal ?? undefined) : undefined}
								onClick={() => onChange({ ...choice, kind })}
							>
								{kind === 'rename'
									? `${CHOICE_LABELS.rename} ${choice.rename}`
									: CHOICE_LABELS[kind]}
							</button>
						))}
					</div>
					{choice.kind === 'folder' && (
						<input
							type="text"
							aria-label={`Folder for ${row.name}`}
							placeholder="~/code/…"
							value={choice.path}
							onChange={(event) => onChange({ ...choice, path: event.target.value })}
						/>
					)}
					{choice.kind === 'rename' && (
						<input
							type="text"
							aria-label={`New name for ${row.name}`}
							value={choice.rename}
							onChange={(event) => onChange({ ...choice, rename: event.target.value })}
						/>
					)}
					{choice.kind === 'replace' && (
						<span className="m c-warn">
							{row.status === 'exists'
								? "the export's setup over yours; the checkout stays"
								: `a fresh clone replaces your ${row.name}`}
						</span>
					)}
				</div>
			)}
		</div>
	);
};

const describeRow = (row: PlanRow): string => {
	switch (row.status) {
		case 'exists':
			return `already here · ${row.detail}`;
		case 'clone':
			return `clone into ${row.detail}`;
		case 'found':
			return `already checked out at ${row.detail}`;
		case 'other remote':
			return `a different repo here has that name (${row.detail})`;
		case 'blocked':
			return row.detail;
		case 'missing':
			return 'no git remote in the export';
		default:
			return [row.status, row.detail].filter(Boolean).join(' · ');
	}
};

interface ChooseStepProps {
	ctx: SetupContext;
	loaded: Loaded;
	onImport: (run: ImportRun) => void;
}

const ChooseStep = ({ ctx, loaded, onImport }: ChooseStepProps) => {
	const here = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const [choices, setChoices] = useState<Record<string, Choice>>(() => startChoices(loaded.rows));
	const [unticked, setUnticked] = useState<string[]>([]);
	const [isConfirming, setIsConfirming] = useState(false);
	const members = readBundleMembers(loaded.bundle);
	const projects = loaded.rows.filter((row) => row.kind === 'project');
	const workspaceRows = loaded.rows.filter((row) => row.kind === 'workspace');
	const states = workspaceRows.map((row) =>
		readWorkspace(row, members.get(row.name) ?? [], projects, choices),
	);
	const ticked = states
		.filter((state) => state.blockedBy === null && !unticked.includes(state.name))
		.map((state) => state.name);
	const run = buildRun(loaded.rows, choices, ticked, loaded.bundle);
	const open = countOpen(loaded.rows, choices);
	const replaces = projects.filter((row) => choices[row.name]?.kind === 'replace');
	const total = run.projects.length + run.workspaces.length;
	const workspacesHere = (name: string) =>
		(here.data ?? []).filter((workspace) =>
			(workspace.projects ?? []).some((project) => project.name === name),
		);

	// crew refuses a fresh clone over a project whose worktrees hang off its checkout.
	const replaceRefusal = (row: PlanRow): string | null => {
		const holders = workspacesHere(row.name);

		return row.status === 'other remote' && holders.length
			? `${row.name} is in ${holders.map((workspace) => workspace.name).join(', ')} here: its worktrees use this checkout`
			: null;
	};

	const choiceRow = (row: PlanRow) => (
		<ProjectChoiceRow
			key={row.name}
			row={row}
			choice={choices[row.name] ?? blankChoice(row.name)}
			replaceRefusal={replaceRefusal(row)}
			onChange={(choice) => setChoices({ ...choices, [row.name]: choice })}
		/>
	);

	const needs = projects.filter((row) => sectionOf(row) === 'needs');
	const will = projects.filter((row) => sectionOf(row) === 'will');
	const already = projects.filter((row) => sectionOf(row) === 'here');

	return (
		<>
			<div className="fr-pills">
				{describeSummary(loaded.rows, choices, ticked).map((pill) => (
					<span key={pill.text} className={`fr-pill ${pill.tone}`}>
						{pill.text}
					</span>
				))}
			</div>
			{needs.length > 0 && (
				<section className="fr-group" aria-label="Needs a choice">
					<div className="fr-group-h">
						<span>Needs a choice</span>
						<span>nothing is done until you pick</span>
					</div>
					{needs.map(choiceRow)}
				</section>
			)}
			{will.length > 0 && (
				<section className="fr-group" aria-label="Will be done">
					<div className="fr-group-h">
						<span>Will be done</span>
						<span>{countOf(will.length, 'project')}</span>
					</div>
					{will.map(choiceRow)}
				</section>
			)}
			{states.length > 0 && (
				<section className="fr-group" aria-label="Workspaces">
					<div className="fr-group-h">
						<span>Workspaces</span>
						<span>each gets its main worktree</span>
					</div>
					{states.map((state) => {
						const isOn = ticked.includes(state.name);
						const side =
							state.blockedBy ??
							(state.waitsOn.length
								? `waits on ${state.waitsOn.join(', ')}`
								: `${state.name}/main`);

						return (
							<TickRow
								key={state.name}
								name={state.name}
								sub={
									<span className="fr-chips">
										{state.members.map((member) => (
											<span
												key={member}
												className={`fr-chip ${state.waitsOn.includes(member) ? 'warn' : ''}`}
											>
												{member}
											</span>
										))}
									</span>
								}
								side={side}
								isSideWarn={state.blockedBy !== null || state.waitsOn.length > 0}
								isOn={isOn}
								onToggle={
									state.blockedBy === null
										? () => setUnticked(toggle(unticked, state.name))
										: undefined
								}
							/>
						);
					})}
				</section>
			)}
			{already.length > 0 && (
				<details className="fr-group fr-fold">
					<summary className="fr-group-h">
						<span>Already here · {already.length}</span>
						<span>kept as it is</span>
					</summary>
					{already.map(choiceRow)}
				</details>
			)}
			<CommandLine
				commands={[...run.projects, ...run.workspaces].map((item) => item.command)}
				then={
					run.workspaces.length ? "each workspace's main is checked out and installed" : undefined
				}
			/>
			{isConfirming && (
				<div
					className="confirm"
					role="dialog"
					aria-label={`Replace ${replaces.map((row) => row.name).join(', ')}?`}
				>
					<b className="confirm-title">Replace {replaces.map((row) => row.name).join(', ')}?</b>
					<div className="fail">
						<ul className="cost">
							{replaces.map((row) => (
								<li key={row.name}>
									<b>{row.name}</b>{' '}
									<span className="m">
										{row.status === 'exists'
											? "the export's setup replaces yours; its checkout and worktrees stay"
											: "a fresh clone of the export's repo replaces yours"}
									</span>
								</li>
							))}
						</ul>
					</div>
					<div className="form-actions">
						<button type="button" className="btn danger" onClick={() => onImport(run)}>
							Replace and import
						</button>
						<button type="button" className="btn ghost" onClick={() => setIsConfirming(false)}>
							Back
						</button>
					</div>
				</div>
			)}
			<div className="fr-actions">
				<span className="m">
					{open
						? 'Pick for each one above: skipping is a choice too.'
						: 'Projects first, then each workspace makes its main worktree.'}
				</span>
				<button
					type="button"
					className="btn primary"
					disabled={open > 0 || total === 0 || isConfirming}
					onClick={() => (replaces.length ? setIsConfirming(true) : onImport(run))}
				>
					{open
						? `${countOf(open, 'choice')} left`
						: total
							? `Import ${countOf(total, 'item')}`
							: 'Nothing to import'}
				</button>
			</div>
		</>
	);
};

type ItemState = RunnerRow['state'];

interface ItemResult {
	name: string;
	// A workspace can share its name with one of its projects.
	kind: 'project' | 'workspace';
	state: ItemState;
	line: string;
}

interface WorkspaceRunnerProps {
	ctx: SetupContext;
	worktreeRef: string;
	onSettled: (ref: string, status: CrewSetupStatus | null) => void;
}

// One imported workspace's main worktree being made, read from crew like the first run's.
const WorkspaceRunner = ({ ctx, worktreeRef, onSettled }: WorkspaceRunnerProps) => {
	const status = useCrew<CrewSetupStatus>(
		ctx.machine,
		{ type: 'setup_status', ref: worktreeRef },
		{ pollMs: POLL_MS },
	);
	const isDone = status.data !== null && !isRunning(status.data);

	useEffect(() => {
		if (isDone) {
			onSettled(worktreeRef, status.data);
		}
	}, [isDone]);

	return (
		<>
			<div className="fr-group-h">
				<span>{worktreeRef}</span>
			</div>
			{listRunnerRows(status.data).map((row) => (
				<RunnerLine key={`${worktreeRef} ${row.project}`} row={row} />
			))}
		</>
	);
};

interface RunStepProps {
	ctx: SetupContext;
	run: ImportRun;
	onDone: (summary: DoneSummary) => void;
}

export interface DoneSummary {
	projects: number;
	workspaces: string[];
	failed: string[];
}

const RunStep = ({ ctx, run, onDone }: RunStepProps) => {
	const [items, setItems] = useState<ItemResult[]>(() =>
		[
			...run.projects.map((item) => ({ name: item.name, kind: 'project' as const })),
			...run.workspaces.map((item) => ({ name: item.name, kind: 'workspace' as const })),
		].map((item) => ({ ...item, state: 'waiting' as const, line: '' })),
	);
	const [refs, setRefs] = useState<string[]>([]);
	const [settled, setSettled] = useState<Record<string, CrewSetupStatus | null>>({});
	const hasStarted = useRef(false);

	useEffect(() => {
		if (hasStarted.current) {
			return;
		}

		hasStarted.current = true;

		const update = (index: number, patch: Partial<ItemResult>) =>
			setItems((now) => now.map((item, at) => (at === index ? { ...item, ...patch } : item)));

		void (async () => {
			const all = [...run.projects, ...run.workspaces];

			for (const [index, item] of all.entries()) {
				update(index, { state: 'running' });
				const reply = await runCrew(ctx.machine, item.command);
				update(index, {
					state: isOk(reply) ? 'ok' : 'failed',
					line: isOk(reply) ? '' : readCrewLine(reply) || 'crew refused.',
				});

				if (isOk(reply) && item.command.type === 'import_workspace') {
					setRefs((now) => [...now, `${item.name}/main`]);
				}
			}
		})();
	}, []);

	const isCommandsDone = items.every((item) => item.state === 'ok' || item.state === 'failed');
	const isAllSettled = isCommandsDone && refs.every((ref) => ref in settled);
	const failedWorktrees = Object.entries(settled)
		.filter(([, status]) => !isCleanFinish(status))
		.map(([ref]) => ref);
	const failed = [
		...items.filter((item) => item.state === 'failed').map((item) => item.name),
		...failedWorktrees,
	];
	const finished = items.filter((item) => item.state === 'ok' || item.state === 'failed').length;
	const percent = Math.round(
		((finished + Object.keys(settled).length) / Math.max(1, items.length + refs.length)) * 100,
	);
	const summary: DoneSummary = {
		projects: items.filter((item) => item.state === 'ok' && item.kind === 'project').length,
		workspaces: refs,
		failed,
	};

	useEffect(() => {
		if (isAllSettled && failed.length === 0) {
			const timer = setTimeout(() => onDone(summary), 900);

			return () => clearTimeout(timer);
		}
	}, [isAllSettled, failed.length]);

	return (
		<>
			<div
				className="fr-bar"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
			>
				<div style={{ width: `${percent}%` }} />
			</div>
			<section className="fr-group" aria-label="Importing">
				{items.map((item) => (
					<div
						key={`${item.kind} ${item.name}`}
						className="fr-row"
						data-item={item.name}
						data-state={item.state}
					>
						<span className={`dot ${DOT_BY_STATE[item.state]}`} />
						<span className="fr-row-text">
							<b>{item.name}</b>
							<span className={`m ${item.state === 'failed' ? 'c-crit' : ''}`}>
								{item.line || item.kind}
							</span>
						</span>
						<span className="m fr-side">{item.state === 'ok' ? 'done' : item.state}</span>
					</div>
				))}
				{refs.map((ref) => (
					<WorkspaceRunner
						key={ref}
						ctx={ctx}
						worktreeRef={ref}
						onSettled={(done, status) => setSettled((now) => ({ ...now, [done]: status }))}
					/>
				))}
			</section>
			{isAllSettled && failed.length > 0 && (
				<div className="fr-actions">
					<span className="m">
						{failed.join(', ')} failed: the board shows {failed.length === 1 ? 'it' : 'them'} with
						Fix with Claude.
					</span>
					<button type="button" className="btn primary" onClick={() => onDone(summary)}>
						Continue
					</button>
				</div>
			)}
		</>
	);
};

const describeDone = ({ projects, workspaces, failed }: DoneSummary): string =>
	[
		`${countOf(projects, 'project')} and ${countOf(workspaces.length, 'workspace')} came in.`,
		failed.length
			? `${failed.join(', ')} failed: the board has ${failed.length === 1 ? 'it' : 'them'}.`
			: '',
	]
		.filter(Boolean)
		.join(' ');

const DoneStep = ({ ctx, summary }: { ctx: SetupContext; summary: DoneSummary }) => {
	const first = summary.workspaces[0] ?? null;
	const voiceRef = useRef<HTMLButtonElement | null>(null);
	const boardRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		(first ? voiceRef : boardRef).current?.focus({ preventScroll: true });
	}, [first]);

	return (
		<div className="launch-choices">
			<button
				ref={voiceRef}
				type="button"
				className={`launch-choice ${first ? 'last' : ''}`}
				disabled={!first}
				onClick={() => first && ctx.openVoice(first)}
			>
				<b>Open Voice OS</b>
				<span>
					{first
						? `Talk to ${first}. The other new sessions are in Activate.`
						: 'No workspace came in to talk to.'}
				</span>
			</button>
			<button
				ref={boardRef}
				type="button"
				className={`launch-choice ${first ? '' : 'last'}`}
				onClick={() => ctx.go({ page: 'board', tab: 'projects' })}
			>
				<b>Go to the board</b>
				<span>See what came in, and set up what was skipped.</span>
			</button>
		</div>
	);
};

const TITLES: Record<Exclude<Step, 'choose'>, string> = {
	file: 'Import from another machine',
	run: 'Importing',
	done: 'Imported',
};

const STEP_AT: Record<Step, number> = { file: 0, choose: 1, run: 2, done: 3 };

export const ImportPage = ({ ctx }: { ctx: SetupContext }) => {
	const [step, setStep] = useState<Step>('file');
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [run, setRun] = useState<ImportRun | null>(null);
	const [summary, setSummary] = useState<DoneSummary | null>(null);
	const lead: Record<Step, string> = {
		file: 'An export holds projects by their git remote and which workspaces they are in. crew shows what it would do before it does anything.',
		choose: 'Pick for anything that needs it; the rest happens as listed.',
		run: "Bringing in the projects, then making each workspace's main worktree. This moves on by itself.",
		done: summary ? describeDone(summary) : '',
	};

	return (
		<section className="page narrow move" aria-label="Import">
			{step !== 'done' && <StepLine titles={STEPS} at={STEP_AT[step]} label="Import" isInline />}
			<PageHead
				title={step === 'choose' ? (loaded?.fileName ?? '') : TITLES[step]}
				lead={lead[step]}
			/>
			{step === 'file' && (
				<FileStep
					ctx={ctx}
					onLoaded={(next) => {
						setLoaded(next);
						setStep('choose');
					}}
				/>
			)}
			{step === 'choose' && loaded && (
				<ChooseStep
					key={loaded.bundle}
					ctx={ctx}
					loaded={loaded}
					onImport={(next) => {
						setRun(next);
						setStep('run');
					}}
				/>
			)}
			{step === 'run' && run && (
				<RunStep
					ctx={ctx}
					run={run}
					onDone={(next) => {
						setSummary(next);
						setStep('done');
					}}
				/>
			)}
			{step === 'done' && summary && <DoneStep ctx={ctx} summary={summary} />}
		</section>
	);
};
