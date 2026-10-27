// One screen at a time listens and speaks: the page opened last. Every other one steps aside behind
// this, until "Use here" takes the role back.
interface MainElsewhereProps {
	device: string;
	onUseHere: () => void;
}

export const MainElsewhere = ({ device, onUseHere }: MainElsewhereProps) => (
	<div
		className="vo-elsewhere"
		role="dialog"
		aria-modal="true"
		aria-label="Voice OS is open elsewhere"
	>
		<div className="vo-elsewhere-card">
			<span className="wm">
				crew<span>Voice OS</span>
			</span>
			<h1>Voice OS is open on {device || 'another screen'}</h1>
			<p>One screen listens and speaks at a time. Use it here, and the other one steps aside.</p>
			<button type="button" className="btn big primary" onClick={onUseHere}>
				Use here
			</button>
		</div>
	</div>
);
