// Import a crew export: the plan first, then a choice per item (keep, replace, clone, use a folder,
// import under another name). Nothing happens until you choose.
import { useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { readCrewLine, runCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { Confirm, PageHead, ResultLine, type SetupContext } from './common.js';
import { type PlanRow, readPlan } from './readers.js';

const DOT_BY_STATUS: Record<string, string> = {
	exists: 'ok',
	ready: 'ok',
	clone: 'ring',
	'other remote': 'run',
	blocked: 'ask',
	missing: 'ask',
	needs: 'ring',
};

const describeStatus = (row: PlanRow): string => {
	switch (row.status) {
		case 'exists':
			return 'already here';
		case 'clone':
			return `clone${row.detail ? ` into ${row.detail}` : ''}`;
		case 'other remote':
			return 'a different repo here has that name';
		case 'blocked':
			return `its folder is taken${row.detail ? `: ${row.detail}` : ''}`;
		case 'missing':
			return 'no remote in the export: config only';
		case 'needs':
			return `needs ${row.detail || 'its projects'} first`;
		case 'ready':
			return row.detail || 'ready';
		default:
			return [row.status, row.detail].filter(Boolean).join(' · ');
	}
};

interface ProjectChoiceProps {
	row: PlanRow;
	bundle: string;
	onRun: (command: SetupCommand) => void;
}

const ProjectChoice = ({ row, bundle, onRun }: ProjectChoiceProps) => {
	const [path, setPath] = useState<string | null>(null);
	const [rename, setRename] = useState<string | null>(null);
	const [setup, setSetup] = useState('');
	const [envCmd, setEnvCmd] = useState('');
	const [isMore, setIsMore] = useState(false);
	const extras = {
		...(setup.trim() ? { setup: setup.trim() } : {}),
		...(envCmd.trim() ? { env_cmd: envCmd.trim() } : {}),
	};
	const base = { type: 'import_project' as const, bundle, name: row.name, ...extras };
	const pending: SetupCommand | null = path?.trim()
		? { ...base, path: path.trim() }
		: rename?.trim()
			? { ...base, rename: rename.trim() }
			: null;

	return (
		<div className="import-choice">
			<span className="row-actions">
				{row.status === 'exists' && <span className="chip ok">keep</span>}
				{row.status === 'exists' && (
					<button
						type="button"
						className="btn sm ghost"
						onClick={() => onRun({ ...base, replace: true, confirm: true })}
					>
						Replace config
					</button>
				)}
				{row.status === 'clone' && (
					<button type="button" className="btn sm" onClick={() => onRun(base)}>
						Clone
					</button>
				)}
				{(row.status === 'clone' || row.status === 'missing' || row.status === 'blocked') &&
					path === null && (
						<button type="button" className="btn sm ghost" onClick={() => setPath('')}>
							{row.status === 'missing' ? 'Point at a folder' : 'Use my folder'}
						</button>
					)}
				{(row.status === 'other remote' || row.status === 'blocked') && rename === null && (
					<button type="button" className="btn sm" onClick={() => setRename(`${row.name}-2`)}>
						Import as {row.name}-2
					</button>
				)}
				{row.status !== 'exists' && (
					<button type="button" className="btn sm ghost" onClick={() => setIsMore(!isMore)}>
						{isMore ? 'Less' : 'Install…'}
					</button>
				)}
			</span>
			{path !== null && (
				<input
					type="text"
					aria-label={`Folder for ${row.name}`}
					placeholder="~/code/…"
					value={path}
					onChange={(event) => setPath(event.target.value)}
				/>
			)}
			{rename !== null && (
				<input
					type="text"
					aria-label={`New name for ${row.name}`}
					value={rename}
					onChange={(event) => setRename(event.target.value)}
				/>
			)}
			{isMore && (
				<span className="import-extras">
					<input
						type="text"
						aria-label={`Install for ${row.name}`}
						placeholder="install command (kept from the export when empty)"
						value={setup}
						onChange={(event) => setSetup(event.target.value)}
					/>
					<input
						type="text"
						aria-label={`Env command for ${row.name}`}
						placeholder="env command"
						value={envCmd}
						onChange={(event) => setEnvCmd(event.target.value)}
					/>
				</span>
			)}
			{pending && (
				<button type="button" className="btn sm primary" onClick={() => onRun(pending)}>
					Import
				</button>
			)}
		</div>
	);
};

export const ImportPage = ({ ctx }: { ctx: SetupContext }) => {
	const [bundle, setBundle] = useState<string | null>(null);
	const [fileName, setFileName] = useState('');
	const [rows, setRows] = useState<PlanRow[]>([]);
	const [planLine, setPlanLine] = useState('');
	const [replacing, setReplacing] = useState<SetupCommand | null>(null);
	const action = useCrewAction(ctx.machine);

	const plan = async (text: string) => {
		const reply = await runCrew(ctx.machine, { type: 'import_plan', bundle: text });

		if ('json' in reply && reply.json !== undefined) {
			setRows(readPlan(reply.json));
			setPlanLine('');
		} else {
			setRows([]);
			setPlanLine(readCrewLine(reply) || 'crew could not read that file.');
		}
	};

	const load = async (file: File) => {
		const text = await file.text();
		setFileName(file.name);
		setBundle(text);
		await plan(text);
	};

	const runChoice = async (command: SetupCommand) => {
		// A replace overwrites a project here: it asks first, like any removal.
		if ('replace' in command && command.replace) {
			setReplacing(command);

			return;
		}

		await action.run(command);

		if (bundle) {
			await plan(bundle);
		}
	};

	const projects = rows.filter((row) => row.kind === 'project');
	const workspaces = rows.filter((row) => row.kind === 'workspace');

	return (
		<section className="page" aria-label="Import">
			<PageHead
				title="Import"
				lead={
					bundle
						? `${fileName}. Nothing happens until you choose for each.`
						: 'A crew export from another machine: projects by their git remote, and which workspaces they are in.'
				}
			/>
			<label className="field">
				<span>Export file</span>
				<input
					type="file"
					accept="application/json,.json"
					aria-label="Export file"
					onChange={(event) => event.target.files?.[0] && void load(event.target.files[0])}
				/>
			</label>
			{planLine && <p className="result-line bad">! {planLine}</p>}
			{projects.length > 0 && (
				<>
					<div className="label">Projects</div>
					<div className="box">
						{projects.map((row) => (
							<div key={`p ${row.name}`} className="box-row imp" data-project={row.name}>
								<span className={`dot ${DOT_BY_STATUS[row.status] ?? 'ring'}`} />
								<span className="sub">
									<b>{row.name}</b>
									<span className="m">{describeStatus(row)}</span>
								</span>
								{bundle && (
									<ProjectChoice
										row={row}
										bundle={bundle}
										onRun={(command) => void runChoice(command)}
									/>
								)}
							</div>
						))}
					</div>
				</>
			)}
			{workspaces.length > 0 && (
				<>
					<div className="label">Workspaces</div>
					<div className="box">
						{workspaces.map((row) => (
							<div key={`w ${row.name}`} className="box-row imp" data-workspace={row.name}>
								<span className={`dot ${DOT_BY_STATUS[row.status] ?? 'ring'}`} />
								<span className="sub">
									<b>{row.name}</b>
									<span className="m">{describeStatus(row)}</span>
								</span>
								{row.status === 'ready' && bundle ? (
									<button
										type="button"
										className="btn sm"
										onClick={() =>
											void runChoice({ type: 'import_workspace', bundle, name: row.name })
										}
									>
										Create
									</button>
								) : (
									<span className="chip">{row.status === 'exists' ? 'here' : 'waiting'}</span>
								)}
							</div>
						))}
					</div>
				</>
			)}
			{replacing && (
				<Confirm
					title="Replace this project's config with the export's?"
					why={
						<p className="fail-why">
							crew records the export's install, dev servers and environment over what is here. Its
							checkout and worktrees stay.
						</p>
					}
					command={replacing}
					machine={ctx.machine}
					actionLabel="Replace"
					run={action.run}
					onCancel={() => setReplacing(null)}
					onDone={() => {
						setReplacing(null);

						if (bundle) {
							void plan(bundle);
						}
					}}
				/>
			)}
			<ResultLine reply={action.last} />
			{bundle && <CommandLine commands={[{ type: 'import_plan', bundle }]} />}
			<div className="form-actions">
				{bundle && (
					<button
						type="button"
						className="btn primary"
						disabled={action.isBusy}
						onClick={async () => {
							await action.run({ type: 'import_all', bundle });
							await plan(bundle);
						}}
					>
						Import everything ready
					</button>
				)}
				<button type="button" className="btn ghost" onClick={() => ctx.go({ page: 'settings' })}>
					{bundle ? 'Done' : 'Cancel'}
				</button>
			</div>
		</section>
	);
};
