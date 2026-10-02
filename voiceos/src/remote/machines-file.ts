// machines.json: the one list of other machines. crew (`crew server machines`) is its only writer,
// for the page and voice too; a running Voice OS reads it again when it changes.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isValidHost } from '../shared/machines.js';
import type { MachineConfig } from '../shared/protocol.js';

const MACHINE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

const isMachineConfig = (value: unknown): value is MachineConfig => {
	const machine = value as MachineConfig;

	return (
		typeof value === 'object' &&
		value !== null &&
		typeof machine.id === 'string' &&
		MACHINE_ID_PATTERN.test(machine.id) &&
		typeof machine.host === 'string' &&
		isValidHost(machine.host) &&
		typeof machine.name === 'string'
	);
};

// A missing or broken file is no machines; an entry that fails a rule is left out, never guessed.
export const parseMachines = (text: string): MachineConfig[] => {
	try {
		const parsed = JSON.parse(text) as unknown;

		return Array.isArray(parsed)
			? parsed
					.filter(isMachineConfig)
					.map(({ id, host, name }) => ({ id, host, name: name.trim() || id }))
			: [];
	} catch {
		return [];
	}
};

export const readMachinesFile = (file: string): MachineConfig[] => {
	try {
		return parseMachines(readFileSync(file, 'utf8'));
	} catch {
		return [];
	}
};

export const sameMachines = (left: MachineConfig[], right: MachineConfig[]): boolean =>
	JSON.stringify(left) === JSON.stringify(right);

// Who this main is to a remote, kept across restarts: the same main may take over its own stale link.
export const readMainId = (file: string): string => {
	try {
		const id = readFileSync(file, 'utf8').trim();

		if (id) {
			return id;
		}
	} catch {
		// Not made yet.
	}

	const id = randomUUID();

	writeFileSync(file, `${id}\n`, { mode: 0o600 });

	return id;
};
