// Set up: one machine at a time. A floating toolbar (the crew mark, the machine picker, the
// breadcrumbs), then the page. Esc goes up one breadcrumb.
import { useCallback, useEffect, useRef, useState } from 'react';
import { LOCAL_MACHINE, refOn, SETUP_REF } from '../../shared/machine-ref.js';
import { isMachineReachable, readMachineTitle } from '../../shared/machines.js';
import type { ClientMessage, State } from '../../shared/protocol.js';
import type { Navigate, Route, SetupPage } from '../router.js';
import { useCrew } from './api.js';
import { Board } from './Board.js';
import { CheckPage } from './CheckPage.js';
import type { SetupContext } from './common.js';
import { crumbsFor, pageAbove } from './crumbs.js';
import { countNeedsYou } from './derive.js';
import { ExportPage } from './ExportPage.js';
import { ImportPage } from './ImportPage.js';
import { LogsPage } from './LogsPage.js';
import { AddMachine, MachinePage } from './MachinePage.js';
import { NewWorktree, Progress } from './NewWorktree.js';
import { ProjectForm } from './ProjectForm.js';
import { AddProject } from './AddProject.js';
import { ProjectPage } from './ProjectPage.js';
import { SettingsPage } from './SettingsPage.js';
import { SetupChat } from './SetupChat.js';
import type { CrewProject, CrewWorktree } from './types.js';
import { WorkspaceForm } from './WorkspaceForm.js';
import { WorkspacePage } from './WorkspacePage.js';
import { WorktreeNameForm } from './WorktreeForms.js';
import { WorktreePage } from './WorktreePage.js';
import { countOf } from '../count.js';

interface SetupShellProps {
	state: State;
	route: Extract<Route, { half: 'setup' }>;
	navigate: Navigate;
	send: (message: ClientMessage) => void;
	openVoice: (sessionRef: string) => void;
	// A "Fix with Claude" from outside Set up (the first run): asked here once, then let go.
	pendingAsk: string | null;
	onAskTaken: () => void;
}

// The machine's one setup session: "setup" here, "<id>:setup" on another machine.
export const setupRefFor = (machine: string): string => refOn(machine, SETUP_REF);

export const isSetupBusy = (state: State, ref: string): boolean => {
	const session = state.sessions[ref];

	return (
		session !== undefined &&
		(session.status === 'running' ||
			session.status === 'starting' ||
			session.status === 'blocked' ||
			state.asks.some((ask) => ask.ref === ref))
	);
};

interface MachineItemProps {
	state: State;
	id: string;
	isCurrent: boolean;
	onPick: () => void;
}

// One machine in the picker: its problems read when the menu opens, so another machine's broken
// worktree is seen from here.
const MachineItem = ({ state, id, isCurrent, onPick }: MachineItemProps) => {
	const isReachable = id === LOCAL_MACHINE || isMachineReachable(state, id);
	const projects = useCrew<CrewProject[]>(id, isReachable ? { type: 'ls_projects' } : null);
	const worktrees = useCrew<CrewWorktree[]>(id, isReachable ? { type: 'ls_worktrees' } : null);
	const needs = worktrees.data ? countNeedsYou(worktrees.data) : 0;
	const machine = state.machines[id];
	const sub = !isReachable
		? (machine?.detail ?? 'not reachable')
		: [
				id === LOCAL_MACHINE ? 'here' : 'SSH',
				needs > 0
					? `${countOf(needs, 'needs', 'need')} you`
					: projects.data
						? countOf(projects.data.length, 'project')
						: '',
			]
				.filter(Boolean)
				.join(' · ');

	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={isCurrent}
			disabled={!isReachable}
			onClick={onPick}
		>
			<span className={`dot ${!isReachable || needs > 0 ? 'ask' : 'ok'}`} />
			<span>
				{readMachineTitle(state, id)}
				<small>{sub}</small>
			</span>
		</button>
	);
};

interface BusyAsk {
	prompt: string;
}

export const SetupShell = ({
	state,
	route,
	navigate,
	send,
	openVoice,
	pendingAsk,
	onAskTaken,
}: SetupShellProps) => {
	const { machine, page } = route;
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [busyAsk, setBusyAsk] = useState<BusyAsk | null>(null);
	const [chatDraft, setChatDraft] = useState('');
	const menuRef = useRef<HTMLDivElement | null>(null);
	const machineTitle = readMachineTitle(state, machine);
	const setupRef = setupRefFor(machine);

	const go = useCallback(
		(next: SetupPage, options?: { replace?: boolean }) =>
			navigate({ half: 'setup', machine, page: next }, options),
		[navigate, machine],
	);

	const askClaude = useCallback(
		(prompt: string) => {
			if (isSetupBusy(state, setupRef)) {
				setBusyAsk({ prompt });

				return;
			}

			setChatDraft(prompt);
			go({ page: 'chat' });
		},
		[state, setupRef, go],
	);

	const ctx: SetupContext = { state, machine, machineTitle, go, askClaude, send, openVoice };

	useEffect(() => {
		if (pendingAsk) {
			askClaude(pendingAsk);
			onAskTaken();
		}
	}, [pendingAsk]);

	const goFirstRun = useCallback(() => navigate({ half: 'home' }, { replace: true }), [navigate]);

	useEffect(() => {
		const handleKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') {
				return;
			}

			if (isMenuOpen || busyAsk) {
				setIsMenuOpen(false);
				setBusyAsk(null);

				return;
			}

			const target = event.target;

			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target instanceof HTMLSelectElement
			) {
				return;
			}

			const above = pageAbove(page);

			if (above) {
				go(above);
			}
		};

		window.addEventListener('keydown', handleKey);

		return () => window.removeEventListener('keydown', handleKey);
	}, [page, go, isMenuOpen, busyAsk]);

	useEffect(() => {
		if (!isMenuOpen) {
			return;
		}

		const close = (event: PointerEvent) => {
			if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
				setIsMenuOpen(false);
			}
		};

		document.addEventListener('pointerdown', close);

		return () => document.removeEventListener('pointerdown', close);
	}, [isMenuOpen]);

	// The page's own scroll starts at the top on every page.
	useEffect(() => {
		window.scrollTo(0, 0);
	}, [page]);

	const pickMachine = (next: string) => {
		setIsMenuOpen(false);
		navigate({ half: 'setup', machine: next, page: { page: 'board', tab: 'projects' } });
	};

	const crumbs = crumbsFor(page);
	const machineIds = [LOCAL_MACHINE, ...Object.keys(state.machines)];
	const isChat = page.page === 'chat';

	return (
		<div className={`setup ${isChat ? 'on-chat' : ''}`}>
			<header className="top">
				<button
					type="button"
					className="brand"
					title="Home"
					onClick={() => navigate({ half: 'home' })}
				>
					crew
				</button>
				<div className="machine-pick" ref={menuRef}>
					<button
						type="button"
						className="machine-btn"
						aria-haspopup="menu"
						aria-expanded={isMenuOpen}
						aria-label={`Machine: ${machineTitle}`}
						onClick={() => setIsMenuOpen((isOpen) => !isOpen)}
					>
						<span
							className={`dot ${machine === LOCAL_MACHINE || isMachineReachable(state, machine) ? 'ok' : 'ask'}`}
						/>
						<span>{machineTitle}</span>
						<span className="chev" aria-hidden="true">
							⌄
						</span>
					</button>
					{isMenuOpen && (
						<div className="menu machine-menu" role="menu">
							{machineIds.map((id) => (
								<MachineItem
									key={id}
									state={state}
									id={id}
									isCurrent={id === machine}
									onPick={() => pickMachine(id)}
								/>
							))}
							<div className="menu-sep" />
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setIsMenuOpen(false);
									go({ page: 'machine' });
								}}
							>
								Connection
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setIsMenuOpen(false);
									go({ page: 'settings' });
								}}
							>
								Settings
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setIsMenuOpen(false);
									go({ page: 'machine-new' });
								}}
							>
								Add a machine…
							</button>
						</div>
					)}
				</div>
				<nav className="crumbs" aria-label="Where you are">
					{crumbs.length > 0 && (
						<>
							<button type="button" onClick={() => go({ page: 'board', tab: 'projects' })}>
								{machineTitle}
							</button>
							{crumbs.map((crumb, index) => {
								const isLast = index === crumbs.length - 1;
								const isMid = index > 0 && !isLast;

								return (
									<span key={`${crumb.label}-${index}`} className="crumb">
										<span className="sep">›</span>
										{isLast || !crumb.page ? (
											<span
												className={isLast ? 'here' : isMid ? 'mid' : ''}
												aria-current={isLast ? 'page' : undefined}
											>
												{crumb.label}
											</span>
										) : (
											<button
												type="button"
												className={isMid ? 'mid' : ''}
												onClick={() => crumb.page && go(crumb.page)}
											>
												{crumb.label}
											</button>
										)}
									</span>
								);
							})}
						</>
					)}
				</nav>
			</header>
			<main className="stage" key={`${machine} ${page.page}`}>
				<SetupPageView
					ctx={ctx}
					page={page}
					chatDraft={chatDraft}
					onChatDraftUsed={() => setChatDraft('')}
					onFirstRun={goFirstRun}
				/>
			</main>
			{busyAsk && (
				<div className="busy" role="dialog" aria-label="Setup is busy">
					<div className="busy-card">
						<b>Setup is busy</b>
						<p>
							Setup on {machineTitle} is working on something, or waiting on you. Your request can
							wait in its queue, or open the chat to see what it's doing.
						</p>
						<div className="busy-prompt">{busyAsk.prompt}</div>
						<div className="row-actions">
							<button
								type="button"
								className="btn primary"
								onClick={() => {
									send({
										type: 'action',
										action: { type: 'send', ref: setupRef, text: busyAsk.prompt },
									});
									setBusyAsk(null);
								}}
							>
								Queue it
							</button>
							<button
								type="button"
								className="btn"
								onClick={() => {
									setChatDraft(busyAsk.prompt);
									setBusyAsk(null);
									go({ page: 'chat' });
								}}
							>
								Open setup
							</button>
							<button type="button" className="btn ghost" onClick={() => setBusyAsk(null)}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

interface SetupPageViewProps {
	ctx: SetupContext;
	page: SetupPage;
	chatDraft: string;
	onChatDraftUsed: () => void;
	onFirstRun: () => void;
}

const SetupPageView = ({
	ctx,
	page,
	chatDraft,
	onChatDraftUsed,
	onFirstRun,
}: SetupPageViewProps) => {
	switch (page.page) {
		case 'board':
			return <Board ctx={ctx} tab={page.tab} onFirstRun={onFirstRun} />;
		case 'chat':
			return <SetupChat ctx={ctx} draft={chatDraft} onDraftUsed={onChatDraftUsed} />;
		case 'project':
			return <ProjectPage ctx={ctx} name={page.name} />;
		case 'project-new':
			return <AddProject ctx={ctx} />;
		case 'project-edit':
			return <ProjectForm ctx={ctx} name={page.name} />;
		case 'check':
			return <CheckPage ctx={ctx} name={page.name} />;
		case 'workspace':
			return <WorkspacePage ctx={ctx} name={page.name} />;
		case 'workspace-new':
			return <WorkspaceForm ctx={ctx} />;
		case 'workspace-edit':
			return <WorkspaceForm ctx={ctx} name={page.name} />;
		case 'worktree':
			return <WorktreePage ctx={ctx} worktreeRef={page.ref} />;
		case 'worktree-new':
			return <NewWorktree ctx={ctx} workspace={page.workspace} />;
		case 'progress':
			return <Progress ctx={ctx} worktreeRef={page.ref} />;
		case 'logs':
			return <LogsPage ctx={ctx} worktreeRef={page.ref} />;
		case 'rename':
			return <WorktreeNameForm ctx={ctx} worktreeRef={page.ref} kind="rename" />;
		case 'duplicate':
			return <WorktreeNameForm ctx={ctx} worktreeRef={page.ref} kind="duplicate" />;
		case 'machine':
			return <MachinePage ctx={ctx} />;
		case 'machine-new':
			return <AddMachine ctx={ctx} />;
		case 'settings':
			return <SettingsPage ctx={ctx} />;
		case 'import':
			return <ImportPage ctx={ctx} />;
		case 'export':
			return <ExportPage ctx={ctx} />;
	}
};
