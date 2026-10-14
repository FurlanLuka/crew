// A worktree's servers, and everything done to them, in one card: start, stop, restart and verify
// from its head; the list (its servers, or its projects while they install); a line opens its log
// beside the list. Verify and installs are followed here, not on a page of their own.
import { useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { countOf } from '../count.js';
import { listRunnerRows } from '../home/first-run.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { ResultLine, type SetupContext } from './common.js';
import { describeIssue } from './derive.js';
import { DOT_BY_STATE } from './flow.js';
import { LogPane } from './LogPane.js';
import {
	CARD_ACTIONS,
	type CardAction,
	type CardMode,
	type LogTarget,
	isProjectList,
	logCommandFor,
	pickStartTarget,
	readCardMode,
	withSmokeSteps,
} from './servers.js';
import type {
	CrewMember,
	CrewProject,
	CrewRoute,
	CrewSetupStatus,
	CrewSmoke,
	CrewWorktree,
} from './types.js';
import { type ServerLine, listServerLines } from './worktree.js';

const POLL_MS = 4000;
const RUNNER_POLL_MS = 2000;
const LOG_LINES = 200;

const SERVER_DOT: Record<ServerLine['state'], string> = {
	up: 'ok',
	died: 'ask',
	quiet: 'run',
	stopped: 'ring',
};

const MODE_DOT: Record<CardMode, string> = {
	stopped: 'ring',
	running: 'ok',
	died: 'ask',
	installing: 'run',
	verifying: 'run',
	'setup-failed': 'ask',
	'verify-failed': 'ask',
};

const ACTION_LABELS: Record<CardAction, string> = {
	start: 'Start',
	stop: 'Stop',
	restart: 'Restart',
	verify: 'Verify',
	'install-again': 'Install again',
};

interface HeadlineParams {
	mode: CardMode;
	lines: ServerLine[];
	row: CrewWorktree;
}

const describeHeadline = ({ mode, lines, row }: HeadlineParams): string => {
	const issue = row.issues?.[0];
	const up = lines.filter((line) => line.state === 'up').length;

	switch (mode) {
		case 'stopped':
			return 'Stopped';
		case 'running':
			return lines.length ? `Running · ${up} of ${lines.length} listening` : 'Running';
		case 'died': {
			const died = lines.filter((line) => line.state === 'died').map((line) => line.name);

			return died.length
				? `${died.join(', ')} died`
				: issue
					? describeIssue(issue)
					: 'A server died';
		}
		case 'installing':
			return 'Installing';
		case 'verifying':
			return `Verifying · ${up} of ${countOf(lines.length, 'server')} answered`;
		case 'setup-failed':
		case 'verify-failed':
			return issue ? describeIssue(issue) : 'Something failed';
	}
};

const actionCommand = (action: CardAction, ref: string, row: CrewWorktree): SetupCommand => {
	switch (action) {
		case 'start':
			return { type: 'dev_start', ref };
		case 'stop':
			return { type: 'dev_stop', ref };
		case 'restart':
			return { type: 'dev_restart', ref };
		case 'verify':
			return { type: 'verify', ref };
		case 'install-again':
			return {
				type: 'setup_rerun',
				ref,
				projects: [...new Set((row.issues ?? []).map((issue) => issue.project))],
			};
	}
};

interface ServersCardProps {
	ctx: SetupContext;
	worktreeRef: string;
	row: CrewWorktree;
	members: CrewMember[];
	projects: CrewProject[];
	// After an action: the page reads the worktree again.
	onChanged: () => void;
}

export const ServersCard = ({
	ctx,
	worktreeRef: ref,
	row,
	members,
	projects,
	onChanged,
}: ServersCardProps) => {
	const status = useCrew<CrewSetupStatus>(
		ctx.machine,
		row.installing ? { type: 'setup_status', ref } : null,
		{ pollMs: RUNNER_POLL_MS },
	);
	const checks = useCrew<CrewSmoke[]>(
		ctx.machine,
		row.dev_running ? { type: 'dev_check', ref } : null,
		{ pollMs: POLL_MS },
	);
	const routes = useCrew<CrewRoute[]>(
		ctx.machine,
		row.dev_running ? { type: 'dev_status', ref } : null,
	);
	const action = useCrewAction(ctx.machine);
	const [picked, setPicked] = useState<LogTarget | null>(null);
	const [isClosed, setIsClosed] = useState(false);
	const [isConfirmingVerify, setIsConfirmingVerify] = useState(false);
	const runnerStatus = row.installing ? status.data : null;
	const plain = listServerLines({
		members,
		projects,
		checks: checks.data ?? [],
		routes: routes.data ?? [],
		worktreeRef: ref,
	});
	const lines = withSmokeSteps(plain, runnerStatus);
	const mode = readCardMode({ row, status: runnerStatus, lines });
	const issue = row.issues?.[0];
	const target = isClosed ? null : (picked ?? pickStartTarget(mode, lines, issue));
	const runners = listRunnerRows(runnerStatus);

	const run = async (command: SetupCommand) => {
		const reply = await action.run(command);

		onChanged();
		checks.refresh();
		routes.refresh();
		status.refresh();

		return reply;
	};

	// Verify tries each server alone, so it stops the running ones first: they stay stopped after.
	const verify = async () => {
		setIsConfirmingVerify(false);

		if (row.dev_running && !isOk(await run({ type: 'dev_stop', ref }))) {
			return;
		}

		await run({ type: 'verify', ref });
	};

	const press = (pressed: CardAction) => {
		if (pressed === 'verify' && row.dev_running) {
			setIsConfirmingVerify(true);

			return;
		}

		if (pressed === 'verify') {
			void verify();

			return;
		}

		void run(actionCommand(pressed, ref, row));
	};

	const open = (next: LogTarget) => {
		setPicked(next);
		setIsClosed(false);
	};

	const isOpen = (candidate: LogTarget): boolean =>
		target?.project === candidate.project && target?.server === candidate.server;

	const fixLine =
		mode === 'died' || mode === 'setup-failed' || mode === 'verify-failed'
			? `In ${ref}: ${describeHeadline({ mode, lines, row })}. Fix it.`
			: null;

	return (
		<section className="srv-card" aria-label="Dev servers" data-mode={mode}>
			<div className="srv-card-head">
				<span className={`dot ${MODE_DOT[mode]}`} />
				<b className="srv-card-title">{describeHeadline({ mode, lines, row })}</b>
				<span className="row-actions">
					{fixLine && (
						<button type="button" className="btn sm" onClick={() => ctx.askClaude(fixLine)}>
							Fix with Claude
						</button>
					)}
					{CARD_ACTIONS[mode].map((each) => (
						<button
							key={each}
							type="button"
							className={`btn sm ${each === 'start' || each === 'install-again' ? 'primary' : ''}`}
							disabled={action.isBusy}
							onClick={() => press(each)}
						>
							{ACTION_LABELS[each]}
						</button>
					))}
				</span>
			</div>
			{isConfirmingVerify && (
				<div className="srv-confirm" role="dialog" aria-label="Verify">
					<span>
						Verify stops the servers first, then tries each one alone. They stay stopped after.
					</span>
					<span className="row-actions">
						<button type="button" className="btn sm primary" onClick={() => void verify()}>
							Stop and verify
						</button>
						<button
							type="button"
							className="btn sm ghost"
							onClick={() => setIsConfirmingVerify(false)}
						>
							Cancel
						</button>
					</span>
				</div>
			)}
			<div className={`srv-split ${target ? 'open' : ''}`}>
				<div className="srv-list">
					{isProjectList(mode)
						? (runners.length
								? runners
								: members.map((member) => ({
										project: member.name,
										state: issue?.project === member.name ? ('failed' as const) : ('ok' as const),
										side: issue?.project === member.name ? 'failed' : 'ready',
									}))
							).map((runner) => (
								<button
									key={runner.project}
									type="button"
									className={`srv-line ${isOpen({ project: runner.project, server: null }) ? 'sel' : ''}`}
									data-project={runner.project}
									data-state={runner.state}
									onClick={() => open({ project: runner.project, server: null })}
								>
									<span className={`dot ${DOT_BY_STATE[runner.state]}`} />
									<span className="srv-text">
										<b>{runner.project}</b>
										<span className="m">{runner.side}</span>
									</span>
								</button>
							))
						: lines.map((line) => (
								<button
									key={`${line.project} ${line.name}`}
									type="button"
									className={`srv-line ${isOpen({ project: line.project, server: line.name }) ? 'sel' : ''}`}
									data-server={line.name}
									data-state={line.state}
									title={`${line.name} · ${line.project} · ${line.command}`}
									onClick={() => open({ project: line.project, server: line.name })}
								>
									<span className={`dot ${SERVER_DOT[line.state]}`} />
									<span className="srv-text">
										<b>{line.name}</b>
										<span className="m">
											{line.project} · {line.command}
										</span>
									</span>
									{line.url ? (
										<a
											className="srv-url"
											href={line.url}
											target="_blank"
											rel="noopener noreferrer"
											onClick={(event) => event.stopPropagation()}
										>
											{line.url.replace(/^https?:\/\//, '')} ↗
										</a>
									) : (
										<span className="chip">
											{line.state === 'died'
												? 'died'
												: line.state === 'quiet'
													? 'not listening yet'
													: line.state === 'up'
														? 'answered'
														: line.port
															? `:${line.port}`
															: 'stopped'}
										</span>
									)}
								</button>
							))}
					{!isProjectList(mode) && lines.length === 0 && (
						<div className="srv-line static">
							<span className="dot idle" />
							<span className="srv-text">
								<span className="m">No dev servers</span>
							</span>
						</div>
					)}
				</div>
				{target && (
					<LogPane
						key={`${mode} ${target.project} ${target.server ?? ''}`}
						machine={ctx.machine}
						command={logCommandFor({ mode, ref, target, lines: LOG_LINES })}
						title={target.server ? target.server : `${target.project} install`}
						onClose={() => setIsClosed(true)}
					/>
				)}
			</div>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
		</section>
	);
};
