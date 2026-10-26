import { describe, expect, it } from 'bun:test';
import {
	describePhone,
	describeSince,
	isPhoneCode,
	isRecentlyOpened,
	listTailscaleSteps,
	readPhoneName,
	type TailscaleStatus,
	toQrPath,
} from './your-phone.js';

const NOW = Date.parse('2026-10-26T09:00:00Z');

const SIGNED_IN: TailscaleStatus = {
	installed: true,
	running: true,
	signed_in: true,
	user: 'dev@',
	host: 'studio-mac.tail4f2a.ts.net',
	https: false,
	serving: false,
	url: '',
};

describe('toQrPath', () => {
	it('draws a square code with its three finder corners dark', () => {
		const { size, path } = toQrPath('https://studio-mac.tail4f2a.ts.net/phone/KEY');

		expect(size).toBeGreaterThanOrEqual(21);
		expect(path).toStartWith('M0 0h1v1h-1z');
		expect(path).toContain(`M${size - 1} 0h1v1h-1z`);
		expect(path).toContain(`M0 ${size - 1}h1v1h-1z`);
	});
});

describe('describePhone', () => {
	it('when it was added and last opened', () => {
		expect(
			describePhone(
				{
					id: 'p1',
					name: 'Phone',
					created: '2026-10-24T09:00:00Z',
					last_seen: '2026-10-26T08:58:00Z',
				},
				NOW,
			),
		).toBe('added Oct 24 · last opened 2 minutes ago');
		expect(describePhone({ id: 'p2', name: 'Phone', created: '2026-10-02T09:00:00Z' }, NOW)).toBe(
			'added Oct 2 · not opened yet',
		);
	});

	it.each([
		['2026-10-26T08:59:30Z', 'just now'],
		['2026-10-26T08:59:00Z', '1 minute ago'],
		['2026-10-26T06:00:00Z', '3 hours ago'],
		['2026-10-23T09:00:00Z', '3 days ago'],
	])('%s → %s', (at, said) => expect(describeSince(at, NOW)).toBe(said));

	it('names a phone by its device once crew’s default name says nothing', () => {
		expect(readPhoneName({ id: 'p1', name: 'Phone', created: '', device: 'iPhone' })).toBe(
			'iPhone',
		);
		expect(readPhoneName({ id: 'p1', name: 'Work phone', created: '', device: 'iPhone' })).toBe(
			'Work phone',
		);
	});

	it('green while opened within the hour', () => {
		expect(
			isRecentlyOpened({ id: 'p', name: 'P', created: '', last_seen: '2026-10-26T08:30:00Z' }, NOW),
		).toBe(true);
		expect(isRecentlyOpened({ id: 'p', name: 'P', created: '' }, NOW)).toBe(false);
	});
});

describe('isPhoneCode', () => {
	it('takes crew’s phones add document only', () => {
		expect(
			isPhoneCode({
				id: 'p',
				name: 'Phone',
				link: 'https://x/phone/k',
				address: 'x',
				via: 'proxy',
			}),
		).toBe(true);
		expect(isPhoneCode({ link: 'https://x/phone/k', address: 'x', via: 'smoke' })).toBe(false);
		expect(isPhoneCode(null)).toBe(false);
	});
});

describe('listTailscaleSteps', () => {
	const done = (status: TailscaleStatus) =>
		listTailscaleSteps(status).map((step) => `${step.key}:${step.isDone ? '✓' : '○'}`);

	it('ticks itself from crew’s read', () => {
		expect(done(SIGNED_IN)).toEqual(['mac:✓', 'https:○', 'serve:○']);
		expect(done({ ...SIGNED_IN, https: true })).toEqual(['mac:✓', 'https:✓', 'serve:○']);
		expect(done({ ...SIGNED_IN, https: true, serving: true })).toEqual([
			'mac:✓',
			'https:✓',
			'serve:✓',
		]);
	});

	it('says who is signed in, and what the link will be', () => {
		const [mac, , serve] = listTailscaleSteps(SIGNED_IN);

		expect(mac?.detail).toBe('running · signed in as dev@ · studio-mac');
		expect(serve?.detail).toBe('makes https://studio-mac.tail4f2a.ts.net');
	});

	it('says what is missing on this Mac', () => {
		expect(listTailscaleSteps({ ...SIGNED_IN, installed: false })[0]?.detail).toContain(
			'not installed',
		);
		expect(listTailscaleSteps({ ...SIGNED_IN, signed_in: false })[0]?.isDone).toBe(false);
	});
});
