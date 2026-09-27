import type { Denial } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';

interface DenialStripProps {
	denial: Denial;
	label: string;
	dispatch: Dispatch;
}

export const DenialStrip = ({ denial, label, dispatch }: DenialStripProps) => {
	return (
		<section className="strip crit" aria-label="denied">
			<span className="lbl c-crit">blocked · {label}</span>
			<span className="say">
				Auto mode blocked {label} from trying to {denial.summary}.
			</span>
			<button
				type="button"
				className="btn primary"
				onClick={() => dispatch({ type: 'allow_denied', denialId: denial.id })}
			>
				Allow it · “allow it”
			</button>
			<button
				type="button"
				className="btn"
				onClick={() => dispatch({ type: 'dismiss_denial', denialId: denial.id })}
			>
				Leave it blocked
			</button>
		</section>
	);
};
