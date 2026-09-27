import type { DevServer } from '../../shared/protocol.js';

interface DevBadgeProps {
	servers: DevServer[] | undefined;
	isStarting: boolean;
}

export const DevBadge = ({ servers, isStarting }: DevBadgeProps) => {
	if (isStarting) {
		return <span className="devbadge c-amber">dev starting</span>;
	}

	if (!servers || servers.length === 0) {
		return null;
	}

	const runningCount = servers.filter((server) => server.state === 'running').length;

	return (
		<span className={`devbadge ${runningCount < servers.length ? 'c-crit' : 'c-good'}`}>
			dev {runningCount}/{servers.length}
		</span>
	);
};
