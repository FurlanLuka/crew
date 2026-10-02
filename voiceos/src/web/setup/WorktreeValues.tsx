// A worktree's values: the pinned ones (crew's overrides, fixed for this worktree only) and the
// environment each server gets, as crew env reads it.
import { type FormEvent, useEffect, useState } from 'react';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { ResultLine, type SetupContext } from './common.js';
import type { CrewEnvRow, CrewMember } from './types.js';
import { readOverrides, toPinCommand } from './worktree.js';
import { countOf } from '../count.js';

interface PinnedValuesProps {
	ctx: SetupContext;
	worktreeRef: string;
	members: CrewMember[];
	onChanged: () => void;
}

export const PinnedValues = ({ ctx, worktreeRef, members, onChanged }: PinnedValuesProps) => {
	const overrides = useCrew<unknown>(ctx.machine, { type: 'ls_overrides', ref: worktreeRef });
	const action = useCrewAction(ctx.machine);
	const [pin, setPin] = useState('');
	const [pinProject, setPinProject] = useState('');
	const pins = readOverrides(overrides.data);
	const pinCommand = toPinCommand({ ref: worktreeRef, pin, project: pinProject });
	// Every form shows its command: before anything is typed, its shape.
	const shownPin =
		pinCommand ?? toPinCommand({ ref: worktreeRef, pin: 'VAR=value', project: pinProject });

	const run = async (command: Parameters<typeof action.run>[0]) => {
		const reply = await action.run(command);

		overrides.refresh();
		onChanged();

		return reply;
	};

	const submitPin = async (event: FormEvent) => {
		event.preventDefault();

		if (pinCommand && isOk(await run(pinCommand))) {
			setPin('');
		}
	};

	return (
		<>
			<div className="label">
				Pinned values{' '}
				<span className="m label-note">
					fixed for this worktree only; they win over the project's environment
				</span>
			</div>
			{pins.length > 0 && (
				<div className="box">
					{pins.map((entry) => (
						<div key={entry.key} className="box-row">
							<span className="dot ring" />
							<span className="sub">
								<b>
									<code>{entry.key.replace(/^[^.]*\./, '')}</code>
								</b>
								<span className="m">
									{entry.key.includes('.') ? `${entry.key.split('.')[0]} only` : 'every project'}
								</span>
							</span>
							<button
								type="button"
								className="x"
								aria-label={`Remove ${entry.key}`}
								onClick={() => void run({ type: 'rm_override', ref: worktreeRef, var: entry.key })}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}
			<form className="ov-add" onSubmit={(event) => void submitPin(event)}>
				<input
					type="text"
					aria-label="Variable and value"
					placeholder="STRIPE_KEY=sk_test_…"
					autoComplete="off"
					value={pin}
					onChange={(event) => setPin(event.target.value)}
				/>
				<select
					aria-label="Which project"
					value={pinProject}
					onChange={(event) => setPinProject(event.target.value)}
				>
					<option value="">every project</option>
					{members.map((member) => (
						<option key={member.name} value={member.name}>
							{member.name}
						</option>
					))}
				</select>
				<button type="submit" className="btn" disabled={!pinCommand || action.isBusy}>
					Pin value
				</button>
			</form>
			<CommandLine commands={[shownPin]} machineTitle={ctx.machineTitle} />
			<ResultLine reply={action.last} />
		</>
	);
};

interface WorktreeEnvironmentProps {
	ctx: SetupContext;
	worktreeRef: string;
	members: CrewMember[];
	// Changes when a pinned value did: read again.
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
				Environment each server gets{' '}
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
						<span className={`src ${entry.source === 'override' ? 'pin' : ''}`}>
							{entry.source === 'override' ? 'pinned here' : entry.detail || entry.source}
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
