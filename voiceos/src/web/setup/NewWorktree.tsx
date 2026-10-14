// A new worktree: its name and the bases it branches from (behind origin or not, pull first). Its
// page follows crew's runners after, until every project is checked out, installed and tried.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { PageHead, ResultLine, type SetupContext } from './common.js';
import { readBases } from './readers.js';

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
			ctx.go({ page: 'worktree', ref });
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
