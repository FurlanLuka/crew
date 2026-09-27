import { SETUP_REF } from '../sessions/setup-session.js';
import { toSpokenPart } from '../shared/spoken.js';

export interface SonioxToken {
	text: string;
	is_final: boolean;
}

export interface TranscriptPushResult {
	// The batch carried <fin>, so every token before it is final.
	isFinished: boolean;
	// The turns the batch closed, in order (segment mode only).
	segments: string[];
}

interface TranscriptAccumulatorOptions {
	isSegmented?: boolean;
}

const CONTROL_TOKENS = new Set(['<end>', '<fin>']);
const MAX_CONTEXT_TERMS = 100;

export class TranscriptAccumulator {
	private finals = '';
	private tail = '';

	constructor(private options: TranscriptAccumulatorOptions = {}) {}

	push(tokens: SonioxToken[]): TranscriptPushResult {
		// Soniox sends finals once; each response's non-final tail replaces the previous one.
		let tail = '';
		const hasFin = tokens.some((token) => token.text === '<fin>');
		const segments: string[] = [];

		for (const token of tokens) {
			// In segment mode each <end> closes one turn, every token before it final.
			if (token.text === '<end>' && this.options.isSegmented) {
				const segment = this.finalText;

				if (segment) {
					segments.push(segment);
				}

				this.finals = '';
			}

			if (CONTROL_TOKENS.has(token.text)) {
				continue;
			}

			if (token.is_final) {
				this.finals += token.text;
			} else {
				tail += token.text;
			}
		}

		this.tail = tail;

		return { isFinished: hasFin, segments };
	}

	get text(): string {
		return (this.finals + this.tail).replace(/\s+/g, ' ').trim();
	}

	get finalText(): string {
		return this.finals.replace(/\s+/g, ' ').trim();
	}
}

export interface BuildContextTermsParams {
	refs: string[];
	topics: string[];
}

export const buildContextTerms = ({ refs, topics }: BuildContextTermsParams): string[] => {
	// Each term goes in as it is said: one spelled but never said biases toward mishearing it.
	const terms = new Set<string>(['Voice OS']);

	for (const ref of refs) {
		if (ref === SETUP_REF) {
			continue;
		}

		const parts = ref.split('/').filter(Boolean).map(toSpokenPart);
		terms.add(parts.join(' '));

		for (const part of parts) {
			terms.add(part);
		}
	}

	for (const topic of topics) {
		if (topic) {
			terms.add(topic);
		}
	}

	return [...terms].slice(0, MAX_CONTEXT_TERMS);
};
