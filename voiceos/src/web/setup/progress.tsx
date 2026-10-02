// A setup runner's steps as Set up draws them: one line per step of each project, from crew's own
// result files (crew setup status), never from what anyone said.
import type { ReactNode } from 'react';
import type { CrewProjectStatus, CrewSetupStatus, CrewStep } from './types.js';

export type LineState = 'ok' | 'ask' | 'wait' | 'skip';

export interface ProgressLine {
	key: string;
	state: LineState;
	what: string;
	// The project, and crew's first line for the step when it has one.
	detail: string;
	// How long the step took, "working…" while it runs.
	took: string;
}

const readStepState = (step: CrewStep): LineState => {
	switch (step.status) {
		case 'ok':
		case 'passed':
		case 'done':
			return 'ok';
		case 'failed':
		case 'error':
		case 'aborted':
			return 'ask';
		case 'skipped':
		case 'skip':
			return 'skip';
		default:
			return 'wait';
	}
};

const formatTook = (ms: number | undefined): string =>
	ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;

export const listProgressLines = (status: CrewSetupStatus | null): ProgressLine[] =>
	(status?.projects ?? []).flatMap((project: CrewProjectStatus) => {
		const steps = project.steps.map((step, index) => {
			const state = readStepState(step);
			const firstLine =
				step.detail
					?.split('\n')
					.find((line) => line.trim())
					?.trim() ?? '';

			return {
				key: `${project.project} ${step.name} ${index}`,
				state,
				what: step.name,
				detail: [project.project, firstLine].filter(Boolean).join(' · '),
				took: formatTook(step.took_ms) || (state === 'wait' && !firstLine ? 'working…' : ''),
			};
		});

		return project.state === 'starting' && steps.length === 0
			? [
					{
						key: `${project.project} start`,
						state: 'wait' as const,
						what: 'starting',
						detail: project.project,
						took: '',
					},
				]
			: steps;
	});

export const isRunning = (status: CrewSetupStatus | null): boolean =>
	status === null ||
	status.running ||
	status.projects.some((project) => project.state === 'starting' || project.state === 'running');

export const listFailedProjects = (status: CrewSetupStatus | null): CrewProjectStatus[] =>
	(status?.projects ?? []).filter(
		(project) => project.state === 'failed' || project.state === 'interrupted',
	);

const DOTS: Record<LineState, string> = { ok: 'ok', ask: 'ask', wait: 'run', skip: 'ring' };

interface ProgressBoxProps {
	lines: ProgressLine[];
	// Said in the box while crew has no step to show yet.
	empty: string | null;
	// What failed, then the command line, inside the same box under the steps.
	children?: ReactNode;
}

// One box: a one-line row per step (its dot, the step, the project, the time), then what failed and
// the command the page follows.
export const ProgressBox = ({ lines, empty, children }: ProgressBoxProps) => (
	<div className="box progress-box">
		{lines.map((line) => (
			<div
				key={line.key}
				className="box-row one-line pg"
				data-state={line.state}
				title={[line.what, line.detail, line.took].filter(Boolean).join(' · ')}
			>
				<span className={`dot ${DOTS[line.state]}`} />
				<span className="sub">
					<b>{line.what}</b>
					<span className={`m ${line.state === 'ask' ? 'c-crit' : ''}`}>{line.detail}</span>
				</span>
				<span className="m took">{line.took}</span>
			</div>
		))}
		{lines.length === 0 && empty && (
			<div className="box-row one-line">
				<span className="dot ring" />
				<span className="sub">
					<span className="m">{empty}</span>
				</span>
			</div>
		)}
		{children}
	</div>
);
