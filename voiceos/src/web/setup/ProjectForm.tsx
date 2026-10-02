// Setting a project up by hand: install, env command, dev servers (renamed in place), and its
// Environment with a live preview of what a worktree would get. Save runs the commands shown, then
// crew's check decides "ready".
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, ResultLine, type SetupContext } from './common.js';
import { describeBindingSource, readPreview, readProposals } from './environment.js';
import { type ServerRow, listSources, planProjectSave, toRow } from './project-form.js';
import type { CrewProject } from './types.js';

interface ProjectFormProps {
	ctx: SetupContext;
	name: string;
}

const PREVIEW_DEBOUNCE_MS = 300;

const useDebounced = <T,>(value: T, ms: number): T => {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);

		return () => clearTimeout(timer);
	}, [value, ms]);

	return settled;
};

export const ProjectForm = ({ ctx, name }: ProjectFormProps) => {
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const project = projects.data?.find((candidate) => candidate.name === name);

	if (!projects.data) {
		return (
			<section className="page">
				<PageHead title={`Set up ${name}`} lead="Reading crew…" />
			</section>
		);
	}

	if (!project) {
		return (
			<section className="page">
				<PageHead
					title={`Set up ${name}`}
					lead={`No project called ${name} on ${ctx.machineTitle}.`}
				/>
			</section>
		);
	}

	return (
		<ProjectFormLoaded
			ctx={ctx}
			project={project}
			projects={projects.data}
			onSaved={projects.refresh}
		/>
	);
};

interface LoadedProps {
	ctx: SetupContext;
	project: CrewProject;
	projects: CrewProject[];
	onSaved: () => void;
}

const ProjectFormLoaded = ({ ctx, project, projects, onSaved }: LoadedProps) => {
	const [setup, setSetup] = useState(project.setup ?? '');
	const [envCmd, setEnvCmd] = useState(project.env_cmd ?? '');
	const [rows, setRows] = useState<ServerRow[]>(() => (project.dev_servers ?? []).map(toRow));
	const [nextKey, setNextKey] = useState(1000);
	const [variable, setVariable] = useState('');
	const sources = useMemo(() => listSources(projects, project.name), [projects, project.name]);
	const [source, setSource] = useState(sources[0]?.value ?? 'fixed');
	const [fixed, setFixed] = useState('');
	const [scope, setScope] = useState('');
	const action = useCrewAction(ctx.machine);
	const scan = useCrew<unknown>(ctx.machine, { type: 'add_binding_scan', project: project.name });
	const proposals = readProposals(scan.data);
	const value = source === 'fixed' ? fixed : source;
	const binding = variable.trim() && value ? { var: variable.trim(), value, server: scope } : null;
	const settled = useDebounced(binding, PREVIEW_DEBOUNCE_MS);
	const preview = useCrew<unknown>(
		ctx.machine,
		settled
			? {
					type: 'add_binding_dry_run',
					project: project.name,
					var: settled.var,
					value: settled.value,
					...(settled.server ? { server: settled.server } : {}),
				}
			: null,
	);
	const previewDoc = readPreview(preview.data);
	const previewRows = previewDoc.rows;
	const commands = planProjectSave({ project, setup, envCmd, rows, binding });
	const check: SetupCommand = { type: 'check_project', project: project.name };

	const updateRow = (key: number, patch: Partial<ServerRow>) =>
		setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

	const run = async (list: SetupCommand[]): Promise<boolean> => {
		for (const command of list) {
			const reply = await action.run(command);

			if (!isOk(reply)) {
				return false;
			}
		}

		return true;
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();

		if (await run(commands)) {
			onSaved();
			ctx.go({ page: 'check', name: project.name });
		}
	};

	const remove = async (command: SetupCommand) => {
		if (await run([command])) {
			onSaved();
		}
	};

	return (
		<section className="page" aria-label={`Set up ${project.name}`}>
			<PageHead
				title={`Set up ${project.name}`}
				lead={
					<>
						Change anything, then save and check. Stuck?{' '}
						<button
							type="button"
							className="linkish"
							onClick={() => ctx.askClaude(`Help me finish setting up ${project.name}.`)}
						>
							Ask Claude
						</button>{' '}
						and Claude picks up from here.
					</>
				}
			/>
			<form className="cfg" onSubmit={(event) => void save(event)}>
				<div className="cfg-sec">
					<div className="cfg-h">
						<span className="label">Install</span>
						<small className="m">runs in every new worktree</small>
					</div>
					<label className="field">
						<span>Command</span>
						<input
							type="text"
							autoComplete="off"
							placeholder="detected from the lockfile when empty"
							value={setup}
							onChange={(event) => setSetup(event.target.value)}
						/>
						<small>empty: crew picks the package manager from the lockfile</small>
					</label>
					<label className="field">
						<span>Env command</span>
						<input
							type="text"
							autoComplete="off"
							placeholder="optional, e.g. op inject -i .env.tpl -o .env"
							value={envCmd}
							onChange={(event) => setEnvCmd(event.target.value)}
						/>
						<small>
							runs after install, to write secrets into <b>.env</b>
						</small>
					</label>
				</div>

				<div className="cfg-sec">
					<div className="cfg-h">
						<span className="label">Dev servers</span>
						<small className="m">each worktree gets its own port</small>
					</div>
					<div className="srv-table">
						<div className="srv-row head">
							<span>Name</span>
							<span>Command</span>
							<span>Folder</span>
							<span>Port</span>
							<span />
						</div>
						{rows.map((row) => (
							<div key={row.key} className="srv-row" data-server={row.original ?? 'new'}>
								<input
									type="text"
									aria-label="name"
									value={row.name}
									onChange={(event) => updateRow(row.key, { name: event.target.value })}
								/>
								<input
									type="text"
									aria-label="command"
									value={row.command}
									onChange={(event) => updateRow(row.key, { command: event.target.value })}
								/>
								<input
									type="text"
									aria-label="folder"
									placeholder="."
									value={row.dir}
									onChange={(event) => updateRow(row.key, { dir: event.target.value })}
								/>
								<input
									type="text"
									aria-label="port"
									placeholder="none"
									inputMode="numeric"
									value={row.port}
									onChange={(event) => updateRow(row.key, { port: event.target.value })}
								/>
								<button
									type="button"
									className="x"
									aria-label="Remove server"
									onClick={() => setRows(rows.filter((other) => other.key !== row.key))}
								>
									×
								</button>
							</div>
						))}
					</div>
					<button
						type="button"
						className="btn sm add-server"
						onClick={() => {
							setRows([
								...rows,
								{ key: nextKey, original: null, name: '', command: '', dir: '', port: '' },
							]);
							setNextKey(nextKey + 1);
						}}
					>
						+ Add server
					</button>
					<small className="m">a server with no port is a process that doesn't listen</small>
				</div>

				<div className="cfg-sec">
					<div className="cfg-h">
						<span className="label">Environment</span>
						<small className="m">variables crew sets in every worktree of this project</small>
					</div>
					{project.bindings?.length ? (
						<div className="box flat">
							{project.bindings.map((existing) => (
								<div key={`${existing.var} ${existing.server ?? ''}`} className="box-row">
									<span className="dot ok" />
									<span className="sub">
										<b>
											<code>{existing.var}</code>
										</b>
										<span className="m">
											← {describeBindingSource(existing.value)}
											{existing.server ? ` · ${existing.server} only` : ''}
										</span>
									</span>
									<button
										type="button"
										className="x"
										aria-label={`Remove ${existing.var}`}
										onClick={() =>
											void remove({
												type: 'rm_binding',
												project: project.name,
												var: existing.var,
												...(existing.server ? { server: existing.server } : {}),
											})
										}
									>
										×
									</button>
								</div>
							))}
						</div>
					) : null}
					<div className="bind-row">
						<label className="field">
							<span>Variable</span>
							<input
								type="text"
								autoComplete="off"
								placeholder="API_URL"
								value={variable}
								onChange={(event) => setVariable(event.target.value)}
							/>
						</label>
						<label className="field">
							<span>Value comes from</span>
							<select value={source} onChange={(event) => setSource(event.target.value)}>
								{sources.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span>For</span>
							<select value={scope} onChange={(event) => setScope(event.target.value)}>
								<option value="">every server</option>
								{(project.dev_servers ?? []).map((server) => (
									<option key={server.name} value={server.name}>
										{server.name} only
									</option>
								))}
							</select>
						</label>
					</div>
					{source === 'fixed' && (
						<label className="field">
							<span>A fixed value</span>
							<input
								type="text"
								autoComplete="off"
								value={fixed}
								onChange={(event) => setFixed(event.target.value)}
							/>
							<small>
								the same in every worktree; pin a different one per worktree on its page
							</small>
						</label>
					)}
					{binding && (
						<div className="preview">
							{preview.isLoading && previewRows.length === 0 ? (
								<span className="c-dim">working out what each worktree gets…</span>
							) : previewDoc.error ? (
								<span className="c-crit">{previewDoc.error}</span>
							) : preview.reply && !isOk(preview.reply) && !preview.data ? (
								<span className="c-crit">{preview.reply.stderr.trim()}</span>
							) : previewRows.length === 0 ? (
								<span className="c-dim">no worktree has {project.name} yet</span>
							) : (
								previewRows.map((row) => (
									<div key={row.worktree}>
										in {row.worktree}: {binding.var}=
										{row.value !== null ? (
											<b>{row.value}</b>
										) : (
											<span className="c-crit">{row.error ?? 'does not resolve'}</span>
										)}
										{scope ? ` · ${scope} only` : ''}
									</div>
								))
							)}
						</div>
					)}
					{proposals.length > 0 && (
						<div className="proposals">
							<span className="label">Found in .env</span>
							{proposals.map((proposal) => (
								<div key={proposal.var} className="proposal">
									<code>{proposal.var}</code> <span className="m">{proposal.note}</span>
									{proposal.value && (
										<button
											type="button"
											className="btn sm"
											onClick={() => {
												setVariable(proposal.var);
												setSource(
													sources.some((option) => option.value === proposal.value)
														? (proposal.value ?? 'fixed')
														: 'fixed',
												);
												setFixed(proposal.value ?? '');
											}}
										>
											Use
										</button>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				<CommandLine commands={[...commands, check]} machineTitle={ctx.machineTitle} />
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button type="submit" className="btn primary" disabled={action.isBusy}>
						{action.isBusy ? 'Saving…' : 'Save and check'}
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'project', name: project.name })}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	);
};
