// One row under a session's header: a call auto mode blocked, a machine that dropped, or a crash —
// each with its way out. What the session waits on is docked above the voice bar (BottomBar).
import type { State } from '../../shared/protocol.js';
import { readLabel } from '../../state/helpers.js';
import { describeSessionState } from '../moments.js';
import type { Dispatch } from '../types.js';
import { DenialStrip } from './DenialStrip.js';

interface SessionStateRowProps {
	state: State;
	sessionRef: string;
	dispatch: Dispatch;
}

export const SessionStateRow = ({ state, sessionRef, dispatch }: SessionStateRowProps) => {
	const row = describeSessionState(state, sessionRef);

	switch (row.kind) {
		case 'denial':
			return (
				<DenialStrip
					denial={row.denial}
					label={readLabel(state, row.denial.ref)}
					dispatch={dispatch}
				/>
			);
		case 'dropped':
			return (
				<div className="vs-state wait" role="status">
					<span className="dot run" />
					<b>{row.machine} dropped</b>
					<span className="m">
						{row.detail ? `${row.detail} · ` : ''}reconnecting · your words wait here and go when
						it's back; its Claude keeps working there
					</span>
				</div>
			);
		case 'crashed':
			return (
				<div className="vs-state crit" role="status">
					<span className="dot ask" />
					<b>Claude stopped unexpectedly</b>
					<span className="m">{row.error} · nothing you said was lost</span>
					<span className="row-actions">
						<button
							type="button"
							className="btn sm primary"
							onClick={() => dispatch({ type: 'activate', ref: sessionRef })}
						>
							Restart
						</button>
					</span>
				</div>
			);
		case 'none':
			return null;
	}
};
