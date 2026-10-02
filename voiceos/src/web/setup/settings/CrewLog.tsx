// crew's own log (crew debug), read only while it is open.
import { useState } from 'react';
import { useCrew } from '../api.js';
import type { SetupContext } from '../common.js';

export const CrewLog = ({ ctx }: { ctx: SetupContext }) => {
	const [isOpen, setIsOpen] = useState(false);
	const log = useCrew<unknown>(ctx.machine, isOpen ? { type: 'debug_tail', lines: 200 } : null);

	return (
		<details className="env-all" onToggle={(event) => setIsOpen(event.currentTarget.open)}>
			<summary>crew's log</summary>
			<pre className="log big">{log.reply ? log.reply.stdout || log.reply.stderr : 'Reading…'}</pre>
			<small className="m">
				Every git, tmux and install command crew ran, newest last (crew debug).
			</small>
		</details>
	);
};
