import type { PendingAsk, Question } from '../shared/protocol.js';
import type { AskResult } from '../state/reducer.js';
import { summarizeTool } from './events.js';

interface PendingAnswer {
	ref: string;
	resolve: (result: AskResult) => void;
}

export interface CanUseToolOptions {
	signal?: AbortSignal;
	suggestions?: Record<string, unknown>[];
}

export const parseQuestions = (input: Record<string, unknown>): Question[] => {
	const rawQuestions = Array.isArray(input.questions)
		? (input.questions as Record<string, unknown>[])
		: [];

	return rawQuestions.map((rawQuestion) => ({
		question: typeof rawQuestion.question === 'string' ? rawQuestion.question : '',
		header: typeof rawQuestion.header === 'string' ? rawQuestion.header : undefined,
		multiSelect: rawQuestion.multiSelect === true,
		options: (Array.isArray(rawQuestion.options)
			? (rawQuestion.options as Record<string, unknown>[])
			: []
		).map((rawOption) => ({
			label: typeof rawOption.label === 'string' ? rawOption.label : '',
			description: typeof rawOption.description === 'string' ? rawOption.description : undefined,
		})),
	}));
};

export interface BuildAskParams {
	id: string;
	ref: string;
	at: number;
	toolName: string;
	input: Record<string, unknown>;
	suggestions: Record<string, unknown>[];
	cwd?: string;
}

export const buildAsk = ({
	id,
	ref,
	at,
	toolName,
	input,
	suggestions,
	cwd,
}: BuildAskParams): PendingAsk => {
	if (toolName === 'AskUserQuestion') {
		return { id, ref, at, kind: 'question', input, questions: parseQuestions(input) };
	}

	if (toolName === 'ExitPlanMode') {
		return {
			id,
			ref,
			at,
			kind: 'plan',
			input,
			plan: typeof input.plan === 'string' ? input.plan : '',
		};
	}

	return {
		id,
		ref,
		at,
		kind: 'permission',
		toolName,
		summary: summarizeTool(toolName, input, cwd),
		input,
		suggestions,
	};
};

export class PermissionBridge {
	// Each SDK promise settles once (answer, abort or settleRef); a second answer is a no-op.
	private pending = new Map<string, PendingAnswer>();
	private counter = 0;

	constructor(
		private onOpen: (ask: PendingAsk) => void,
		private onClose: (askId: string) => void,
		private now: () => number = Date.now,
	) {}

	canUseTool(ref: string, cwd?: string) {
		return (
			toolName: string,
			input: Record<string, unknown>,
			options: CanUseToolOptions,
		): Promise<AskResult> => {
			const id = `ask-${ref}-${++this.counter}-${this.now()}`;
			const ask = buildAsk({
				id,
				ref,
				at: this.now(),
				toolName,
				input,
				suggestions: options.suggestions ?? [],
				cwd,
			});

			return new Promise<AskResult>((resolve) => {
				this.pending.set(id, { ref, resolve });

				options.signal?.addEventListener(
					'abort',
					() => this.settle(id, { behavior: 'deny', message: 'Cancelled.' }),
					{ once: true },
				);
				this.onOpen(ask);
			});
		};
	}

	answer(askId: string, result: AskResult): boolean {
		return this.settle(askId, result);
	}

	settleRef(ref: string, message: string): number {
		const settledIds: string[] = [];

		for (const [id, entry] of this.pending) {
			if (entry.ref === ref && this.settle(id, { behavior: 'deny', message })) {
				settledIds.push(id);
			}
		}

		return settledIds.length;
	}

	countPending(): number {
		return this.pending.size;
	}

	private settle(askId: string, result: AskResult): boolean {
		const entry = this.pending.get(askId);

		if (!entry) {
			return false;
		}

		this.pending.delete(askId);
		entry.resolve(result);
		this.onClose(askId);

		return true;
	}
}
