// A worktree's Environment, in the project page's words: the values set for this worktree (crew's
// overrides, which win over the project's own), the form that sets one, and what each server gets,
// as crew env reads it.
import { type FormEvent, useEffect, useState } from 'react';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { ResultLine, type SetupContext } from './common.js';
import type { CrewEnvRow, CrewMember, CrewProject } from './types.js';
import { describeOverride, readOverrides, toOverrideCommand } from './worktree.js';
import { countOf } from '../count.js';

interface WorktreeOverridesProps {
	ctx: SetupContext;
	worktreeRef: string;
	members: CrewMember[];
	projects: CrewProject[];
	onChanged: () => void;
}

export const WorktreeOverrides = ({
	ctx,
	worktreeRef,
	members,
	projects,
	onChanged,
}: WorktreeOverridesProps) => {
	const overrides = useCrew<unknown>(ctx.machine, { type: 'ls_overrides', ref: worktreeRef });
	const action = useCrewAction(ctx.machine);
	const [text, setText] = useState('');
	const [project, setProject] = useState('');
	const lines = readOverrides(overrides.data).map((entry) =>
		describeOverride(entry.key, members, projects),
	);
	const command = toOverrideCommand({ ref: worktreeRef, text, project });
	// Every form shows its command: before anything is typed, its shape.
	const shown = command ?? toOverrideCommand({ ref: worktreeRef, text: 'VAR=value', project });

	const run = async (next: Parameters<typeof action.run>[0]) => {
		const reply = await action.run(next);

		overrides.refresh();
		onChanged();

		return reply;
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await run(command))) {
			setText('');
		}
	};

	return (
		<>
			<div className="label">
				Environment{' '}
				<span className="m label-note">
					a value set for this worktree wins over the project's environment
				</span>
			</div>
			{lines.length > 0 && (
				<div className="box">
					{lines.map((line) => {
						const said = ['set for this worktree', line.scope, line.instead]
							.filter(Boolean)
							.join(' · ');

						return (
							<div
								key={line.key}
								className="box-row one-line"
								data-override={line.key}
								title={`${line.name} · ${said}`}
							>
								<span className="dot ring" />
								<span className="sub">
									<code>{line.name}</code>
									<span className="m">{said}</span>
								</span>
								<button
									type="button"
									className="x"
									aria-label={`Remove ${line.key}`}
									onClick={() => void run({ type: 'rm_override', ref: worktreeRef, var: line.key })}
								>
									×
								</button>
							</div>
						);
					})}
				</div>
			)}
			<p className="m ov-say">Set a value for this worktree</p>
			<form
				className="ov-add"
				aria-label="Set a value for this worktree"
				onSubmit={(event) => void submit(event)}
			>
				<input
					type="text"
					aria-label="Variable and value"
					placeholder="STRIPE_KEY=sk_test_…"
					autoComplete="off"
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
				<select
					aria-label="Which project"
					value={project}
					onChange={(event) => setProject(event.target.value)}
				>
					<option value="">every project</option>
					{members.map((member) => (
						<option key={member.name} value={member.name}>
							{member.name}
						</option>
					))}
				</select>
				<button type="submit" className="btn" disabled={!command || action.isBusy}>
					Set value
				</button>
			</form>
			<CommandLine commands={[shown]} machineTitle={ctx.machineTitle} />
			<ResultLine reply={action.last} />
		</>
	);
};

interface WorktreeEnvironmentProps {
	ctx: SetupContext;
	worktreeRef: string;
	members: CrewMember[];
	// Changes when a value set for this worktree did: read again.
	refreshKey: number;
}

export const WorktreeEnvironment = ({
	ctx,
	worktreeRef,
	members,
	refreshKey,
}: WorktreeEnvironmentProps) => {
	const [envProject, setEnvProject] = useState<string | null>(null);
	const envFor = envProject ?? members[0]?.name ?? null;
	const env = useCrew<CrewEnvRow[]>(
		ctx.machine,
		envFor ? { type: 'env', ref: worktreeRef, project: envFor } : null,
	);
	const { refresh } = env;

	useEffect(() => {
		if (refreshKey > 0) {
			refresh();
		}
	}, [refreshKey, refresh]);

	return (
		<details className="env-all">
			<summary>
				What each server gets{' '}
				<span className="m">{env.data ? countOf(env.data.length, 'variable') : ''}</span>
			</summary>
			{members.length > 1 && (
				<div className="seg env-seg" role="tablist">
					{members.map((member) => (
						<button
							key={member.name}
							type="button"
							role="tab"
							aria-selected={member.name === envFor}
							onClick={() => setEnvProject(member.name)}
						>
							{member.name}
						</button>
					))}
				</div>
			)}
			<div className="env-rows">
				{(env.data ?? []).map((entry) => (
					<div key={`${entry.var} ${entry.server}`}>
						<code>
							{entry.var}
							{entry.server ? ` (${entry.server})` : ''}
						</code>
						<span className={`src ${entry.source === 'override' ? 'here' : ''}`}>
							{entry.source === 'override' ? 'set for this worktree' : entry.detail || entry.source}
						</span>
					</div>
				))}
			</div>
			{envFor && (
				<small className="m">
					Same as crew env {worktreeRef} {envFor}.
				</small>
			)}
		</details>
	);
};
