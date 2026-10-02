// The form that records a new project: cloned from a URL, or an existing checkout adopted, and
// optionally put in a workspace.
import { type FormEvent, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, ResultLine, type SetupContext } from './common.js';
import type { CrewWorkspace } from './types.js';

// The name crew gives a project from its URL when none is typed.
export const nameFromUrl = (url: string): string =>
	url
		.trim()
		.replace(/\/+$/, '')
		.split(/[/:]/)
		.at(-1)
		?.replace(/\.git$/, '') ?? '';

export const nameFromPath = (path: string): string =>
	path.trim().replace(/\/+$/, '').split('/').at(-1) ?? '';

export const AddProject = ({ ctx }: { ctx: SetupContext }) => {
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const action = useCrewAction(ctx.machine);
	const [source, setSource] = useState<'url' | 'path'>('url');
	const [url, setUrl] = useState('');
	const [path, setPath] = useState('');
	const [typedName, setTypedName] = useState<string | null>(null);
	const [workspace, setWorkspace] = useState('new');
	const derived = source === 'url' ? nameFromUrl(url) : nameFromPath(path);
	const name = (typedName ?? derived).trim();
	const addProject: SetupCommand | null =
		name && (source === 'url' ? url.trim() : path.trim())
			? source === 'url'
				? { type: 'add_project', name, url: url.trim() }
				: { type: 'add_project', name, path: path.trim() }
			: null;
	const addWorkspace: SetupCommand | null =
		!name || workspace === 'none'
			? null
			: { type: 'add_workspace', name: workspace === 'new' ? name : workspace, projects: [name] };

	const submit = async (event: FormEvent, withClaude = false) => {
		event.preventDefault();

		if (!addProject) {
			return;
		}

		const added = await action.run(addProject);

		if (!isOk(added)) {
			return;
		}

		if (addWorkspace) {
			const joined = await action.run(addWorkspace);

			if (!isOk(joined)) {
				return;
			}
		}

		if (withClaude) {
			ctx.askClaude(
				`Set up ${name}: work out its install and dev servers, record them, and run the check.`,
			);
		} else {
			ctx.go({ page: 'project-edit', name });
		}
	};

	return (
		<section className="page narrow" aria-label="Add a project">
			<PageHead
				title="Add a project"
				lead="Its sessions can work on the code at once. Then set it up: fill in the install and dev servers yourself (prefilled with what crew finds), or let Claude work them out and ask you only what it can't."
			/>
			<form onSubmit={(event) => void submit(event)}>
				<div className="seg">
					<button type="button" aria-pressed={source === 'url'} onClick={() => setSource('url')}>
						Git URL
					</button>
					<button type="button" aria-pressed={source === 'path'} onClick={() => setSource('path')}>
						A folder
					</button>
				</div>
				{source === 'url' ? (
					<label className="field">
						<span>Git URL</span>
						<input
							type="text"
							autoComplete="off"
							placeholder="https://github.com/acme/payments.git"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
						/>
						<small>
							cloned into <b>~/.crew/projects/{name || '<name>'}</b>
						</small>
					</label>
				) : (
					<label className="field">
						<span>Folder</span>
						<input
							type="text"
							autoComplete="off"
							placeholder="~/code/payments"
							value={path}
							onChange={(event) => setPath(event.target.value)}
						/>
						<small>used where it is; nothing is moved</small>
					</label>
				)}
				<label className="field">
					<span>Name</span>
					<input
						type="text"
						autoComplete="off"
						value={typedName ?? derived}
						onChange={(event) => setTypedName(event.target.value)}
					/>
					<small>
						how you'll say it: <b>{name || 'payments'}, run the tests</b>
					</small>
				</label>
				<p className="m">On {ctx.machineTitle}. Switch machines in the toolbar.</p>
				<label className="field">
					<span>Workspace</span>
					<select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
						<option value="new">a new one, also called {name || '<name>'}</option>
						{(workspaces.data ?? []).map((row) => (
							<option key={row.name} value={row.name}>
								add to {row.name}
							</option>
						))}
						<option value="none">none for now</option>
					</select>
					<small>sessions run in a workspace's worktrees</small>
				</label>
				<CommandLine
					commands={[addProject, addWorkspace]}
					then="set up its install and dev servers"
				/>
				<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
				<div className="form-actions">
					<button type="submit" className="btn primary" disabled={!addProject || action.isBusy}>
						{action.isBusy ? 'Adding…' : 'Add and set up'}
					</button>
					<button
						type="button"
						className="btn"
						disabled={!addProject || action.isBusy}
						onClick={(event) => void submit(event, true)}
					>
						Add, and let Claude set it up
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
