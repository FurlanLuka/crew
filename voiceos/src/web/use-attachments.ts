// Files the developer hands the session on screen: pasted, dropped anywhere on the page, or picked
// with the paperclip. Each is uploaded on its own; once the server has it, it is a chip in the state
// (every tab shows it) and leaves this hook's list. What is still uploading, or was refused, lives
// only here.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	TOO_BIG_REASON,
	type Attachment,
	type ClientMessage,
	type State,
} from '../shared/protocol.js';

export interface Upload {
	key: string;
	name: string;
	// Set when it did not go: said on its chip until dismissed.
	error: string | null;
}

export interface Attachments {
	ref: string | null;
	waiting: Attachment[];
	uploads: Upload[];
	isUploading: boolean;
	// A line for an attach that had nowhere to go.
	note: string | null;
	attach: (files: File[]) => void;
	remove: (id: string) => void;
	dismiss: (key: string) => void;
}

interface UseAttachmentsParams {
	state: State;
	// The session the files are for; null when none is on screen.
	sessionRef: string | null;
	send: (message: ClientMessage) => void;
}

// What the box sends when it holds only files: the files are the message.
export const ATTACHED_ONLY_TEXT = '(attached)';

const NO_SESSION_NOTE = 'Open a session to attach files.';
const NOTE_MS = 4000;

const readError = async (response: Response): Promise<string> => {
	try {
		const body = (await response.json()) as { error?: unknown };

		return typeof body.error === 'string' ? body.error : `failed (${response.status})`;
	} catch {
		return `failed (${response.status})`;
	}
};

const upload = async (ref: string, file: File): Promise<string | null> => {
	try {
		const response = await fetch(`/api/attach?${new URLSearchParams({ ref }).toString()}`, {
			method: 'POST',
			headers: {
				'content-type': file.type || 'application/octet-stream',
				// A header carries Latin-1 only; the server decodes it.
				'x-file-name': encodeURIComponent(file.name || 'pasted'),
			},
			body: file,
		});

		return response.ok ? null : await readError(response);
	} catch {
		return 'could not reach Voice OS';
	}
};

const readFiles = (data: DataTransfer | null): File[] => (data ? [...data.files] : []);

const hasFiles = (data: DataTransfer | null): boolean =>
	Boolean(data && [...data.types].includes('Files'));

let uploadCounter = 0;

export const useAttachments = ({ state, sessionRef, send }: UseAttachmentsParams): Attachments => {
	const [uploads, setUploads] = useState<Upload[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const waiting = sessionRef ? (state.attachments[sessionRef] ?? []) : [];
	// Read by the page listeners, which are added once.
	// A refused chip takes no room: it never reaches the session.
	const room = MAX_ATTACHMENTS - waiting.length - uploads.filter((upload) => !upload.error).length;
	const latest = useRef({ sessionRef, room });

	latest.current = { sessionRef, room };

	useEffect(() => {
		if (!note) {
			return;
		}

		const timer = setTimeout(() => setNote(null), NOTE_MS);

		return () => clearTimeout(timer);
	}, [note]);

	// Another session on screen: what was refused there is no longer this one's.
	useEffect(() => setUploads((current) => current.filter((item) => !item.error)), [sessionRef]);

	const attach = useCallback((files: File[]) => {
		const { sessionRef: ref, room } = latest.current;

		if (files.length === 0) {
			return;
		}

		if (!ref) {
			setNote(NO_SESSION_NOTE);

			return;
		}

		// Counted as they are accepted: a refused file in the same drop takes no room either.
		let accepted = 0;

		for (const file of files) {
			const key = `u${++uploadCounter}`;
			const refusal =
				accepted >= room
					? `${MAX_ATTACHMENTS} files at most`
					: file.size > MAX_ATTACHMENT_BYTES
						? TOO_BIG_REASON
						: file.size === 0
							? 'empty file'
							: null;

			setUploads((current) => [...current, { key, name: file.name || 'pasted', error: refusal }]);

			if (refusal) {
				continue;
			}

			accepted++;
			void upload(ref, file).then((error) =>
				setUploads((current) =>
					error
						? current.map((item) => (item.key === key ? { ...item, error } : item))
						: current.filter((item) => item.key !== key),
				),
			);
		}
	}, []);

	// Paste and drop anywhere on the page reach this session (the paperclip always does).
	useEffect(() => {
		const handlePaste = (event: ClipboardEvent) => {
			const files = readFiles(event.clipboardData);

			// Plain text pastes as always.
			if (files.length > 0) {
				event.preventDefault();
				attach(files);
			}
		};

		// Without this, a file dropped on the box only puts its path there, and one dropped elsewhere
		// opens in the tab.
		const handleDragOver = (event: DragEvent) => {
			if (hasFiles(event.dataTransfer)) {
				event.preventDefault();
			}
		};

		const handleDrop = (event: DragEvent) => {
			if (hasFiles(event.dataTransfer)) {
				event.preventDefault();
				attach(readFiles(event.dataTransfer));
			}
		};

		window.addEventListener('paste', handlePaste);
		window.addEventListener('dragover', handleDragOver);
		window.addEventListener('drop', handleDrop);

		return () => {
			window.removeEventListener('paste', handlePaste);
			window.removeEventListener('dragover', handleDragOver);
			window.removeEventListener('drop', handleDrop);
		};
	}, [attach]);

	return {
		ref: sessionRef,
		waiting,
		uploads,
		isUploading: uploads.some((item) => !item.error),
		note,
		attach,
		remove: (id) => {
			if (sessionRef) {
				send({ type: 'action', action: { type: 'attachment_removed', ref: sessionRef, id } });
			}
		},
		dismiss: (key) => setUploads((current) => current.filter((item) => item.key !== key)),
	};
};
