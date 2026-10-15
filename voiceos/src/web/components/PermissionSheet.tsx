import type { PendingAsk, PermissionDecision } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { describeAlways, describePermission, type PermissionBody, SAY } from '../prompts.js';
import { CommandBlock, OwnAnswer, Sheet, SheetFoot, useOwnAnswer } from './PromptSheet.js';

type PermissionAsk = Extract<PendingAsk, { kind: 'permission' }>;

interface PermissionSheetProps {
	ask: PermissionAsk;
	dispatch: Dispatch;
}

interface PermissionBodyViewProps {
	body: PermissionBody;
}

const PermissionBodyView = ({ body }: PermissionBodyViewProps) => {
	switch (body.kind) {
		case 'command':
			return <CommandBlock segments={body.segments} />;
		case 'text':
			return <pre className="sh-cmd plain">{body.text}</pre>;
		case 'fields':
			return (
				<dl className="sh-fields">
					{body.fields.map((field) => (
						<div key={field.key}>
							<dt>{field.key}</dt>
							<dd>{field.value}</dd>
						</div>
					))}
				</dl>
			);
	}
};

export const PermissionSheet = ({ ask, dispatch }: PermissionSheetProps) => {
	const why = useOwnAnswer();
	const copy = describePermission(ask);
	const always = describeAlways(ask.suggestions);

	const answer = (decision: PermissionDecision, message?: string) =>
		dispatch({
			type: 'answer_permission',
			askId: ask.id,
			decision,
			...(message ? { message } : {}),
		});

	return (
		<Sheet
			kind="permission"
			label="permission"
			tone="crit"
			title={copy.title}
			reason={copy.reason}
			meta={<span className="sh-tool">{ask.toolName}</span>}
		>
			{copy.body ? (
				<div className="sh-body">
					<PermissionBodyView body={copy.body} />
				</div>
			) : null}
			{why.isOpen ? (
				<OwnAnswer
					lead="Deny, and tell it"
					placeholder="What should it do instead?"
					submitLabel="Deny and send"
					onSubmit={(message) => answer('deny', message)}
					onCancel={why.cancel}
				/>
			) : (
				<SheetFoot sessionRef={ask.ref} say={always ? SAY.permission : SAY.permissionNoAlways}>
					<button type="button" className="btn ghost" ref={why.openerRef} onClick={why.open}>
						Deny and say why…
					</button>
					<button type="button" className="btn deny" onClick={() => answer('deny')}>
						Deny
					</button>
					{always && (
						<button
							type="button"
							className="btn"
							title={always.title}
							onClick={() => answer('always')}
						>
							{/* Spaced in the text too, so its name reads "Always allow bun test". */}
							Always allow
							{always.rule ? (
								<>
									{' '}
									<code>{always.rule}</code>
								</>
							) : null}
							{always.more > 0 ? (
								<>
									{' '}
									<span className="sh-more">+{always.more} more</span>
								</>
							) : null}
						</button>
					)}
					<button type="button" className="btn primary" onClick={() => answer('allow')}>
						Allow
					</button>
				</SheetFoot>
			)}
		</Sheet>
	);
};
