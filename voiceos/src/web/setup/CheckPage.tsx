// crew check project: a clean checkout, the install, then every dev server has to answer. This is
// what "ready" means. The page starts the check once, then follows crew's own status.
import { useEffect, useState } from 'react';
import { isOk, readCrewLine, runCrew, useCrew } from './api.js';
import { CommandLine } from './CommandLine.js';
import { FailBlock, PageHead, type SetupContext } from './common.js';
import { describeIssue, listWorkspacesOf } from './derive.js';
import { ProgressBox, isRunning, listFailedProjects, listProgressLines } from './progress.js';
import type { CrewSetupStatus, CrewWorkspace } from './types.js';

const POLL_MS = 2000;

interface CheckPageProps {
	ctx: SetupContext;
	name: string;
}

export const CheckPage = ({ ctx, name }: CheckPageProps) => {
	const [phase, setPhase] = useState<'starting' | 'following' | 'refused'>('starting');
	const [refusal, setRefusal] = useState('');
	const [runId, setRunId] = useState(0);
	const ref = `check/${name}`;
	const status = useCrew<CrewSetupStatus>(
		ctx.machine,
		phase === 'following' ? { type: 'setup_status', ref } : null,
		{ pollMs: POLL_MS },
	);

	useEffect(() => {
		let isAlive = true;

		void (async () => {
			// A check already running (a reload of this page) is followed, not started again.
			const now = await runCrew(ctx.machine, { type: 'setup_status', ref });
			const current =
				'json' in now && now.code !== 1 ? (now.json as CrewSetupStatus | undefined) : undefined;

			if (current && isRunning(current) && current.projects.length > 0) {
				setPhase('following');

				return;
			}

			if (!isAlive) {
				return;
			}

			const started = await runCrew(ctx.machine, { type: 'check_project', project: name });

			if (!isAlive) {
				return;
			}

			if (!isOk(started)) {
				setRefusal(readCrewLine(started));
				setPhase('refused');

				return;
			}

			setPhase('following');
		})();

		return () => {
			isAlive = false;
		};
	}, [ctx.machine, name, ref, runId]);

	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	// Offered only to a project in no workspace yet; one already in one has its worktrees.
	const isInAWorkspace =
		workspaces.data === null || listWorkspacesOf(workspaces.data, name).length > 0;
	const data = status.data;
	const lines = listProgressLines(data);
	const isDone = data !== null && !isRunning(data);
	const failed = listFailedProjects(data);
	const issue = failed[0]?.issues[0] ?? data?.health?.issues[0];

	return (
		<section className="page narrow" aria-label={`Checking ${name}`}>
			<PageHead
				title={`Checking ${name}`}
				lead="A clean checkout, the install, then every dev server has to answer."
			/>
			<ProgressBox lines={lines} empty={phase === 'refused' ? null : 'Starting the check…'}>
				{phase === 'refused' && (
					<FailBlock title="crew did not start the check" why={refusal || 'crew refused.'}>
						<button
							type="button"
							className="btn"
							onClick={() => ctx.go({ page: 'project-edit', name })}
						>
							Edit setup
						</button>
					</FailBlock>
				)}
				{isDone && failed.length > 0 && (
					<FailBlock
						title={`${name} is not ready on ${ctx.machineTitle}`}
						log={issue?.detail}
						why={`${issue ? `${describeIssue(issue)}. ` : ''}Nothing else changed: its worktrees keep their code, and the project stays as it was set up.`}
					>
						<button
							type="button"
							className="btn primary"
							onClick={() =>
								ctx.askClaude(
									`Fix ${name}: its check failed${issue ? ` at ${issue.stage}: ${describeIssue(issue)}` : ''}.`,
								)
							}
						>
							Fix with Claude
						</button>
						<button
							type="button"
							className="btn"
							onClick={() => ctx.go({ page: 'project-edit', name })}
						>
							Edit setup
						</button>
						<button
							type="button"
							className="btn"
							onClick={() => {
								setPhase('starting');
								setRunId(runId + 1);
							}}
						>
							Check again
						</button>
					</FailBlock>
				)}
				<CommandLine
					commands={[{ type: 'check_project', project: name }]}
					machineTitle={ctx.machineTitle}
				/>
			</ProgressBox>
			{isDone && failed.length === 0 && (
				<div className="check-done">
					<p className="lead">
						<span className="c-good">{name} is ready.</span> Its worktrees start these servers from
						now on.
					</p>
					<div className="form-actions">
						<button
							type="button"
							className="btn primary"
							onClick={() => ctx.go({ page: 'board', tab: 'projects' })}
						>
							Back to the board
						</button>
						{!isInAWorkspace && (
							<button
								type="button"
								className="btn ghost"
								onClick={() => ctx.go({ page: 'workspace-new' })}
							>
								Put it in a workspace
							</button>
						)}
					</div>
				</div>
			)}
		</section>
	);
};
