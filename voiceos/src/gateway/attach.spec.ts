import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type Attachment } from '../shared/protocol.js';
import { storeAttachment } from '../sessions/attachments.js';
import { Store } from '../state/store.js';
import { attachFileTo, handleAttachRequest, type AttachFile } from './attach.js';

configureLog({ quiet: true });

const ORIGIN = 'http://localhost:4000';
const REF = 'store-front/main';
const ATTACHED: Attachment = {
	id: '0123456789abcdef/a.txt',
	name: 'a.txt',
	kind: 'file',
	bytes: 3,
};

interface Call {
	ref: string;
	name: string;
	mediaType: string;
	bytes: number;
}

const recordingAttach = (calls: Call[]): AttachFile => {
	return ({ ref, name, mediaType, bytes }) => {
		calls.push({ ref, name, mediaType, bytes: bytes.length });

		return { ok: true, attachment: ATTACHED };
	};
};

interface PostParams {
	body?: BodyInit;
	headers?: Record<string, string>;
	ref?: string;
	method?: string;
	isAuthorized?: boolean;
	attachFile?: AttachFile;
}

const post = ({
	body = 'abc',
	headers = {},
	ref = REF,
	method = 'POST',
	isAuthorized = true,
	attachFile = recordingAttach([]),
}: PostParams = {}) =>
	handleAttachRequest({
		request: new Request(`${ORIGIN}/api/attach?${new URLSearchParams({ ref })}`, {
			method,
			headers: { origin: ORIGIN, ...headers },
			...(method === 'POST' ? { body } : {}),
		}),
		origins: [ORIGIN],
		isAuthorized,
		attachFile,
	});

describe('POST /api/attach', () => {
	it('the body is the file: its name and type from the headers, the attachment answered', async () => {
		const calls: Call[] = [];
		const response = await post({
			headers: {
				'content-type': 'Image/PNG; charset=binary',
				'x-file-name': encodeURIComponent('résumé, v2.png'),
			},
			attachFile: recordingAttach(calls),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ attachment: ATTACHED });
		expect(calls).toEqual([{ ref: REF, name: 'résumé, v2.png', mediaType: 'image/png', bytes: 3 }]);
	});

	it.each<[string, PostParams, number]>([
		['not signed in', { isAuthorized: false }, 401],
		['another origin', { headers: { origin: 'http://evil.example' } }, 403],
		['not a POST', { method: 'GET' }, 405],
		['no session named', { ref: '' }, 400],
		[
			'said to be over 20 MB',
			{ headers: { 'content-length': String(MAX_ATTACHMENT_BYTES + 1) } },
			413,
		],
	])('%s → %d, nothing stored', async (_, params, status) => {
		const calls: Call[] = [];

		expect((await post({ ...params, attachFile: recordingAttach(calls) })).status).toBe(status);
		expect(calls).toEqual([]);
	});

	it('over 20 MB sent with no length given: stopped once past the cap', async () => {
		const calls: Call[] = [];
		const piece = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > MAX_ATTACHMENT_BYTES + piece.length) {
					controller.close();

					return;
				}

				sent += piece.length;
				controller.enqueue(piece);
			},
		});
		const response = await post({ body, attachFile: recordingAttach(calls) });

		expect(response.status).toBe(413);
		expect(calls).toEqual([]);
	});
});

describe('attachFileTo', () => {
	let root = '';

	afterEach(() => root && rmSync(root, { recursive: true, force: true }));

	const createAttach = () => {
		root = mkdtempSync(join(tmpdir(), 'voiceos-attach-'));
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [{ ref: REF, label: REF, branch: '', cwd: '/w', dirs: [], isPinned: false }],
		});
		const attach = attachFileTo({
			readState: () => store.state,
			dispatch: (observation) => store.dispatch(observation),
			store: (file) =>
				storeAttachment({ ...file, dir: join(root, 'attachments'), mediaDir: join(root, 'media') }),
		});
		const file = (text: string) => ({
			bytes: Buffer.from(text),
			name: `${text}.txt`,
			mediaType: 'text/plain',
		});

		return { store, attach, file };
	};

	it('stored, then a chip on the session every tab sees', () => {
		const { store, attach, file } = createAttach();
		const outcome = attach({ ref: REF, ...file('one') });

		expect(outcome.ok).toBe(true);
		expect(store.state.attachments[REF]).toEqual([outcome.ok ? outcome.attachment : ATTACHED]);
	});

	it('an unknown session → 404; a session with 10 waiting → 409; an empty file → 413', () => {
		const { attach, file } = createAttach();

		expect(attach({ ref: 'nowhere/main', ...file('x') })).toMatchObject({ ok: false, status: 404 });
		expect(attach({ ref: REF, bytes: Buffer.alloc(0), name: 'e', mediaType: '' })).toMatchObject({
			ok: false,
			status: 413,
		});

		for (let index = 0; index < MAX_ATTACHMENTS; index++) {
			attach({ ref: REF, ...file(`f${index}`) });
		}

		expect(attach({ ref: REF, ...file('one more') })).toMatchObject({ ok: false, status: 409 });
	});
});
