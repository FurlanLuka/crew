import { describe, expect, it } from 'bun:test';
import { FRAME } from './gate.js';
import { runtimeLibraryName, VAD_CONTEXT, withContext } from './models.js';

const frameOf = (value: number): Float32Array =>
	Float32Array.from({ length: FRAME }, (_, index) => value + index / FRAME);

describe('withContext', () => {
	it('the first frame → zeros before it', () => {
		const frame = frameOf(1);
		const { input } = withContext(new Float32Array(VAD_CONTEXT), frame);

		expect(input.length).toBe(VAD_CONTEXT + FRAME);
		expect([...input.slice(0, VAD_CONTEXT)].every((sample) => sample === 0)).toBe(true);
		expect([...input.slice(VAD_CONTEXT)]).toEqual([...frame]);
	});

	it('the next frame → the previous frame’s last 64 samples before it', () => {
		const first = withContext(new Float32Array(VAD_CONTEXT), frameOf(1));
		const second = withContext(first.tail, frameOf(2));

		expect([...second.input.slice(0, VAD_CONTEXT)]).toEqual([...frameOf(1).slice(-VAD_CONTEXT)]);
	});
});

describe('runtimeLibraryName', () => {
	it('the library name the addon links against, per platform', () => {
		expect(runtimeLibraryName('darwin')).toBe('libonnxruntime.1.dylib');
		expect(runtimeLibraryName('linux')).toBe('libonnxruntime.so.1');
	});
});
