// A setup runner's steps as Set up draws them: one line per step of each project, from crew's own
// result files (crew setup status), never from what anyone said.
import type { CrewProjectStatus, CrewSetupStatus, CrewStep } from './types.js';

export type LineState = 'ok' | 'ask' | 'wait' | 'skip';

export interface ProgressLine {
	key: string;
	state: LineState;
	what: string;
	detail: string;
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
				detail: [
					project.project,
					firstLine || (state === 'wait' ? 'working…' : ''),
					formatTook(step.took_ms),
				]
					.filter(Boolean)
					.join(' · '),
			};
		});

		return project.state === 'starting' && steps.length === 0
			? [
					{
						key: `${project.project} start`,
						state: 'wait' as const,
						what: 'starting',
						detail: project.project,
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

export const ProgressLines = ({ lines }: { lines: ProgressLine[] }) => (
	<div className="progress">
		{lines.map((line) => (
			<div
				key={line.key}
				className={`pg ${line.state === 'ok' ? '' : line.state}`}
				data-state={line.state}
			>
				<b>{line.what}</b>
				<span>{line.detail}</span>
			</div>
		))}
	</div>
);
