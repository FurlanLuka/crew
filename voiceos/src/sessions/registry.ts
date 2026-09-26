import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../log.js';

const log = createLogger('registry');

export interface SessionRecord {
	sessionId: string;
	updatedAt: string;
	// The Voice OS context version this session has seen (voice-context.ts).
	briefing?: string;
}

export type Registry = Record<string, SessionRecord>;

const readRegistryText = (file: string): string | null => {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		// A missing registry is a fresh start.
		return null;
	}
};

export const loadRegistry = (file: string): Registry => {
	const text = readRegistryText(file);

	if (text === null) {
		return {};
	}

	try {
		const parsed = JSON.parse(text) as unknown;

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('not an object');
		}

		const registry: Registry = {};

		for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
			const record = value as Partial<SessionRecord>;

			if (typeof record?.sessionId === 'string') {
				registry[ref] = {
					sessionId: record.sessionId,
					updatedAt: String(record.updatedAt ?? ''),
					...(typeof record.briefing === 'string' ? { briefing: record.briefing } : {}),
				};
			}
		}

		return registry;
	} catch (error) {
		log.warn('registry unreadable, starting empty', { file, error: String(error) });

		return {};
	}
};

export const saveRegistry = (file: string, registry: Registry): void => {
	mkdirSync(dirname(file), { recursive: true });

	// Write-then-rename: a crash mid-write leaves the previous file intact.
	const temporaryFile = `${file}.${process.pid}.tmp`;

	writeFileSync(temporaryFile, JSON.stringify(registry, null, 2));
	renameSync(temporaryFile, file);
};

export interface RecordSessionParams {
	file: string;
	ref: string;
	sessionId: string;
	briefing?: string;
	now?: Date;
}

export const recordSession = ({
	file,
	ref,
	sessionId,
	briefing,
	now = new Date(),
}: RecordSessionParams): Registry => {
	const registry = loadRegistry(file);
	const previous = registry[ref];
	// A resumed session (same id) keeps the briefing it had: its prompt did not change.
	const seenBriefing = previous?.sessionId === sessionId ? previous.briefing : briefing;

	registry[ref] = {
		sessionId,
		updatedAt: now.toISOString(),
		...(seenBriefing ? { briefing: seenBriefing } : {}),
	};
	saveRegistry(file, registry);

	return registry;
};

export const markBriefed = (file: string, ref: string, briefing: string): Registry => {
	const registry = loadRegistry(file);
	const record = registry[ref];

	if (record) {
		registry[ref] = { ...record, briefing };
	}

	saveRegistry(file, registry);

	return registry;
};

export const forgetSession = (file: string, ref: string): Registry => {
	const registry = loadRegistry(file);

	delete registry[ref];
	saveRegistry(file, registry);

	return registry;
};
