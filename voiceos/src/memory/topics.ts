import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SavedTopics, State } from '../shared/protocol.js';
import type { Store } from '../state/store.js';

interface RawTopic {
	topic?: unknown;
	pinned?: unknown;
}

export const loadTopics = (file: string): SavedTopics => {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}

		const topics: SavedTopics = {};

		for (const [ref, value] of Object.entries(parsed as Record<string, RawTopic>)) {
			if (typeof value?.topic === 'string') {
				topics[ref] = { topic: value.topic, pinned: value.pinned === true };
			}
		}

		return topics;
	} catch {
		// A missing or corrupt topics file starts empty.
		return {};
	}
};

export const collectTopics = (state: State): SavedTopics => {
	const topics: SavedTopics = {};

	for (const session of Object.values(state.sessions)) {
		if (session.topic) {
			topics[session.ref] = { topic: session.topic, pinned: session.isTopicPinned };
		}
	}

	return topics;
};

export const saveTopics = (file: string, topics: SavedTopics): void => {
	mkdirSync(dirname(file), { recursive: true });

	// Write-then-rename: a crash mid-write leaves the previous file intact.
	const temporaryFile = `${file}.${process.pid}.tmp`;

	writeFileSync(temporaryFile, JSON.stringify(topics, null, 2));
	renameSync(temporaryFile, file);
};

interface PersistTopicsParams {
	store: Store;
	file: string;
}

export const persistTopics = ({ store, file }: PersistTopicsParams): void => {
	// Restored once the worktrees are known; saved whenever the narrator learns or the developer pins one.
	const saved = loadTopics(file);

	if (Object.keys(saved).length > 0) {
		store.dispatch({ type: 'topics_restored', topics: saved });
	}

	store.subscribe((stamped, state) => {
		if (stamped.input.type === 'narration' || stamped.input.type === 'pin_topic') {
			saveTopics(file, collectTopics(state));
		}
	});
};
