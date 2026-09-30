// Calls sent over a link and not yet answered, by id: each settles once — by its answer, its
// timeout, or the link going — and an answer that comes after is dropped.

interface Pending<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export type Settlement<T> = { ok: true; value: T } | { ok: false; error: Error };

export interface OpenCallParams {
	timeoutMs: number;
	onTimeout: () => Error;
}

export class PendingCalls<T> {
	private calls = new Map<number, Pending<T>>();
	private nextId = 1;

	get size(): number {
		return this.calls.size;
	}

	open({ timeoutMs, onTimeout }: OpenCallParams): { id: number; promise: Promise<T> } {
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(onTimeout());
			}, timeoutMs);

			this.calls.set(id, { resolve, reject, timer });
		});

		return { id, promise };
	}

	// False when nothing waits on that id any more (it timed out, or was never sent).
	settle(id: number, settlement: Settlement<T>): boolean {
		const call = this.calls.get(id);

		if (!call) {
			return false;
		}

		this.calls.delete(id);
		clearTimeout(call.timer);

		if (settlement.ok) {
			call.resolve(settlement.value);
		} else {
			call.reject(settlement.error);
		}

		return true;
	}

	rejectAll(error: Error): void {
		for (const call of this.calls.values()) {
			clearTimeout(call.timer);
			call.reject(error);
		}

		this.calls.clear();
	}
}
