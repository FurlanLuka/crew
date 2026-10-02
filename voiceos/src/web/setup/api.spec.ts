import { describe, expect, it } from 'bun:test';
import { INVALID_REPLY, describeRefusal, readCrewLine, readCrewResponse } from './api.js';

describe('readCrewResponse', () => {
	it("200 with crew's answer → that answer, json kept when there is one", () => {
		expect(readCrewResponse(200, { code: 0, stdout: '[]', stderr: '', json: [] })).toEqual({
			code: 0,
			stdout: '[]',
			stderr: '',
			json: [],
		});
		expect(readCrewResponse(200, { code: 1, stdout: '', stderr: 'Error: x\n' })).toEqual({
			code: 1,
			stdout: '',
			stderr: 'Error: x\n',
		});
	});

	it.each([
		['not JSON at all', undefined],
		['a proxy page', '<html>'],
		['a code that is text', { code: '0', stdout: '', stderr: '' }],
		['stdout missing', { code: 0, stderr: '' }],
	])('200 with %s → a failure the page can say, never read as an answer', (_, body) => {
		expect(readCrewResponse(200, body)).toMatchObject({ code: -1, reason: INVALID_REPLY });
	});

	it('202 → started', () => {
		expect(readCrewResponse(202, { started: true })).toEqual({ code: 0, stdout: '', stderr: '' });
	});

	it('a refusal → its reason, error and an old remote version', () => {
		expect(
			readCrewResponse(426, {
				error: 'Build box runs an older crew',
				reason: 'remote_outdated',
				version: '4.1.0',
			}),
		).toEqual({
			code: -1,
			stdout: '',
			stderr: 'Build box runs an older crew',
			reason: 'remote_outdated',
			version: '4.1.0',
		});
	});

	it('a refusal with a body that is not ours → the status says it', () => {
		expect(readCrewResponse(502, { reason: 7 })).toEqual({
			code: -1,
			stdout: '',
			stderr: "crew's server answered 502",
			reason: '502',
		});
	});
});

describe('readCrewLine / describeRefusal', () => {
	it("a document on stdout is never the line: crew's narration on stderr is", () => {
		expect(
			readCrewLine({ code: 0, stdout: '{\n  "renamed": "vm1"\n}\n', stderr: '', json: {} }),
		).toBe('');
		expect(
			readCrewLine({ code: 0, stdout: '[]', stderr: 'Created store-front/wrk2\n', json: [] }),
		).toBe('Created store-front/wrk2');
		expect(readCrewLine({ code: 0, stdout: 'Removed vm1.\n', stderr: '' })).toBe('Removed vm1.');
	});

	it('an older remote → its version and that it updates from this Mac', () => {
		expect(
			describeRefusal({
				code: -1,
				stdout: '',
				stderr: 'vm1 runs an older crew that cannot do this yet — it updates from this Mac',
				reason: 'remote_outdated',
				version: '4.1.0',
			}),
		).toBe(
			'vm1 runs an older crew that cannot do this yet — it updates from this Mac (it runs crew 4.1.0)',
		);
	});
});
