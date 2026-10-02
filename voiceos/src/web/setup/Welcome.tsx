// First run, on this Mac: pick the checkouts crew found, group the ones that run together into a
// workspace (its main worktree is checked out and installed here), then open it in Voice OS.
// Nothing about the onboarding is stored: crew's own state says which step you're on.
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { FailBlock, ResultLine, type SetupContext } from './common.js';
import { describeIssue } from './derive.js';
import { ProgressBox, isRunning, listFailedProjects, listProgressLines } from './progress.js';
import type { CrewProject, CrewSetupStatus } from './types.js';
import { countOf } from '../count.js';

const POLL_MS = 2000;

export interface FoundCheckout {
	name: string;
	path: string;
	remote: string;
	known: boolean;
}

// crew add project --scan --json.
export const readCheckouts = (json: unknown): FoundCheckout[] =>
	(Array.isArray(json) ? json : []).flatMap((raw): FoundCheckout[] => {
		if (!raw || typeof raw !== 'object') {
			return [];
		}

		const row = raw as Record<string, unknown>;

		return typeof row.name === 'string' && typeof row.path === 'string'
			? [
					{
						name: row.name,
						path: row.path,
						remote: String(row.remote ?? ''),
						known: row.known === true,
					},
				]
			: [];
	});

export type WelcomeStep = 'pick' | 'workspace' | 'creating';

interface WelcomeProps {
	ctx: SetupContext;
	onDone?: () => void;
}

const PickStep = ({ ctx, onAdded }: { ctx: SetupContext; onAdded: () => void }) => {
	const scan = useCrew<unknown>(LOCAL_MACHINE, { type: 'scan_checkouts' });
	const action = useCrewAction(LOCAL_MACHINE);
	const found = readCheckouts(scan.data).filter((row) => !row.known);
	const [unticked, setUnticked] = useState<string[]>([]);
	const ticked = found.filter((row) => !unticked.includes(row.path));
	const commands = ticked.map((row) => ({
		type: 'add_project' as const,
		name: row.name,
		path: row.path,
	}));

	const add = async () => {
		for (const command of commands) {
			if (!isOk(await action.run(command))) {
				return;
			}
		}

		onAdded();
	};

	return (
		<div className="fr-body">
			<p>
				{scan.isLoading
					? 'Looking for git checkouts in your usual code folders…'
					: found.length
						? 'Git checkouts crew found in your code folders. Tick the ones you work on: crew records where they are and changes nothing in them.'
						: 'crew found no git checkouts in ~/code, ~/projects, ~/dev, ~/src, ~/Developer, ~/work or ~/repos. Add one by URL or path.'}
			</p>
			{found.length > 0 && (
				<div className="picks">
					{found.map((row) => (
						<label key={row.path} className="pick" data-checkout={row.name}>
							<input
								type="checkbox"
								checked={!unticked.includes(row.path)}
								onChange={(event) =>
									setUnticked(
										event.target.checked
											? unticked.filter((path) => path !== row.path)
											: [...unticked, row.path],
									)
								}
							/>
							<span className="sub">
								<b>{row.name}</b>
								<span className="m">
									{row.path}
									{row.remote ? ` · ${row.remote}` : ''}
								</span>
							</span>
						</label>
					))}
				</div>
			)}
			<CommandLine commands={commands} />
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="row-actions">
				<button
					type="button"
					className="btn primary"
					disabled={ticked.length === 0 || action.isBusy}
					onClick={() => void add()}
				>
					{action.isBusy ? 'Adding…' : `Add ${countOf(ticked.length, 'project')}`}
				</button>
				<button type="button" className="btn" onClick={() => ctx.go({ page: 'project-new' })}>
					Add by URL or path
				</button>
				<button type="button" className="btn ghost" onClick={() => ctx.go({ page: 'import' })}>
					Import from another machine
				</button>
			</div>
		</div>
	);
};

interface WorkspaceStepProps {
	projects: CrewProject[];
	onCreated: (workspace: string) => void;
}

const WorkspaceStep = ({ projects, onCreated }: WorkspaceStepProps) => {
	const action = useCrewAction(LOCAL_MACHINE);
	const first = projects[0]?.name ?? '';
	const [name, setName] = useState<string | null>(null);
	const [members, setMembers] = useState<string[] | null>(null);
	const workspace = (name ?? first).trim();
	const picked = members ?? (first ? [first] : []);
	const command =
		workspace && picked.length
			? { type: 'add_workspace' as const, name: workspace, projects: picked }
			: null;

	const create = async () => {
		if (command && isOk(await action.run(command))) {
			onCreated(workspace);
		}
	};

	return (
		<div className="fr-body">
			<p>
				A workspace is the projects that run together, like a frontend and the API it calls. Its
				first worktree, <b>main</b>, is a working copy of each one on its own branch: that's what
				you talk to in Voice OS. The other projects wait on the board.
			</p>
			<label className="field">
				<span>Workspace name</span>
				<input
					type="text"
					autoComplete="off"
					value={name ?? first}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<div className="picks">
				{projects.map((project) => (
					<label key={project.name} className="pick">
						<input
							type="checkbox"
							checked={picked.includes(project.name)}
							onChange={(event) =>
								setMembers(
									event.target.checked
										? [...picked, project.name]
										: picked.filter((other) => other !== project.name),
								)
							}
						/>
						<span className="sub">
							<b>{project.name}</b>
							<span className="m">worktree</span>
						</span>
					</label>
				))}
			</div>
			<CommandLine
				commands={[command]}
				then="main is checked out, its .env copied and each project installed"
			/>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="row-actions">
				<button
					type="button"
					className="btn primary"
					disabled={!command || action.isBusy}
					onClick={() => void create()}
				>
					{action.isBusy ? 'Creating…' : 'Create workspace'}
				</button>
			</div>
		</div>
	);
};

interface CreatingStepProps {
	ctx: SetupContext;
	workspace: string;
	onBoard: () => void;
}

const CreatingStep = ({ ctx, workspace, onBoard }: CreatingStepProps) => {
	const ref = `${workspace}/main`;
	const status = useCrew<CrewSetupStatus>(
		LOCAL_MACHINE,
		{ type: 'setup_status', ref },
		{ pollMs: POLL_MS },
	);
	const action = useCrewAction(LOCAL_MACHINE);
	const data = status.data;
	const isDone = data !== null && !isRunning(data);
	const failed = listFailedProjects(data);

	return (
		<div className="fr-body">
			<ProgressBox lines={listProgressLines(data)} empty="Waiting for crew's runners…" />
			{isDone && (
				<div className="fr-next">
					{failed.map((project) => {
						const issue = project.issues[0];

						return (
							<FailBlock
								key={project.project}
								title={`${project.project}: ${issue ? describeIssue(issue, { isNamed: false }) : 'failed'}`}
								log={issue?.detail}
								why={`${ref} is ready, except ${project.project}: its install failed, so its session can read and change the code but not run it. Fix it now, or carry on and fix it from the board.`}
							>
								<button
									type="button"
									className="btn"
									onClick={() =>
										ctx.askClaude(
											`Fix ${project.project} in ${ref}: ${issue ? describeIssue(issue, { isNamed: false }) : 'its install failed'}.`,
										)
									}
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
					{failed.length === 0 && (
						<p>
							<b>{ref}</b> is ready. Its session can read, change and test the code now; to run the
							app, set its dev servers up in Set up, or ask the session to work them out.
						</p>
					)}
					<div className="row-actions">
						<button type="button" className="btn primary" onClick={() => ctx.openVoice(ref)}>
							Open Voice OS
						</button>
						<button type="button" className="btn" onClick={onBoard}>
							Go to the board
						</button>
					</div>
				</div>
			)}
		</div>
	);
};

const STEP_TITLES = ['Pick your projects', 'Make a workspace'];

interface WelcomeStepsProps {
	ctx: SetupContext;
	// The projects crew has on this Mac: none yet means the first step.
	pool: CrewProject[];
	// The workspace just made, whose main worktree is being created.
	created: string | null;
	onAdded: () => void;
	onCreated: (workspace: string) => void;
	onBoard: () => void;
}

// The onboarding drawn from what crew has: pick projects, then make a workspace, then its progress.
export const WelcomeSteps = ({
	ctx,
	pool,
	created,
	onAdded,
	onCreated,
	onBoard,
}: WelcomeStepsProps) => {
	const step: WelcomeStep = created ? 'creating' : pool.length > 0 ? 'workspace' : 'pick';
	const current = step === 'pick' ? 0 : 1;

	return (
		<section className="page" aria-label="Set up This Mac">
			<div className="head-row">
				<div className="head-text">
					<h1>Set up {ctx.machineTitle}</h1>
					<p className="lead">
						Pick your projects, group the ones that run together into a workspace, and talk to it in
						Voice OS.
					</p>
				</div>
			</div>
			<ol className="fr-steps">
				{STEP_TITLES.map((title, index) => {
					const state = index < current ? 'done' : index === current ? 'now' : 'later';

					return (
						<li
							key={title}
							className={`fr-step ${state}`}
							aria-current={state === 'now' ? 'step' : undefined}
						>
							<div className="fr-h">
								<span className="fr-n">{index < current ? '✓' : index + 1}</span>
								<b>{title}</b>
								{index < current && (
									<span className="m">
										{pool.length} added: {pool.map((project) => project.name).join(', ')}
									</span>
								)}
							</div>
							{state === 'now' && index === 0 && <PickStep ctx={ctx} onAdded={onAdded} />}
							{state === 'now' && index === 1 && !created && (
								<WorkspaceStep projects={pool} onCreated={onCreated} />
							)}
							{state === 'now' && index === 1 && created && (
								<CreatingStep ctx={ctx} workspace={created} onBoard={onBoard} />
							)}
						</li>
					);
				})}
			</ol>
		</section>
	);
};

export const Welcome = ({ ctx, onDone }: WelcomeProps) => {
	const projects = useCrew<CrewProject[]>(LOCAL_MACHINE, { type: 'ls_projects' });
	const [created, setCreated] = useState<string | null>(null);

	return (
		<WelcomeSteps
			ctx={ctx}
			pool={projects.data ?? []}
			created={created}
			onAdded={projects.refresh}
			onCreated={setCreated}
			onBoard={() => (onDone ? onDone() : ctx.go({ page: 'board', tab: 'projects' }))}
		/>
	);
};
