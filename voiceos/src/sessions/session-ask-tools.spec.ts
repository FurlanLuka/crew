import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Observation } from '../shared/protocol.js';
import { PEER_ALLOWED_TOOLS, SessionAskBridge } from './session-ask-tools.js';

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const setup = (deadlineMs?: number) => {
	const home = mkdtempSync(join(tmpdir(), 'peer-tools-'));
	const cwd = join(home, 'checkout');
	const emitted: Observation[] = [];

	made.push(home);
	mkdirSync(cwd);
	writeFileSync(join(cwd, 'schema.sql'), 'create table orders();');
	writeFileSync(join(cwd, '.env'), 'SECRET=1');

	const bridge = new SessionAskBridge({
		emit: (observation) => emitted.push(observation),
		attachmentsDir: join(home, 'attachments'),
		mediaDir: join(home, 'media'),
		...(deadlineMs ? { deadlineMs } : {}),
	});

	// The real in-process server, called the way Claude Code calls it.
	const connect = async () => {
		const server = bridge.serverFor('store-front/main', { cwd, dirs: [] });
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'test', version: '1' });

		await server.instance.connect(serverSide);
		await client.connect(clientSide);

		return client;
	};

	return { bridge, emitted, connect };
};

const textOf = (result: unknown): string =>
	((result as { content: { text: string }[] }).content[0]?.text ?? '') as string;

describe('the session tools', () => {
	it('three tools, the names the worker allows without asking', async () => {
		const client = await setup().connect();
		const { tools } = await client.listTools();

		expect(tools.map((tool) => `mcp__voiceos__${tool.name}`)).toEqual(PEER_ALLOWED_TOOLS);
	});

	it('ask_session → reported to the main, and returns the answer it sends back', async () => {
		const { bridge, emitted, connect } = setup();
		const client = await connect();
		const call = client.callTool({
			name: 'ask_session',
			arguments: { session: 'checkout', question: 'Which retry limit?' },
		});

		await Bun.sleep(5);
		const [requested] = emitted;

		expect(requested).toMatchObject({
			type: 'session_ask_requested',
			ref: 'store-front/main',
			kind: 'ask',
			session: 'checkout',
			text: 'Which retry limit?',
			files: [],
		});
		expect(
			bridge.answer(requested?.type === 'session_ask_requested' ? requested.id : '', {
				text: 'Five tries.',
				files: [],
			}),
		).toBe(true);
		expect(textOf(await call)).toBe('Five tries.');
	});

	it('tell_session with a file → stored by content and sent with it; the answer lists local paths', async () => {
		const { bridge, emitted, connect } = setup();
		const client = await connect();
		const call = client.callTool({
			name: 'tell_session',
			arguments: { session: 'checkout', message: 'schema attached', files: ['schema.sql'] },
		});

		await Bun.sleep(5);
		const requested = emitted[0];
		const files = requested?.type === 'session_ask_requested' ? requested.files : [];

		expect(files).toMatchObject([{ name: 'schema.sql', kind: 'file', bytes: 22 }]);
		bridge.answer(requested?.type === 'session_ask_requested' ? requested.id : '', {
			text: 'Queued.',
			files,
		});
		expect(textOf(await call)).toMatch(
			/^Queued\.\n\nFiles \(on this machine, read them with Read\):\n- .*schema\.sql$/,
		);
	});

	it('a secret or outside file → refused here, nothing reported', async () => {
		const { emitted, connect } = setup();
		const client = await connect();
		const result = await client.callTool({
			name: 'tell_session',
			arguments: { session: 'checkout', message: 'm', files: ['.env'] },
		});

		expect(textOf(result)).toBe('Not sent: .env looks like a secret; use request_secret.');
		expect(emitted).toEqual([]);
	});

	it('no answer in time → a sentence, and a later answer finds nothing waiting', async () => {
		const { bridge, emitted, connect } = setup(20);
		const client = await connect();
		const result = await client.callTool({
			name: 'ask_session',
			arguments: { session: 'checkout', question: 'q' },
		});
		const id = emitted[0]?.type === 'session_ask_requested' ? emitted[0].id : '';

		expect(textOf(result)).toBe(
			'No answer from checkout within 3 minutes. Go on without it, or tell the developer.',
		);
		expect(bridge.answer(id, { text: 'late', files: [] })).toBe(false);
	});

	it('the session stops → its waiting calls end at once', async () => {
		const { bridge, connect } = setup();
		const client = await connect();
		const call = client.callTool({
			name: 'ask_session',
			arguments: { session: 'c', question: 'q' },
		});

		await Bun.sleep(5);
		expect(bridge.settleRef('store-front/main', 'The session ended.')).toBe(1);
		expect(textOf(await call)).toBe('The session ended.');
		expect(bridge.countPending()).toBe(0);
	});
});
