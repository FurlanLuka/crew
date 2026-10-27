// The listening modes as a sheet over the conversation, opened from the bar's left button.
import { useEffect, useRef } from 'react';
import type { InputMode } from '../../listen-mode.js';
import { ModeList, PHONE_DESCRIPTIONS } from '../ModeMenu.js';

interface ModeSheetProps {
	mode: InputMode;
	modes: InputMode[];
	onChoose: (mode: InputMode) => void;
	onClose: () => void;
}

export const ModeSheet = ({ mode, modes, onChoose, onClose }: ModeSheetProps) => {
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

	useEffect(() => {
		itemRefs.current[modes.indexOf(mode)]?.focus();
	}, [mode, modes]);

	return (
		<>
			<div className="mscrim" aria-hidden="true" onClick={onClose} />
			<div className="msheet">
				<ModeList
					mode={mode}
					modes={modes}
					itemRefs={itemRefs}
					descriptions={PHONE_DESCRIPTIONS}
					onChoose={(chosen) => {
						onChoose(chosen);
						onClose();
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							onClose();
						}
					}}
				/>
			</div>
		</>
	);
};
