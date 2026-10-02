// The form that makes a workspace or adds projects to one: each project ticked with its mode, the
// wires between them, a direct-mode refusal shown on submit.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { Confirm, PageHead, ResultLine, type SetupContext } from './common.js';
import { isNotSetUp } from './derive.js';
import type { CrewProject, CrewWorkspace } from './types.js';
import { type Mode, listWires, planWorkspace } from './workspace.js';

interface WorkspaceFormProps {
	ctx: SetupContext;
	// Editing this workspace's projects; none for a new workspace.
	name?: string;
}

export const WorkspaceForm = ({ ctx, name }: WorkspaceFormProps) => {
	const isEdit = name !== undefined;
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const action = useCrewAction(ctx.machine);
	const members =
		workspaces.data?.find((row) => row.name === name)?.projects?.map((member) => member.name) ?? [];
	const [typedName, setTypedName] = useState('');
	const [picks, setPicks] = useState<Record<string, Mode> | null>(null);
	const [removalQueue, setRemovalQueue] = useState<string[]>([]);
	const current: Record<string, Mode> =
		picks ??
		Object.fromEntries(
			(workspaces.data?.find((row) => row.name === name)?.projects ?? []).map((member) => [
				member.name,
				member.mode === 'direct' ? 'direct' : 'worktree',
			]),
		);
	const workspaceName = isEdit ? (name ?? '') : typedName;
	const commands = planWorkspace(workspaceName, current, members);
	const removals = members.filter((member) => !(member in current));
	const ticked = Object.keys(current);
	const wires = listWires(projects.data ?? [], ticked);

	const toggle = (project: string, isOn: boolean) => {
		const next = { ...current };

		if (isOn) {
			next[project] = 'worktree';
		} else {
			delete next[project];
		}

		setPicks(next);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		for (const command of commands) {
			const reply = await action.run(command);

			if (!isOk(reply)) {
				return;
			}
		}

		if (removals.length > 0) {
			setRemovalQueue(removals);

			return;
		}

		ctx.go(
			isEdit
				? { page: 'workspace', name: workspaceName }
				: { page: 'progress', ref: `${workspaceName.trim()}/main` },
		);
	};

	const removing = removalQueue[0];

	return (
		<section className="page narrow" aria-label={isEdit ? `Edit ${name}` : 'New workspace'}>
			<PageHead
				title={isEdit ? `Edit ${name}` : 'New workspace'}
				lead={
					isEdit
						? 'Add or take out projects. Every worktree gets the change.'
						: 'Pick the projects you work on together. Its first worktree, main, is created with every server running.'
				}
			/>
			<form onSubmit={(event) => void submit(event)}>
				{!isEdit && (
					<label className="field">
						<span>Name</span>
						<input
							type="text"
							autoComplete="off"
							value={typedName}
							onChange={(event) => setTypedName(event.target.value)}
						/>
					</label>
				)}
				{!isEdit && <p className="m">On {ctx.machineTitle}.</p>}
				<div className="field">
					<span>Projects</span>
					<div className="picks">
						{(projects.data ?? []).map((project) => {
							const isOn = project.name in current;

							return (
								<label key={project.name} className="pick">
									<input
										type="checkbox"
										checked={isOn}
										onChange={(event) => toggle(project.name, event.target.checked)}
									/>
									<b>{project.name}</b>
									<span className={`chip ${isNotSetUp(project) ? '' : 'ok'}`}>
										{isNotSetUp(project) ? 'not set up' : 'set up'}
									</span>
									<select
										aria-label={`${project.name} mode`}
										value={current[project.name] ?? 'worktree'}
										disabled={!isOn || members.includes(project.name)}
										onChange={(event) =>
											setPicks({
												...current,
												[project.name]: event.target.value === 'direct' ? 'direct' : 'worktree',
											})
										}
									>
										<option value="worktree">worktree</option>
										<option value="direct">direct</option>
									</select>
								</label>
							);
						})}
					</div>
					<small>
						worktree: its own copy, the default · direct: your checkout as it is (a project can be
						direct in one workspace only; crew says so when it can't)
					</small>
				</div>
				{wires.length > 0 && (
					<div className="field">
						<span>How they connect</span>
						{wires.map((wire) => (
							<div key={`${wire.from} ${wire.variable} ${wire.to}`} className="wires">
								<span className={wire.isTicked ? 'c-good' : 'c-amber'}>
									{wire.isTicked ? '✓' : '!'}
								</span>{' '}
								{wire.isTicked ? (
									<>
										{wire.from} reaches {wire.to} through <code>{wire.variable}</code>
									</>
								) : (
									<>
										{wire.from}'s <code>{wire.variable}</code> points at {wire.to}, which isn't
										ticked
									</>
								)}
							</div>
						))}
					</div>
				)}
				<CommandLine
					commands={[
						...commands,
						...removals.map(
							(project): SetupCommand => ({
								type: 'rm_workspace_project',
								workspace: workspaceName,
								project,
								confirm: true,
							}),
						),
					]}
					then={isEdit ? undefined : 'main is checked out, installed and its servers started'}
					machineTitle={ctx.machineTitle}
				/>
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button
						type="submit"
						className="btn primary"
						disabled={
							action.isBusy ||
							!workspaceName.trim() ||
							(commands.length === 0 && removals.length === 0)
						}
					>
						{action.isBusy ? 'Working…' : isEdit ? 'Save' : 'Create workspace'}
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() =>
							ctx.go(
								isEdit
									? { page: 'workspace', name: name ?? '' }
									: { page: 'board', tab: 'workspaces' },
							)
						}
					>
						Cancel
					</button>
				</div>
			</form>
			{removing && (
				<Confirm
					key={removing}
					title={`Take ${removing} out of ${workspaceName}?`}
					why={
						<p className="fail-why">
							Every worktree of {workspaceName} loses its {removing} copy; checkouts go to the
							trash.
						</p>
					}
					command={{
						type: 'rm_workspace_project',
						workspace: workspaceName,
						project: removing,
						confirm: true,
					}}
					dryRun={{
						type: 'rm_workspace_project_dry_run',
						workspace: workspaceName,
						project: removing,
					}}
					machine={ctx.machine}
					actionLabel="Take it out"
					run={action.run}
					onCancel={() => setRemovalQueue([])}
					onDone={() => {
						const rest = removalQueue.slice(1);
						setRemovalQueue(rest);

						if (rest.length === 0) {
							ctx.go({ page: 'workspace', name: workspaceName });
						}
					}}
				/>
			)}
		</section>
	);
};
