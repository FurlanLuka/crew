import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Write-then-rename: a crash mid-write leaves the previous file intact.
export const writeJsonAtomic = (file: string, value: unknown): void => {
	mkdirSync(dirname(file), { recursive: true });

	const temporaryFile = `${file}.${process.pid}.tmp`;

	writeFileSync(temporaryFile, JSON.stringify(value, null, 2));
	renameSync(temporaryFile, file);
};
