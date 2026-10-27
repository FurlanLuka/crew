// Home on a phone: each active session as one row of a grouped list, as iOS lists go — its initials
// and dot, its name, the machine when it isn't this one, its age, and one line of where it stands.
// The order is desktop Home's (listHomeSections): groups in the bar's order, then the rest, waiting
// first inside each. A tap opens the session.
import { listActiveRefs } from '../../../shared/active.js';
import { readSessionLabel } from '../../../shared/machines.js';
import type { SessionGroup, State } from '../../../shared/protocol.js';
import { countOf } from '../../count.js';
import { isWaiting } from '../../derive.js';
import { describePhoneCard, readInitials } from '../../phone-home.js';
import type { Dispatch } from '../../types.js';
import { useNow } from '../../use-now.js';
import { countMachines, describeSectionCount, listHomeSections } from '../ActiveView.js';

interface PhoneHomeProps {
	state: State;
	dispatch: Dispatch;
}

const Chevron = () => (
	<svg width="7" height="12" viewBox="0 0 10 16" aria-hidden="true">
		<path
			d="M2 1l6 7-6 7"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

interface RowProps {
	state: State;
	dispatch: Dispatch;
	sessionRef: string;
	now: number;
}

const SessionRow = ({ state, dispatch, sessionRef: ref, now }: RowProps) => {
	const card = describePhoneCard(state, ref, now);

	if (!card) {
		return null;
	}

	return (
		<button
			type="button"
			className={`ph-row ${card.isWaiting ? 'waiting' : ''}`}
			data-ref={ref}
			onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
		>
			<span className="ph-tile" aria-hidden="true">
				{card.initials}
				<i className={`dot ${card.dot}`} />
			</span>
			<span className="ph-text">
				<span className="ph-title">
					<b>{card.title}</b>
					{card.machine && <span className="ph-machine">{card.machine}</span>}
					{card.age && <span className="ph-age">{card.age}</span>}
				</span>
				<span className="ph-line">{card.line}</span>
			</span>
			{card.isWaiting ? (
				<span className="ph-badge" aria-hidden="true" />
			) : (
				<span className="ph-go" aria-hidden="true">
					<Chevron />
				</span>
			)}
		</button>
	);
};

const MissingRow = ({ state, sessionRef: ref }: { state: State; sessionRef: string }) => {
	const title = readSessionLabel(state, ref);

	return (
		<div className="ph-row missing" data-ref={ref}>
			<span className="ph-tile" aria-hidden="true">
				{readInitials(title)}
				<i className="dot ring" />
			</span>
			<span className="ph-text">
				<span className="ph-title">
					<b>{title}</b>
				</span>
				<span className="ph-line">Out of reach · starts when it's back</span>
			</span>
		</div>
	);
};

interface SectionHeadProps {
	state: State;
	group: SessionGroup | null;
	refs: string[];
}

const SectionHead = ({ state, group, refs }: SectionHeadProps) => (
	<div className="ph-head">
		{group && <span className="ph-swatch" aria-hidden="true" />}
		<b>{group?.name ?? 'Not in a group'}</b>
		<span className={refs.some((ref) => isWaiting(state, ref)) ? 'alarm' : ''}>
			{describeSectionCount(state, refs)}
		</span>
	</div>
);

export const PhoneHome = ({ state, dispatch }: PhoneHomeProps) => {
	const now = useNow();
	const refs = listActiveRefs(state);
	const sections = listHomeSections(state);
	const hasGroups = sections.some((section) => section.group);
	const waiting = refs.filter((ref) => isWaiting(state, ref)).length;

	return (
		<section className="vo-view ph-home" aria-label="Home">
			<div className="ph-top">
				<h1>Home</h1>
				<span className="ph-lead">
					{refs.length === 0
						? 'Nothing active yet.'
						: `${countOf(refs.length, 'session')} on ${countOf(countMachines(refs), 'machine')}${waiting > 0 ? ` · ${countOf(waiting, 'needs', 'need')} you` : ''}`}
				</span>
			</div>
			{sections.length === 0 ? (
				<div className="vo-empty">
					<b>Nothing active</b>
					<p>
						An active worktree has its own Claude. Pick the ones you're working on, or start a plain
						session in any folder.
					</p>
					<button
						type="button"
						className="btn primary"
						onClick={() => dispatch({ type: 'switch_view', view: { kind: 'activate' } })}
					>
						Activate a worktree
					</button>
				</div>
			) : (
				sections.map(({ group, refs: members, missing }) => (
					<section
						key={group?.id ?? 'plain'}
						className="ph-section"
						data-color={group?.color}
						aria-label={group?.name ?? (hasGroups ? 'Not in a group' : 'Sessions')}
					>
						{(group || hasGroups) && <SectionHead state={state} group={group} refs={members} />}
						<div className="ph-list">
							{members.map((ref) => (
								<SessionRow
									key={ref}
									state={state}
									dispatch={dispatch}
									sessionRef={ref}
									now={now}
								/>
							))}
							{missing.map((ref) => (
								<MissingRow key={ref} state={state} sessionRef={ref} />
							))}
						</div>
					</section>
				))
			)}
		</section>
	);
};
