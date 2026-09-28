import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMachines, readMachinesFile, readMainId } from './machines-file.js';

describe('machines.json', () => {
	it('as crew writes it → read back the same', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'voiceos-machines-')), 'machines.json');
		const machines = [{ id: 'vm1', host: 'dev@vm1.example.com', name: 'Build box' }];

		writeFileSync(file, JSON.stringify(machines));
		expect(readMachinesFile(file)).toEqual(machines);
	});

	it('missing or broken → no machines', () => {
		expect(readMachinesFile('/nonexistent/machines.json')).toEqual([]);
		expect(parseMachines('{not json')).toEqual([]);
	});

	it('an entry breaking a rule → left out; a blank name → its id', () => {
		expect(
			parseMachines(
				JSON.stringify([
					{ id: 'vm1', host: '-oProxyCommand=x', name: 'bad' },
					{ id: 'VM2', host: 'vm2', name: 'bad id' },
					{ id: 'vm3', host: 'vm3', name: '  ' },
				]),
			),
		).toEqual([{ id: 'vm3', host: 'vm3', name: 'vm3' }]);
	});
});

describe('readMainId', () => {
	it('made once, then the same on every start', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'voiceos-main-id-')), 'main-id');
		const first = readMainId(file);

		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(readMainId(file)).toBe(first);
	});
});
