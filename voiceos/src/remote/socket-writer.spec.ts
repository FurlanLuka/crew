import { describe, expect, it } from 'bun:test';
import { createSocketWriter } from './socket-writer.js';

// A socket that takes at most `room` bytes per write, and remembers what it took.
const createSocket = (room: number[]) => {
	const taken: number[] = [];

	return {
		taken,
		socket: {
			write: (bytes: Uint8Array) => {
				const size = Math.min(room.shift() ?? bytes.length, bytes.length);

				taken.push(...bytes.subarray(0, Math.max(size, 0)));

				return size;
			},
		},
	};
};

const bytes = (...values: number[]) => new Uint8Array(values);

describe('createSocketWriter', () => {
	it('all taken at once → nothing waits', () => {
		const { socket, taken } = createSocket([]);
		const writer = createSocketWriter(socket);

		writer.write(bytes(1, 2, 3));

		expect(taken).toEqual([1, 2, 3]);
		expect(writer.waiting).toBe(0);
	});

	it('a partial write → the rest waits, and later writes queue behind it in order', () => {
		const { socket, taken } = createSocket([2]);
		const writer = createSocketWriter(socket);

		writer.write(bytes(1, 2, 3, 4));
		writer.write(bytes(5, 6));

		expect(taken).toEqual([1, 2]);
		expect(writer.waiting).toBe(4);

		writer.drain();

		expect(taken).toEqual([1, 2, 3, 4, 5, 6]);
		expect(writer.waiting).toBe(0);
	});

	it('several drains, each taking a little → all of it, in order', () => {
		const { socket, taken } = createSocket([1, 1, 1]);
		const writer = createSocketWriter(socket);

		writer.write(bytes(1, 2, 3, 4, 5));
		writer.drain();
		writer.drain();
		writer.drain();

		expect(taken).toEqual([1, 2, 3, 4, 5]);
	});

	it('a write that fails (-1) → the whole chunk waits', () => {
		const { socket, taken } = createSocket([-1]);
		const writer = createSocketWriter(socket);

		writer.write(bytes(7, 8));

		expect(taken).toEqual([]);
		expect(writer.waiting).toBe(2);

		writer.drain();

		expect(taken).toEqual([7, 8]);
	});
});
