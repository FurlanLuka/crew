// What Voice OS just asked or told, as one row above the spoken line: the answers as buttons, and
// what to say instead. A "not now" sets this moment aside on this page; Voice OS lets it lapse.
import { useState } from 'react';
import type { State } from '../../shared/protocol.js';
import { describeMoment } from '../moments.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';

interface MomentsRowProps {
	state: State;
	dispatch: Dispatch;
}

export const MomentsRow = ({ state, dispatch }: MomentsRowProps) => {
	const now = useNow(5000);
	const [setAside, setSetAside] = useState<string | null>(null);
	const moment = describeMoment(state, now);

	if (!moment || moment.key === setAside) {
		return null;
	}

	return (
		<div className="vo-offer" role="status" aria-label="Voice OS asks">
			<p>{moment.text}</p>
			<span className="say">{moment.say}</span>
			<span className="row-actions">
				{moment.answers.map((answer) => (
					<button
						key={answer.label}
						type="button"
						className={`btn sm ${answer.isPrimary ? 'primary' : ''}`}
						onClick={() => {
							if (answer.action) {
								dispatch(answer.action);
							}

							setSetAside(moment.key);
						}}
					>
						{answer.label}
					</button>
				))}
			</span>
		</div>
	);
};
