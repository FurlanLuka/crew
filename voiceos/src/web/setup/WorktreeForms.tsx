// A worktree's one small form: a new name, to rename it or to duplicate it under.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import type { SetupPage } from '../router.js';
import { isOk, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, ResultLine, type SetupContext } from './common.js';

type NameFormKind = 'rename' | 'duplicate';

interface NameFormCopy {
	verb: string;
	lead: string;
	field: string;
	after?: string;
	command: (ref: string, name: string) => SetupCommand;
	// Where a success lands: the renamed worktree, or the new one's setup progress.
	next: (ref: string) => SetupPage;
}

const COPY: Record<NameFormKind, NameFormCopy> = {
	rename: {
		verb: 'Rename',
		lead: "Moves its checkouts and renames crew's branches. Refused while its servers run or setup is busy with it.",
		field: 'New name',
		command: (ref, name) => ({ type: 'rename_worktree', ref, name }),
		next: (ref) => ({ page: 'worktree', ref }),
	},
	duplicate: {
		verb: 'Duplicate',
		lead: "Fresh checkouts of the same projects, on new ports, with this worktree's pinned values copied across.",
		field: 'Name',
		after: 'each project is checked out, installed and its servers tried',
		command: (ref, name) => ({ type: 'duplicate_worktree', ref, name }),
		next: (ref) => ({ page: 'progress', ref }),
	},
};

interface WorktreeNameFormProps {
	ctx: SetupContext;
	worktreeRef: string;
	kind: NameFormKind;
}

export const WorktreeNameForm = ({ ctx, worktreeRef, kind }: WorktreeNameFormProps) => {
	const copy = COPY[kind];
	const [workspace = ''] = worktreeRef.split('/');
	const [name, setName] = useState('');
	const action = useCrewAction(ctx.machine);
	const command = name.trim() ? copy.command(worktreeRef, name.trim()) : null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await action.run(command))) {
			ctx.go(copy.next(`${workspace}/${name.trim()}`));
		}
	};

	return (
		<section className="page narrow" aria-label={`${copy.verb} ${worktreeRef}`}>
			<PageHead title={`${copy.verb} ${worktreeRef}`} lead={copy.lead} />
			<form onSubmit={(event) => void submit(event)}>
				<label className="field">
					<span>{copy.field}</span>
					<input
						type="text"
						autoComplete="off"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<small>
						becomes{' '}
						<b>
							{workspace}/{name.trim() || '<name>'}
						</b>
					</small>
				</label>
				<CommandLine commands={[command]} then={copy.after} machineTitle={ctx.machineTitle} />
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button type="submit" className="btn primary" disabled={!command || action.isBusy}>
						{copy.verb}
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'worktree', ref: worktreeRef })}
					>
						Cancel
					</button>
				</div>
			</form>
		</section>
	);
};
