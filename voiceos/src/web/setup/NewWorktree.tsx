// A new worktree: its name, the bases it branches from (behind origin or not, pull first), then
// Progress follows crew's runners until every project is checked out, installed and tried.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { refOn } from '../../shared/machine-ref.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { FailBlock, PageHead, ResultLine, type SetupContext } from './common.js';
import { describeIssue } from './derive.js';
import { ProgressBox, isRunning, listFailedProjects, listProgressLines } from './progress.js';
import { readBases } from './readers.js';
import type { CrewSetupStatus } from './types.js';

const POLL_MS = 2000;

interface NewWorktreeProps {
	ctx: SetupContext;
	workspace: string;
}

export const NewWorktree = ({ ctx, workspace }: NewWorktreeProps) => {
	const [name, setName] = useState('');
	const [isPull, setIsPull] = useState(true);
	const bases = useCrew<unknown>(ctx.machine, { type: 'ls_bases', workspace });
	const action = useCrewAction(ctx.machine);
	const rows = readBases(bases.data);
	const ref = `${workspace}/${name.trim()}`;
	const command: SetupCommand | null = name.trim()
		? { type: 'add_worktree', ref, ...(isPull ? { pull: true } : {}) }
		: null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await action.run(command))) {
			ctx.go({ page: 'progress', ref });
		}
	};

	return (
		<section className="page narrow" aria-label={`New worktree in ${workspace}`}>
			<PageHead
				title={`New worktree in ${workspace}`}
				lead="A fresh copy of every project, on its own ports. It's done when every dev server answers."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<label className="field">
					<span>Name</span>
					<input
						type="text"
						autoComplete="off"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<small>
						branch{' '}
						<b>
							crew/{workspace}/{name.trim() || '<name>'}/*
						</b>
					</small>
				</label>
				<p className="m">On {ctx.machineTitle}.</p>
				<div className="field">
					<span>Start from</span>
					<div className="picks bases">
						{bases.isLoading && rows.length === 0 && (
							<div className="pick static">
								<span />
								<span className="m">fetching each base from origin…</span>
							</div>
						)}
						{rows.map((row) => (
							<div key={row.project} className="pick static" data-project={row.project}>
								<span />
								<b>{row.project}</b>
								<span className={`m ${row.error ? 'c-crit' : row.behind ? 'c-amber' : ''}`}>
									{row.base} ·{' '}
									{row.error
										? row.error
										: row.behind
											? `${row.behind} behind`
											: row.behind === 0
												? 'up to date'
												: 'not compared'}
								</span>
								<span />
							</div>
						))}
					</div>
					<label className="check-line">
						<input
							type="checkbox"
							checked={isPull}
							onChange={(event) => setIsPull(event.target.checked)}
						/>{' '}
						pull first
					</label>
				</div>
				<CommandLine
					commands={[command]}
					then="each project is checked out, installed and its servers tried"
					machineTitle={ctx.machineTitle}
				/>
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button type="submit" className="btn primary" disabled={!command || action.isBusy}>
						{action.isBusy ? 'Creating…' : 'Create worktree'}
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'workspace', name: workspace })}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	);
};

interface ProgressProps {
	ctx: SetupContext;
	worktreeRef: string;
}

export const Progress = ({ ctx, worktreeRef }: ProgressProps) => {
	const status = useCrew<CrewSetupStatus>(
		ctx.machine,
		{ type: 'setup_status', ref: worktreeRef },
		{ pollMs: POLL_MS },
	);
	const action = useCrewAction(ctx.machine);
	const data = status.data;
	const lines = listProgressLines(data);
	const isDone = data !== null && !isRunning(data);
	const failed = listFailedProjects(data);
	const [workspace = ''] = worktreeRef.split('/');
	const sessionRef = refOn(ctx.machine, worktreeRef);

	return (
		<section className="page narrow" aria-label={`Creating ${worktreeRef}`}>
			<PageHead
				title={isDone ? worktreeRef : `Creating ${worktreeRef}`}
				lead={`On ${ctx.machineTitle}. You can leave this page; it carries on.`}
			/>
			<ProgressBox lines={lines} empty="Waiting for crew's runners…">
				{failed.map((project) => {
					const issue = project.issues[0];

					return (
						<FailBlock
							key={project.project}
							title={`${project.project}: ${issue ? describeIssue(issue, { isNamed: false }) : project.state}`}
							log={issue?.detail}
							why={
								issue?.stage === 'install'
									? `Its install failed, so ${project.project}'s session can read and change the code but not run it. Fix it now, or carry on and fix it from the board.`
									: 'The other projects keep what they have; this one stopped here.'
							}
						>
							<button
								type="button"
								className="btn primary"
								onClick={() =>
									ctx.askClaude(
										`In ${worktreeRef}: ${issue ? describeIssue(issue) : `${project.project} failed`}. Fix it.`,
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
									await action.run({
										type: 'setup_rerun',
										ref: worktreeRef,
										projects: [project.project],
									});
									status.refresh();
								}}
							>
								Retry
							</button>
							<button
								type="button"
								className="btn ghost"
								onClick={() => ctx.go({ page: 'logs', ref: worktreeRef })}
							>
								Show the log
							</button>
						</FailBlock>
					);
				})}
				<CommandLine
					commands={[{ type: 'setup_status', ref: worktreeRef }]}
					machineTitle={ctx.machineTitle}
				/>
			</ProgressBox>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			{isDone && (
				<div className="form-actions">
					<button type="button" className="btn primary" onClick={() => ctx.openVoice(sessionRef)}>
						Open in Voice OS
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => ctx.go({ page: 'worktree', ref: worktreeRef })}
					>
						{failed.length ? 'Carry on' : 'Go to the worktree'}
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'workspace', name: workspace })}
					>
						Back to {workspace}
					</button>
				</div>
			)}
		</section>
	);
};
