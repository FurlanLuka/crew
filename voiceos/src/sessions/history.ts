import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { StreamItem } from '../shared/protocol.js';
import type { Store } from '../state/store.js';
import { STREAM_ITEMS_KEPT, createStreamItem, isShownAlready } from '../state/helpers.js';
import { createLogger } from '../log.js';
import { createMapContext, mapMessage, type MediaHooks, type RawMessage } from './events.js';
import { createMediaHooks, type ImageSource } from './media.js';

const log = createLogger('history');

export type TranscriptMessage = RawMessage & {
	uuid: string;
	timestamp?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
};

const HARNESS_TEXT_PATTERN =
	/^\s*(\[Request interrupted|<command-name>|<command-message>|<local-command-stdout>|<local-command-stderr>|<system-reminder>|<bash-input>|<bash-stdout>|Caveat: The messages below|This session is being continued from a previous conversation)/;

const extractPromptText = (message: TranscriptMessage): string | null => {
	const content = message.message?.content;

	if (typeof content === 'string') {
		return content;
	}

	if (!Array.isArray(content)) {
		return null;
	}

	const parts = content as Record<string, unknown>[];

	if (parts.some((part) => part.type === 'tool_result')) {
		return null;
	}

	return parts
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string)
		.join('\n');
};

export interface ConvertHistoryToStreamParams {
	messages: TranscriptMessage[];
	ref: string;
	cwd?: string;
	now: number;
	media?: MediaHooks;
}

export const convertHistoryToStream = ({
	messages,
	ref,
	cwd,
	now,
	media,
}: ConvertHistoryToStreamParams): StreamItem[] => {
	// Diffs are not in the transcript, so a restored edit shows as its tool line and result only.
	const mapContext = createMapContext(ref, media);
	const items: StreamItem[] = [];

	for (const message of messages) {
		if (message.isMeta || message.isSidechain) {
			continue;
		}

		const parsedAt = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
		const at = Number.isNaN(parsedAt) ? now : parsedAt;
		const prompt = message.type === 'user' ? extractPromptText(message) : null;

		if (prompt !== null) {
			// Harness text is what Claude Code adds to the user's turn that the developer never typed.
			if (prompt.trim() && !HARNESS_TEXT_PATTERN.test(prompt)) {
				items.push({ id: `h:${message.uuid}`, at, kind: 'user', text: prompt });
			}

			continue;
		}

		for (const [index, observation] of mapMessage(message, mapContext, cwd).entries()) {
			// The same rule as live: a doc linked again or an image shown again is one line.
			const item = isShownAlready(items, observation)
				? null
				: createStreamItem({ observation, id: `h:${message.uuid}:${index}`, at });

			if (item) {
				items.push(item);
			}
		}
	}

	return items.slice(-STREAM_ITEMS_KEPT);
};

export type LoadTranscript = (sessionId: string, cwd: string) => Promise<TranscriptMessage[]>;

export const loadTranscript: LoadTranscript = async (sessionId, cwd) => {
	// The SDK types a message body as unknown; convertHistoryToStream reads it as the loose RawMessage.
	return (await getSessionMessages(sessionId, { dir: cwd })) as unknown as TranscriptMessage[];
};

interface StoredSession {
	sessionId: string;
}

export interface RestoreHistoryParams {
	store: Store;
	sessions: Record<string, StoredSession>;
	getCwd: (ref: string) => string | null;
	// The session's folders, for which images it may show again.
	getImageSource: (ref: string) => ImageSource | undefined;
	// Where tool screenshots are kept; unset restores no images.
	mediaDir?: string;
	loadMessages: LoadTranscript;
	now?: () => number;
}

export const restoreHistory = async ({
	store,
	sessions,
	getCwd,
	getImageSource,
	mediaDir,
	loadMessages,
	now = Date.now,
}: RestoreHistoryParams): Promise<void> => {
	for (const [ref, { sessionId }] of Object.entries(sessions)) {
		const cwd = getCwd(ref);

		if (!cwd) {
			continue;
		}

		// A session whose folders are unknown shows no images of its own: closed, never home by mistake.
		const imageSource = getImageSource(ref);
		const media =
			mediaDir && imageSource
				? createMediaHooks({
						session: imageSource,
						mediaDir,
						log: (message, fields) => log.info(message, { ref, ...fields }),
					})
				: undefined;

		// A transcript that cannot be read leaves that stream empty; the others still restore.
		try {
			const messages = await loadMessages(sessionId, cwd);
			const items = convertHistoryToStream({
				messages,
				ref,
				cwd,
				now: now(),
				...(media ? { media } : {}),
			});

			log.info('restored', { ref, messages: messages.length, items: items.length });

			if (items.length) {
				store.dispatch({ type: 'history_restored', ref, items });
			}
		} catch (error) {
			log.warn('history unreadable', { ref, error: String(error) });
		}
	}
};
