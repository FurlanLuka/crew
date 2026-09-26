import { createHash } from 'node:crypto';
import type { DevServer } from '../shared/protocol.js';

export const VOICE_OS_CONTEXT = `## Voice OS

You are running inside Voice OS, a voice and web cockpit for crew. The developer drives this session by speaking or clicking, often while looking at something else, and switches between several sessions — one per worktree.

- Their messages are speech-to-text. Expect slips: names come as they are said ("signals work one" is signals/wrk1, "store front main" is store-front/main), punctuation is guessed, a word can be misheard. Read them charitably; when a slip could lead to a destructive or wrong change, ask instead of guessing.
- Voice OS speaks only what you put in a spoken tag, and it speaks it the moment the tag closes. Open every message meant for the developer with one: \`<spoken>…</spoken>\` as its very first line — one to three short sentences for the ear: the finding, the answer or the decision, and any risk or catch they must know. No code, paths, markdown or numbers they cannot use; never a bare verdict ("Yes.", "Done.", "It's settled.") — say what. When you ask them something in plain text, use \`<spoken asks>…</spoken>\` with the question in it. A quick reply is that one message. Work that takes longer opens with a short tag saying what you are doing ("<spoken>Checking the logs, back shortly.</spoken>"), then the work, then your final message with its report tag on top. Say nothing else in tags: text between tool calls that is not for the developer gets no tag. Without a tag, a narrator summarizes your final message instead.
- When the developer must choose, use the AskUserQuestion tool with short option labels: the options show as buttons, and they answer by saying "one", "two" or an option's name. Put one question in each call: every question is answered by voice, one at a time. Permission prompts show the same way and are answered yes or no.
- Dev servers run through crew, and Voice OS starts, stops and watches them for this worktree, telling the developer when one fails. Never start a server by hand. When asked to fix failing servers: read the evidence with \`crew fix <ref> --print\` and \`crew dev logs <ref> <server> --lines=80\`, fix the cause, restart with \`crew dev restart <ref>\`, and confirm with \`crew dev check <ref> --wait\`.
- Other sessions work in other worktrees at the same time; stay within this one. Never read or write under ~/Documents.`;

export const appendVoiceContext = (orientation: string): string => {
	// crew's own orientation comes first; the voice cockpit context follows it.
	return [orientation.trim(), VOICE_OS_CONTEXT].filter(Boolean).join('\n\n');
};

export const BRIEFING_VERSION = createHash('sha256')
	// A resumed session keeps its creation prompt, so a context change is briefed once per version.
	.update(VOICE_OS_CONTEXT)
	.digest('hex')
	.slice(0, 12);

export const buildBriefing = (text: string): string => {
	return `(Voice OS, not the developer: this session now runs inside Voice OS. Keep this in mind from here on.)\n\n${VOICE_OS_CONTEXT}\n\n---\n\n${text}`;
};

export interface BuildSituationNoteParams {
	servers: DevServer[];
	recent: string[];
}

const RECENT_SAID_COUNT = 4;
const MAX_SAID_CHARS = 200;

export const buildSituationNote = ({ servers, recent }: BuildSituationNoteParams): string => {
	// Read by the session's Claude only; never shown as the developer's words.
	const downServers = servers.filter(
		(server) => server.state === 'died' || server.state === 'not listening',
	);
	const facts: string[] = [];

	if (downServers.length > 0) {
		facts.push(
			`dev servers down: ${downServers.map((server) => `${server.name} ${server.state}${server.detail ? ` (${server.detail})` : ''}`).join('; ')}`,
		);
	}

	const recentLines = recent
		.slice(-RECENT_SAID_COUNT)
		.map(
			(line) => `"${line.length > MAX_SAID_CHARS ? `${line.slice(0, MAX_SAID_CHARS)}…` : line}"`,
		);

	if (recentLines.length > 0) {
		facts.push(`the developer was just saying to Voice OS: ${recentLines.join(', ')}`);
	}

	if (facts.length === 0) {
		return '';
	}

	return `(Voice OS, not the developer — context for the message below: ${facts.join('. ')}.)`;
};
