// A call auto mode blocked, docked above the voice bar like a permission the session asks for: allow
// it once, or leave it blocked.
import type { Denial } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { SAY } from '../prompts.js';
import { Sheet, SheetFoot } from './PromptSheet.js';

interface DenialSheetProps {
	denial: Denial;
	label: string;
	dispatch: Dispatch;
}

export const DenialSheet = ({ denial, label, dispatch }: DenialSheetProps) => (
	<Sheet
		kind="denied"
		label="denied"
		tone="crit"
		title="Auto mode blocked this"
		reason={`${label} tried to ${denial.summary}`}
		meta={<span className="sh-tool">{denial.toolName}</span>}
		isRow
	>
		<SheetFoot sessionRef={denial.ref} say={SAY.denied}>
			<button
				type="button"
				className="btn ghost"
				onClick={() => dispatch({ type: 'dismiss_denial', denialId: denial.id })}
			>
				Leave it blocked
			</button>
			<button
				type="button"
				className="btn primary"
				onClick={() => dispatch({ type: 'allow_denied', denialId: denial.id })}
			>
				Allow once
			</button>
		</SheetFoot>
	</Sheet>
);
