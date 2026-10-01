// A narrow question for the route eval: on a session's screen, are these words for that session or a
// command for Voice OS? Measured against today's kernel before any router is built on it.
import type Anthropic from '@anthropic-ai/sdk';

const CLASSIFIER_MODEL = 'claude-haiku-4-5';

export type RouteDecision = 'session' | 'voiceos' | 'unclear';

export const CLASSIFIER_PROMPT = `You route what a developer says aloud in Voice OS, a voice cockpit for coding sessions (one Claude Code session per worktree). A session is on screen. Decide where these words go.

session: words for the Claude session on screen — its work, code, tests, PRs, questions about what it did or is doing, answers to what the session itself asked, follow-ups to what it just said. Anything that would make sense typed into that session's chat. A machine, worktree, flag or file mentioned in passing inside such a request does not make it a command: what the words ask for decides.

voiceos: a command for Voice OS itself — switch, open or go to another session or machine; go back; activate, start, enable, deactivate, end or close a session; list machines, worktrees or what is active; what did I miss; mute or stop talking; listening modes (hands-free, push to talk); rename a session or machine; save a note or a debug note for Voice OS; start, stop or restart dev servers; send or tell words to ANOTHER named session; stop or interrupt the work; or a yes/no answering Voice OS's own question (an offer to switch, activate, deactivate, fix servers). Words that begin with "Voice OS" are voiceos, unless they ask for a change to Voice OS itself as work (its code, its docs, its behaviour): that is session work.

unclear: only when the words could honestly be either.

Answer with one word: session, voiceos or unclear.`;

export interface ClassifyParams {
	client: Anthropic;
	// What the kernel is told of the moment: the screen, sessions, what waits, what was just said aloud.
	context: string;
}

export const classifyRoute = async ({
	client,
	context,
}: ClassifyParams): Promise<RouteDecision> => {
	const response = await client.messages.create({
		model: CLASSIFIER_MODEL,
		max_tokens: 5,
		temperature: 0,
		system: CLASSIFIER_PROMPT,
		messages: [{ role: 'user', content: context }],
	});

	return parseRouteAnswer(
		response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
	);
};

// "Voice OS", "**voiceos**", "Session." all read as their word; anything else is unclear. Pure.
export const parseRouteAnswer = (text: string): RouteDecision => {
	const word = text.toLowerCase().replace(/[^a-z]/g, '');

	return word.startsWith('session')
		? 'session'
		: word.startsWith('voiceos')
			? 'voiceos'
			: 'unclear';
};
