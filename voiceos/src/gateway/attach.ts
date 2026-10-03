// POST /api/attach?ref= — a file the developer pasted, dropped or picked on a session's page. The
// body is the file itself (not a form): its type in content-type, its name in x-file-name.
import {
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	type Attachment,
	type Observation,
	type State,
} from '../shared/protocol.js';
import type { StoredAttachment } from '../sessions/attachments.js';
import { createLogger } from '../log.js';
import { checkRequest } from './auth.js';

const log = createLogger('attach');

export interface AttachFileParams {
	ref: string;
	bytes: Buffer;
	name: string;
	mediaType: string;
}

export type AttachOutcome =
	| { ok: true; attachment: Attachment }
	| { ok: false; status: number; reason: string };

export type AttachFile = (params: AttachFileParams) => AttachOutcome;

export interface AttachFileToParams {
	readState: () => State;
	dispatch: (observation: Observation) => void;
	store: (params: Omit<AttachFileParams, 'ref'>) => StoredAttachment;
}

// The server's side of an upload: a session it knows, room for one more, then stored and shown as a
// chip on every tab.
export const attachFileTo =
	({ readState, dispatch, store }: AttachFileToParams): AttachFile =>
	({ ref, ...file }) => {
		const state = readState();

		if (!state.sessions[ref]) {
			return { ok: false, status: 404, reason: 'no such session' };
		}

		if ((state.attachments[ref]?.length ?? 0) >= MAX_ATTACHMENTS) {
			return { ok: false, status: 409, reason: `${MAX_ATTACHMENTS} files already waiting` };
		}

		const stored = store(file);

		if (!stored.ok) {
			return { ok: false, status: 413, reason: stored.reason };
		}

		dispatch({ type: 'attachment_added', ref, attachment: stored.attachment });

		return stored;
	};

export interface HandleAttachRequestParams {
	request: Request;
	origins: string[];
	isAuthorized: boolean;
	attachFile: AttachFile;
}

const refuse = (status: number, reason: string): Response => {
	log.warn('attach refused', { status, reason });

	return Response.json({ error: reason }, { status });
};

// Read until the cap, whatever Content-Length said (a chunked body says nothing): a page cannot
// make the server hold more than one file's worth.
const readCapped = async (request: Request, cap: number): Promise<Buffer | null> => {
	if (!request.body) {
		return Buffer.alloc(0);
	}

	const chunks: Uint8Array[] = [];
	let total = 0;

	for await (const chunk of request.body) {
		total += chunk.byteLength;

		if (total > cap) {
			return null;
		}

		chunks.push(chunk);
	}

	return Buffer.concat(chunks);
};

const readName = (request: Request): string => {
	const raw = request.headers.get('x-file-name') ?? '';

	// The page encodes it: a header carries only Latin-1, a file name can be anything.
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
};

export const handleAttachRequest = async ({
	request,
	origins,
	isAuthorized,
	attachFile,
}: HandleAttachRequestParams): Promise<Response> => {
	if (request.method !== 'POST') {
		return refuse(405, 'POST only');
	}

	const refusal = checkRequest({ origin: request.headers.get('origin'), origins, isAuthorized });

	if (refusal) {
		return refuse(refusal.status, refusal.text);
	}

	const ref = new URL(request.url).searchParams.get('ref') ?? '';

	if (!ref) {
		return refuse(400, 'expected ?ref=');
	}

	if (Number(request.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) {
		return refuse(413, 'over 20 MB');
	}

	const bytes = await readCapped(request, MAX_ATTACHMENT_BYTES);

	if (!bytes) {
		return refuse(413, 'over 20 MB');
	}

	const outcome = attachFile({
		ref,
		bytes,
		name: readName(request),
		mediaType:
			(request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
	});

	if (!outcome.ok) {
		return refuse(outcome.status, outcome.reason);
	}

	log.info('attached', { ref, kind: outcome.attachment.kind, bytes: outcome.attachment.bytes });

	return Response.json({ attachment: outcome.attachment });
};
