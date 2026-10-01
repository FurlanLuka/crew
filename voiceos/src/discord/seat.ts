// Who speaks: the page the developer used last, or the voice channel while they are in it.
import { DISCORD_CLIENT } from './bridge.js';

export class SpeakerSeat {
	private speaker: string | null = null;
	// The page used before joining the voice channel; it speaks again once they leave.
	private before: string | null = null;

	get current(): string | null {
		return this.speaker;
	}

	get isOnDiscord(): boolean {
		return this.speaker === DISCORD_CLIENT;
	}

	// A page sent something: it speaks from now on, unless the voice channel holds the seat.
	pageUsed(client: string): void {
		if (!this.isOnDiscord) {
			this.speaker = client;
		}
	}

	// A second page opening must not take the audio from the one in use; only an empty seat is taken.
	pageOpened(client: string): void {
		this.speaker ??= client;
	}

	pageClosed(client: string): void {
		if (this.speaker === client) {
			this.speaker = null;
		}

		if (this.before === client) {
			this.before = null;
		}
	}

	// True when the voice channel took the seat now (announce it), false when it already had it.
	discordJoined(): boolean {
		if (this.isOnDiscord) {
			return false;
		}

		this.before = this.speaker;
		this.speaker = DISCORD_CLIENT;

		return true;
	}

	discordLeft(): void {
		if (this.isOnDiscord) {
			this.speaker = this.before;
		}

		this.before = null;
	}
}

export type PageMicVerdict = 'allow' | 'ignore' | 'refuse';

// While in the voice channel Discord is the mic: a press is dropped, a page asking to listen is told
// no (listen_off), so it shows its mic off rather than live and unheard.
export const decidePageMic = (
	type: 'ptt_start' | 'listen_start',
	isOnDiscord: boolean,
): PageMicVerdict => (!isOnDiscord ? 'allow' : type === 'listen_start' ? 'refuse' : 'ignore');
