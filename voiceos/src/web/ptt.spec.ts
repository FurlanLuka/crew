import { describe, expect, it } from 'bun:test';
import { PttBuffer } from './ptt.js';

const createChunk = (id: number, samples = 100) => {
	// Most tests run at 1 kHz, which keeps the numbers readable: 100 samples = 100 ms.
	return new Int16Array(samples).fill(id);
};

const readIds = (chunks: Int16Array[]) => chunks.map((chunk) => chunk[0]);

describe('PttBuffer', () => {
	it('press → the last 300 ms before it is sent first', () => {
		const buffer = new PttBuffer(1000);

		for (let i = 1; i <= 6; i++) {
			buffer.push(createChunk(i));
		}

		const { preRoll, shouldStopFirst } = buffer.press();
		expect(readIds(preRoll)).toEqual([4, 5, 6]);
		expect(shouldStopFirst).toBe(false);
	});

	it('idle → nothing sent', () => {
		const buffer = new PttBuffer(1000);
		expect(buffer.push(createChunk(1))).toEqual({ send: [], shouldStop: false });
	});

	it('talking → every chunk sent as it comes', () => {
		const buffer = new PttBuffer(1000);
		buffer.press();
		expect(readIds(buffer.push(createChunk(7)).send)).toEqual([7]);
	});

	it('release → 250 ms more is sent, then stop, then idle again', () => {
		const buffer = new PttBuffer(1000);
		buffer.press();
		buffer.release();
		expect(buffer.push(createChunk(1))).toMatchObject({ shouldStop: false });
		expect(buffer.push(createChunk(2))).toMatchObject({ shouldStop: false });
		const last = buffer.push(createChunk(3));
		expect(readIds(last.send)).toEqual([3]);
		expect(last.shouldStop).toBe(true);
		expect(buffer.isTalking).toBe(false);
		expect(buffer.push(createChunk(4))).toEqual({ send: [], shouldStop: false });
	});

	it('press during the tail → the previous utterance is ended first and gets no pre-roll of the next', () => {
		const buffer = new PttBuffer(1000);
		buffer.press();
		buffer.release();
		buffer.push(createChunk(1));
		const { preRoll, shouldStopFirst } = buffer.press();
		expect(shouldStopFirst).toBe(true);
		expect(preRoll).toEqual([]);
		expect(buffer.push(createChunk(2))).toMatchObject({ shouldStop: false });
	});

	it('release without a press → ignored', () => {
		const buffer = new PttBuffer(1000);
		buffer.release();
		expect(buffer.isTalking).toBe(false);
	});

	it('48 kHz → the pre-roll is still about 300 ms', () => {
		const buffer = new PttBuffer(48_000);

		for (let i = 1; i <= 10; i++) {
			buffer.push(createChunk(i, 4800));
		}

		const samples = buffer.press().preRoll.reduce((total, chunk) => total + chunk.length, 0);
		expect(samples).toBeGreaterThanOrEqual(14_400);
		expect(samples).toBeLessThan(14_400 + 4800);
	});

	it('press right after speech played → no pre-roll, it would carry that speech', () => {
		const buffer = new PttBuffer(1000);

		for (let i = 1; i <= 4; i++) {
			buffer.push(createChunk(i));
		}

		expect(buffer.press({ withPreRoll: false }).preRoll).toEqual([]);
		expect(readIds(buffer.push(createChunk(5)).send)).toEqual([5]);
	});

	it('listening → every chunk sent, no pre-roll kept; off → idle again', () => {
		const buffer = new PttBuffer(1000);

		for (let i = 1; i <= 3; i++) {
			buffer.push(createChunk(i));
		}

		expect(buffer.listen()).toEqual({ shouldStopFirst: false });
		expect(readIds(buffer.push(createChunk(4)).send)).toEqual([4]);
		expect(readIds(buffer.push(createChunk(5)).send)).toEqual([5]);
		buffer.unlisten();
		expect(buffer.push(createChunk(6)).send).toEqual([]);
		expect(readIds(buffer.press().preRoll)).toEqual([6]);
	});

	it('a press while listening → ignored: no pre-roll, the stream stays hands-free', () => {
		const buffer = new PttBuffer(1000);
		buffer.listen();
		expect(buffer.press()).toEqual({ preRoll: [], shouldStopFirst: false });
		buffer.release();
		expect(buffer.push(createChunk(1))).toEqual({ send: [createChunk(1)], shouldStop: false });
	});

	it('hands-free on during a press tail → that press ends first', () => {
		const buffer = new PttBuffer(1000);
		buffer.press();
		buffer.release();
		expect(buffer.listen()).toEqual({ shouldStopFirst: true });
	});
});
