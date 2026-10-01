// An in-memory SSH link between a main's RemoteLink and a RemoteHost: frames arrive a tick later, in
// order, re-cut into chunks of seeded random size (a line split anywhere, several lines in one read),
// and the link can be cut after any frame or on demand — cleanly, or leaving the host's end half open.

import type { OpenTransport } from '../../src/remote/link.js';
import type { RemoteHost } from '../../src/remote/host.js';
import { createLineDecoder } from '../../src/remote/protocol.js';

export interface NetworkOptions {
	// The frame (counted from 1, both ways) after which the link is cut once.
	cutAfter?: number;
	// The host is never told the cut link closed, as with a dropped Wi-Fi: its end stays attached.
	isHalfOpen?: boolean;
	seed?: number;
	// Called as the cut happens.
	onCut?: () => void;
}

// A small deterministic generator: the same seed chunks the same way.
const createRandom = (seed: number) => {
	let state = seed || 1;

	return (): number => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

		return state / 2_147_483_648;
	};
};

const chunk = (text: string, random: () => number): string[] => {
	const pieces: string[] = [];
	let rest = text;

	while (rest.length > 0) {
		const size = 1 + Math.floor(random() * Math.min(rest.length, 64));

		pieces.push(rest.slice(0, size));
		rest = rest.slice(size);
	}

	return pieces;
};

const describeFrame = (direction: string, text: string): string =>
	`${direction} ${text.match(/"type":"([a-z_]+)"/)?.[1] ?? '?'}${text.includes('"input":') ? `:${text.match(/"input":\{"type":"([a-z_]+)"/)?.[1] ?? '?'}` : ''}`;

export const createNetwork = (
	host: RemoteHost,
	{ cutAfter = Infinity, isHalfOpen = false, seed = 7, onCut }: NetworkOptions = {},
) => {
	let hasCut = false;
	let cuts = 0;
	const frames: string[] = [];
	const random = createRandom(seed);
	// The links up now, each with the way to cut it.
	const live = new Set<() => void>();

	const open: OpenTransport = (_host, handlers) => {
		let isAlive = true;
		// A cut loses what is in flight; a clean close still delivers what was sent before it.
		let isLost = false;
		const hostEnd = host.connect({
			write: (text) => carry('←', text, (piece) => handlers.onData(piece)),
			close: () => end(),
		});
		const toHost = createLineDecoder((line) => hostEnd.receive(line));

		const end = (): void => {
			if (!isAlive) {
				return;
			}

			isAlive = false;
			live.delete(cutNow);
			setTimeout(() => handlers.onExit(255, ''), 0);
		};

		const cutNow = (): void => {
			cuts++;
			onCut?.();

			if (!isHalfOpen) {
				setTimeout(() => hostEnd.closed(), 0);
			}

			isLost = true;
			end();
		};

		live.add(cutNow);

		// A frame counts when sent; the one at the cut is lost with the link.
		const carry = (direction: string, text: string, deliver: (piece: string) => void): void => {
			if (!isAlive) {
				return;
			}

			frames.push(describeFrame(direction, text));

			if (!hasCut && frames.length >= cutAfter) {
				hasCut = true;
				cutNow();

				return;
			}

			for (const piece of chunk(text, random)) {
				setTimeout(() => {
					if (!isLost) {
						deliver(piece);
					}
				}, 0);
			}
		};

		return {
			write: (text) => carry('→', text, toHost),
			close: () => {
				if (!isHalfOpen) {
					setTimeout(() => hostEnd.closed(), 0);
				}

				end();
			},
		};
	};

	return {
		open,
		frames: () => frames.length,
		// Each frame's direction and type, for a failure message.
		log: () => frames,
		cuts: () => cuts,
		// Cuts the links up now, losing what is in flight; any number of times.
		cut: () => {
			for (const cutNow of [...live]) {
				cutNow();
			}
		},
	};
};

export const until = async (
	isDone: () => boolean,
	label: string,
	timeoutMs = 3_000,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;

	while (!isDone()) {
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}

		await new Promise((resolve) => setTimeout(resolve, 2));
	}
};
