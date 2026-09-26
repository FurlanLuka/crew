import { type ToolCall, type ToolName, MUTATING_TOOLS } from './definitions.js';

const SILENT_TOOLS: ToolName[] = [
	'forward',
	'send_to',
	'switch_view',
	'start_session',
	'ignore_words',
	'answer',
	'interrupt',
	'mute',
	'dev_offer',
	'allow_denied',
];

const REMEMBERED_TOOLS: ToolName[] = [...MUTATING_TOOLS, 'switch_view'];
const MAX_QUOTED_CHARS = 120;

const describeCallAction = (input: Record<string, unknown>): string => {
	if (typeof input.action === 'string') {
		return ` ${input.action}`;
	}

	if (typeof input.decision === 'string') {
		return ` ${input.decision}`;
	}

	if (typeof input.accept === 'boolean') {
		return ` ${input.accept ? 'accepted' : 'declined'}`;
	}

	return '';
};

export const describeToolCall = ({ name, input, ok }: ToolCall): string | null => {
	// Remembered so a follow-up ("also start it") is not taken as a request to do it again.
	if (!REMEMBERED_TOOLS.includes(name as ToolName)) {
		return null;
	}

	const quotedText =
		typeof input.text === 'string'
			? ` "${input.text.length > MAX_QUOTED_CHARS ? `${input.text.slice(0, MAX_QUOTED_CHARS)}…` : input.text}"`
			: '';
	const target =
		name === 'switch_view'
			? ` ${typeof input.ref === 'string' ? input.ref : 'mission control'}`
			: typeof input.ref === 'string'
				? ` ${input.ref}`
				: '';

	return `${name}${describeCallAction(input)}${target}${quotedText}${ok ? '' : ' (failed)'}`;
};

export const isSilentCall = (name: string, input: Record<string, unknown>): boolean => {
	// crew_dev start, stop and restart need no reply: the dev servers announce themselves.
	if (name === 'crew_dev') {
		return input.action !== 'status';
	}

	return SILENT_TOOLS.includes(name as ToolName);
};
