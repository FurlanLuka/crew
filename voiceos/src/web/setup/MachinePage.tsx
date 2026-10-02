// A machine's connection: where it is, which crew it runs, what's on it; and the form that adds one.
// The machine list lives on This Mac, so its commands always run here.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { isValidHost } from '../../shared/machines.js';
import { describeRefusal, isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { Confirm, PageHead, ResultLine, type SetupContext } from './common.js';
import { deriveProjectState } from './derive.js';
import type { UpdateCheck } from './settings/settings.js';
import type { CrewProject, CrewWorktree } from './types.js';

export const MachinePage = ({ ctx }: { ctx: SetupContext }) => {
	const isLocal = ctx.machine === LOCAL_MACHINE;
	const remote = ctx.state.machines[ctx.machine];
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const worktrees = useCrew<CrewWorktree[]>(ctx.machine, { type: 'ls_worktrees' });
	const version = useCrew<UpdateCheck>(ctx.machine, { type: 'update_check' });
	const local = useCrewAction(LOCAL_MACHINE);
	const [name, setName] = useState<string | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);
	const crewVersion = version.data?.current ? `crew ${version.data.current}` : '';
	const lead = isLocal
		? ['crew runs here', crewVersion].filter(Boolean).join(' · ')
		: [
				`ssh ${remote?.host ?? ctx.machine}`,
				remote?.status ?? '',
				remote?.detail ?? '',
				crewVersion,
			]
				.filter(Boolean)
				.join(' · ');

	const rename = async (event: FormEvent) => {
		event.preventDefault();

		if (
			name?.trim() &&
			isOk(await local.run({ type: 'machines_rename', id: ctx.machine, name: name.trim() }))
		) {
			setName(null);
		}
	};

	return (
		<section className="page" aria-label={`Machine ${ctx.machineTitle}`}>
			<PageHead title={ctx.machineTitle} lead={lead}>
				<button
					type="button"
					className="btn"
					onClick={() => ctx.askClaude('Check this machine: connection, tools, disk and projects.')}
				>
					Check with Claude
				</button>
				{!isLocal && name === null && (
					<button type="button" className="btn" onClick={() => setName(ctx.machineTitle)}>
						Rename
					</button>
				)}
			</PageHead>
			{name !== null && (
				<form className="inline-form" onSubmit={(event) => void rename(event)}>
					<input
						type="text"
						aria-label="Machine name"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<button type="submit" className="btn sm primary">
						Rename
					</button>
					<button type="button" className="btn sm ghost" onClick={() => setName(null)}>
						Cancel
					</button>
				</form>
			)}
			{name?.trim() && (
				<CommandLine commands={[{ type: 'machines_rename', id: ctx.machine, name: name.trim() }]} />
			)}
			<div className="label">On it</div>
			<div className="box">
				{(projects.data ?? []).map((project) => {
					const state = deriveProjectState(project, worktrees.data ?? []);

					return (
						<button
							type="button"
							key={project.name}
							className="box-row as-link"
							onClick={() => ctx.go({ page: 'project', name: project.name })}
						>
							<span
								className={`dot ${state === 'failed' ? 'ask' : state === 'ready' ? 'ok' : 'ring'}`}
							/>
							<span className="sub">
								<b>{project.name}</b>
								<span className="m">
									project ·{' '}
									{state === 'failed'
										? 'check failed'
										: state === 'ready'
											? 'set up'
											: 'not set up'}
								</span>
							</span>
							<span className="m">
								{
									(worktrees.data ?? []).filter((worktree) => !worktree.ref.startsWith('check/'))
										.length
								}{' '}
								worktrees
							</span>
						</button>
					);
				})}
				{projects.reply && !isOk(projects.reply) && (
					<div className="box-row">
						<span className="dot ask" />
						<span className="sub">
							<b>Can't read it now</b>
							<span className="m">{describeRefusal(projects.reply)}</span>
						</span>
					</div>
				)}
			</div>
			<ResultLine reply={local.last} />
			{!isLocal &&
				(isRemoving ? (
					<Confirm
						title={`Remove ${ctx.machineTitle}?`}
						why={
							<p className="fail-why">
								This Mac stops driving it. Nothing on the machine is deleted: its sessions keep
								running there.
							</p>
						}
						command={{ type: 'machines_rm', id: ctx.machine, confirm: true }}
						machine={LOCAL_MACHINE}
						actionLabel="Remove machine"
						run={local.run}
						onCancel={() => setIsRemoving(false)}
						onDone={() => ctx.go({ page: 'board', tab: 'projects' })}
					/>
				) : (
					<div className="row-actions">
						<button type="button" className="btn danger" onClick={() => setIsRemoving(true)}>
							Remove machine
						</button>
					</div>
				))}
		</section>
	);
};

export const AddMachine = ({ ctx }: { ctx: SetupContext }) => {
	const [host, setHost] = useState('');
	const [name, setName] = useState('');
	const action = useCrewAction(LOCAL_MACHINE);
	const isHostOk = isValidHost(host.trim());
	const command: SetupCommand | null = isHostOk
		? { type: 'machines_add', host: host.trim(), ...(name.trim() ? { name: name.trim() } : {}) }
		: null;

	const connect = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await action.run(command))) {
			ctx.go({ page: 'board', tab: 'projects' });
		}
	};

	return (
		<section className="page narrow" aria-label="Add a machine">
			<PageHead
				title="Add a machine"
				lead="Run projects on another computer or a VM and set them up from here."
			/>
			<form onSubmit={(event) => void connect(event)}>
				<div className="field">
					<span>On that machine first</span>
					<small>
						install crew, then run <code>crew server remote</code>
					</small>
				</div>
				<label className="field">
					<span>SSH address</span>
					<input
						type="text"
						autoComplete="off"
						placeholder="dev@build-box"
						value={host}
						onChange={(event) => setHost(event.target.value)}
					/>
					<small>
						the one you use with <b>ssh</b>; your ssh config's keys are used
					</small>
				</label>
				<label className="field">
					<span>Name</span>
					<input
						type="text"
						autoComplete="off"
						placeholder="Build box"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<CommandLine commands={[command]} />
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button
						type="button"
						className="btn primary"
						disabled={!isHostOk}
						onClick={() =>
							ctx.askClaude(
								`Add ${host.trim()} as a machine${name.trim() ? ` called ${name.trim()}` : ''}.`,
							)
						}
					>
						Connect with Claude
					</button>
					<button type="submit" className="btn" disabled={!command || action.isBusy}>
						Connect without Claude
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'board', tab: 'projects' })}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	);
};
