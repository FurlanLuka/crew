// The first run's projects step: the git checkouts crew found on this Mac (each cloned fresh from
// its remote), or one added by URL or by a folder.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { countOf } from '../count.js';
import { nameFromPath, nameFromUrl } from '../setup/AddProject.js';
import { isOk, useCrew, useCrewAction } from '../setup/api.js';
import { ResultLine } from '../setup/common.js';
import { TickRow, toggle } from '../setup/flow.js';
import { readCheckouts } from '../setup/readers.js';
import type { CrewProject } from '../setup/types.js';
import { toAddCommand } from './first-run.js';

const SEARCHED = '~/code, ~/projects, ~/dev, ~/src, ~/Developer, ~/work or ~/repos';

type AdderKind = 'url' | 'path';

// "Add by URL" / "Add a folder": one field in the projects card, crew's own refusal under it.
const Adder = ({ kind, onAdded }: { kind: AdderKind; onAdded: () => void }) => {
	const action = useCrewAction(LOCAL_MACHINE);
	const [value, setValue] = useState('');
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const source = value.trim();

	useEffect(() => fieldRef.current?.focus(), []);
	const name = kind === 'url' ? nameFromUrl(source) : nameFromPath(source);
	const command: SetupCommand | null =
		source && name
			? kind === 'url'
				? { type: 'add_project', name, url: source }
				: { type: 'add_project', name, path: source }
			: null;

	const submit = async (event: FormEvent) => {
		event.preventDefault();

		if (command && isOk(await action.run(command))) {
			setValue('');
			onAdded();
		}
	};

	return (
		<form className="fr-adder" onSubmit={(event) => void submit(event)}>
			<label className="field">
				<span>{kind === 'url' ? 'Git URL' : 'Folder'}</span>
				<input
					type="text"
					autoComplete="off"
					spellCheck={false}
					ref={fieldRef}
					placeholder={kind === 'url' ? 'https://github.com/acme/payments.git' : '~/code/payments'}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="row-actions">
				<button type="submit" className="btn" disabled={!command || action.isBusy}>
					{action.isBusy ? 'Adding…' : `Add ${name || 'project'}`}
				</button>
			</div>
		</form>
	);
};

interface ProjectsStepProps {
	pool: CrewProject[];
	onPoolChanged: () => void;
	onNext: () => void;
}

export const ProjectsStep = ({ pool, onPoolChanged, onNext }: ProjectsStepProps) => {
	const scan = useCrew<unknown>(LOCAL_MACHINE, { type: 'scan_checkouts' });
	const action = useCrewAction(LOCAL_MACHINE);
	const [unticked, setUnticked] = useState<string[]>([]);
	const [adder, setAdder] = useState<AdderKind | null>(null);
	const known = new Set(pool.map((project) => project.name));
	const found = readCheckouts(scan.data).filter((row) => !row.known && !known.has(row.name));
	const ticked = found.filter((row) => !unticked.includes(row.path));
	const commands: SetupCommand[] = ticked.map(toAddCommand);
	const label =
		ticked.length > 0
			? `Add ${countOf(ticked.length, 'project')}`
			: pool.length > 0
				? 'Continue'
				: 'Pick a project';

	const next = async () => {
		try {
			for (const command of commands) {
				if (!isOk(await action.run(command))) {
					return;
				}
			}

			onNext();
		} finally {
			// Read again either way: a refusal halfway leaves the ones before it added.
			onPoolChanged();
		}
	};

	return (
		<div className="fr-col">
			<h1>Pick your projects</h1>
			<p className="fr-lead">
				{scan.isLoading
					? 'Looking for git checkouts in your usual code folders…'
					: found.length > 0
						? "crew found these git checkouts on this Mac. Each one you add is cloned fresh from its remote into crew's own folder; yours is never touched. One with no remote is used where it is."
						: `No new git checkouts in ${SEARCHED}. Add one by its git URL.`}
			</p>
			{(pool.length > 0 || found.length > 0) && (
				<div className="fr-group">
					{pool.map((project) => (
						<TickRow
							key={project.name}
							name={project.name}
							sub={project.path ?? ''}
							side="added"
							isOn
						/>
					))}
					{found.map((row) => (
						<TickRow
							key={row.path}
							name={row.name}
							sub={row.remote ? `clones ${row.remote}` : `uses ${row.path}`}
							side={row.remote ? 'clone' : 'folder'}
							isOn={!unticked.includes(row.path)}
							onToggle={() => setUnticked(toggle(unticked, row.path))}
						/>
					))}
				</div>
			)}
			<div className="row-actions">
				<button
					type="button"
					className="btn"
					aria-pressed={adder === 'url'}
					onClick={() => setAdder(adder === 'url' ? null : 'url')}
				>
					Add by URL
				</button>
				<button
					type="button"
					className="btn"
					aria-pressed={adder === 'path'}
					onClick={() => setAdder(adder === 'path' ? null : 'path')}
				>
					Use a folder on this Mac
				</button>
			</div>
			{adder && (
				<Adder
					key={adder}
					kind={adder}
					onAdded={() => {
						setAdder(null);
						onPoolChanged();
					}}
				/>
			)}
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="fr-actions">
				<span className="m">You can add more later in Set up.</span>
				<button
					type="button"
					className="btn primary"
					disabled={(ticked.length === 0 && pool.length === 0) || action.isBusy}
					onClick={() => void next()}
				>
					{action.isBusy ? 'Adding…' : label}
				</button>
			</div>
		</div>
	);
};
