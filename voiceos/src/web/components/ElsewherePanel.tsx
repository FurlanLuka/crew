import type { State } from '../../shared/protocol.js';
import { listOtherSessions } from '../derive.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';

interface ElsewherePanelProps {
	state: State;
	screen: string | null;
	dispatch: Dispatch;
}

export const ElsewherePanel = ({ state, screen, dispatch }: ElsewherePanelProps) => {
	const now = useNow();
	const rows = listOtherSessions(state, screen, now);

	if (rows.length === 0) {
		return null;
	}

	return (
		<section className="panel elsewhere" aria-label="elsewhere">
			<span className="lbl">elsewhere</span>
			{rows.map((row) => (
				<button
					type="button"
					key={row.ref}
					className="elsewhere-row"
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref: row.ref } })}
				>
					<span className={row.isWaiting ? 'c-crit' : 'c-amber'}>{row.label}</span>
					<span className="el">
						{row.isWaiting ? `waiting ${row.age ?? ''}` : `working ${row.age ?? ''}`}
					</span>
					<div className="c-dim">{row.text}</div>
				</button>
			))}
		</section>
	);
};
