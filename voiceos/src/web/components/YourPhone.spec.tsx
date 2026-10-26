import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PhoneCode, TailscaleStatus } from '../your-phone.js';
import { Pairing, PhonesList, TailscaleCard } from './YourPhone.js';

const noop = () => undefined;

const PROXY_CODE: PhoneCode = {
	id: 'p3fa9c1',
	name: 'Phone',
	link: 'https://voice--os.192.168.1.20.nip.io/phone/KEY0123',
	address: 'voice--os.192.168.1.20.nip.io',
	via: 'proxy',
};

const STATUS: TailscaleStatus = {
	installed: true,
	running: true,
	signed_in: true,
	user: 'dev@',
	host: 'studio-mac.tail4f2a.ts.net',
	https: false,
	serving: false,
	url: '',
};

const pairing = (code: PhoneCode | null) =>
	renderToStaticMarkup(
		<Pairing code={code} isBusy={false} trustLine={null} onNewCode={noop} onTrust={noop} />,
	);

const card = (status: TailscaleStatus) =>
	renderToStaticMarkup(
		<TailscaleCard status={status} isBusy={false} onServe={noop} onStop={noop} />,
	);

describe('Your phone', () => {
	it('before a code: the steps and New code, no QR and no address', () => {
		const html = pairing(null);

		expect(html).toContain('No code yet');
		expect(html).toContain('New code');
		expect(html).not.toContain('<svg');
		expect(html).not.toContain('Reached at');
	});

	it('a code through the proxy: its QR, where it is reached, and the certificate to trust', () => {
		const html = pairing(PROXY_CODE);

		expect(html).toContain('aria-label="QR code of the phone&#x27;s link"');
		expect(html).toContain('Reached at <b>voice--os.192.168.1.20.nip.io</b>');
		expect(html).toContain('crew&#x27;s proxy, on this network');
		expect(html).toContain('Trust crew&#x27;s certificate on the phone…');
	});

	it('a code on Tailscale needs no certificate trusted by hand', () => {
		const html = pairing({
			...PROXY_CODE,
			via: 'tailscale',
			address: 'studio-mac.tail4f2a.ts.net',
		});

		expect(html).toContain('Tailscale, only your devices');
		expect(html).not.toContain('Trust crew');
	});

	it('Tailscale, HTTPS off: the checklist with the way to turn it on, Set it up held back', () => {
		const html = card(STATUS);

		expect(html).toContain('Recommended');
		expect(html).toContain('signed in as dev@');
		expect(html).toContain('href="https://login.tailscale.com/admin/dns"');
		expect(html).toMatch(/data-step="serve".*disabled=""/);
		expect(html).toContain('On your phone, install Tailscale and sign in with the same account.');
	});

	it('Tailscale, HTTPS on: Set it up can run', () => {
		expect(card({ ...STATUS, https: true })).not.toMatch(/data-step="serve".*disabled=""/);
	});

	it('serving: On Tailscale, with Stop serving', () => {
		const html = card({
			...STATUS,
			https: true,
			serving: true,
			url: 'https://studio-mac.tail4f2a.ts.net',
		});

		expect(html).toContain('On Tailscale');
		expect(html).toContain('Stop serving');
		expect(html).not.toContain('Set it up');
	});

	it('the phones, each with Revoke', () => {
		const html = renderToStaticMarkup(
			<PhonesList
				phones={[
					{
						id: 'p1',
						name: 'Phone',
						device: 'iPhone',
						created: '2026-10-24T09:00:00Z',
						last_seen: '2026-10-26T08:58:00Z',
					},
				]}
				now={Date.parse('2026-10-26T09:00:00Z')}
				onRevoke={noop}
			/>,
		);

		expect(html).toContain('<b>iPhone</b>');
		expect(html).toContain('added Oct 24 · last opened 2 minutes ago');
		expect(html).toContain('Revoke');
	});
});
