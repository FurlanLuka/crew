// A call auto mode blocked, docked above the voice bar like a permission the session asks for: allow
// it once, or leave it blocked.
import type { Denial } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';

interface DenialStripProps {
	denial: Denial;
	label: string;
	dispatch: Dispatch;
}

export const DenialStrip = ({ denial, label, dispatch }: DenialStripProps) => (
	<section className="dock crit" aria-label="denied">
		<span className="lbl c-crit">
			blocked · {label} · {denial.toolName}
		</span>
		<div className="ask">
			Auto mode blocked {label} from trying to {denial.summary}.
		</div>
		<div className="btns">
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
		</div>
	</section>
);
