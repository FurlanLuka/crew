// One session asking, telling or requesting a secret from another, as each of the two shows it: the
// asker's card in amber where its tool ran, the asked one's dimmed, since its own conversation never
// saw the exchange.
import type { StreamItem } from '../../shared/protocol.js';
import { AttachedFiles } from './AttachmentChips.js';
import { Markdown } from './Markdown.js';

type PeerItem = Extract<StreamItem, { kind: 'session_ask' }>;

const ASKER_VERB = { ask: 'asked', tell: 'told', secret: 'asked for a secret from' } as const;

const STATUS_TEXT: Record<PeerItem['status'], string> = {
	asking: 'waiting for the answer…',
	answered: 'answered',
	sent: 'sent',
	needs_work: 'would need work: asked you to allow it',
	waiting_ok: 'waiting for your OK',
	refused: 'not sent',
	failed: 'no answer',
};

export const describePeerCard = (item: PeerItem): { head: string; status: string } => {
	const status = STATUS_TEXT[item.status];

	if (item.role === 'asked') {
		const answeredBy = item.status === 'answered' ? 'a copy answered' : status;
		const read = item.read?.length ? ` · read ${item.read.length}` : '';

		return {
			head: `${item.peer} asked`,
			status: `${answeredBy}${read} · this session didn't stop`,
		};
	}

	return { head: `${ASKER_VERB[item.request]} ${item.peer}`, status };
};

export const PeerCard = ({ item }: { item: PeerItem }) => {
	const { head, status } = describePeerCard(item);
	const isAnswerShown = item.answer && item.request !== 'tell';

	return (
		<div className={`aside peer ${item.role}`} data-status={item.status}>
			<div className="line user">
				› <span className={item.role === 'asker' ? 'c-amber' : 'c-dim'}>{head}</span> {item.text}{' '}
				<span className="c-dim">· {status}</span>
			</div>
			{isAnswerShown && (
				<div className="line text">
					<Markdown text={item.answer ?? ''} />
				</div>
			)}
			{item.files?.length ? <AttachedFiles attachments={item.files} /> : null}
		</div>
	);
};
