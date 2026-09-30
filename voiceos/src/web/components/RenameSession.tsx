import { useState, type FormEvent } from 'react';
import { MAX_NAME_LENGTH, toSessionName } from '../../state/names.js';
import type { Dispatch } from '../types.js';

interface RenameSessionProps {
	sessionRef: string;
	// What the field starts with: the name the developer sees now.
	current: string;
	dispatch: Dispatch;
	onDone: () => void;
}

// Enter saves, an empty field clears the name (crew's label comes back); Esc or leaving the field keeps it.
export const RenameSession = ({ sessionRef, current, dispatch, onDone }: RenameSessionProps) => {
	const [name, setName] = useState(current);

	const save = (event: FormEvent) => {
		event.preventDefault();

		const next = toSessionName(name);

		if (next !== current) {
			dispatch({ type: 'rename_session', ref: sessionRef, name: next });
		}

		onDone();
	};

	return (
		<form onSubmit={save} className="session-rename">
			<input
				// Opened by the rename button: typing goes straight into it.
				ref={(input) => input?.focus()}
				value={name}
				maxLength={MAX_NAME_LENGTH}
				aria-label="session name"
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						onDone();
					}
				}}
				onBlur={onDone}
			/>
		</form>
	);
};

interface RenameButtonProps {
	onClick: () => void;
}

export const RenameButton = ({ onClick }: RenameButtonProps) => (
	<button type="button" className="btn small rename" onClick={onClick}>
		rename
	</button>
);
