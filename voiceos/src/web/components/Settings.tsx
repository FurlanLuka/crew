// Voice OS settings (the gear): one page with a side menu — how this tab listens, voice off, the two
// keys, Discord, the names you gave sessions, the machines, and whether crew opens into Voice OS.
import { type FormEvent, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { SPOKEN_LANGUAGES } from '../../shared/languages.js';
import type { MachineStatus, State } from '../../shared/protocol.js';
import { readAlwaysVoice, writeAlwaysVoice } from '../home/prefs.js';
import { INPUT_MODES, type InputMode } from '../listen-mode.js';
import { isOk, readCrewLine, runCrew, useCrew } from '../setup/api.js';
import { CommandLine } from '../setup/CommandLine.js';
import type { Dispatch } from '../types.js';
import { isKeyMissing, type KeyName } from './BeforeYouTalk.js';
import { MODE_COPY } from './ModeMenu.js';
import { RenameSession } from './RenameSession.js';

interface SettingsProps {
	state: State;
	dispatch: Dispatch;
	listenMode: InputMode;
	onListenMode: (mode: InputMode) => void;
	onSetUpMachine: (machine: string) => void;
}

const KEYS: { name: KeyName; title: string; what: string }[] = [
	{ name: 'soniox', title: 'Soniox', what: 'speech in and out' },
	{ name: 'anthropic', title: 'Anthropic', what: 'works out which session your words are for' },
];

const MACHINE_WORDS: Record<MachineStatus, string> = {
	connecting: 'connecting',
	syncing: 'catching up',
	connected: 'connected',
	unreachable: 'not reachable',
	error: 'needs a fix',
};

const KeyRow = ({
	name,
	title,
	what,
	isMissing,
}: (typeof KEYS)[number] & { isMissing: boolean }) => {
	const [value, setValue] = useState<string | null>(null);
	const [result, setResult] = useState<{ isOk: boolean; text: string } | null>(null);
	const [isBusy, setIsBusy] = useState(false);

	const save = async (event: FormEvent) => {
		event.preventDefault();

		if (!value?.trim()) {
			return;
		}

		setIsBusy(true);
		const reply = await runCrew(LOCAL_MACHINE, { type: 'keys_set', name, value: value.trim() });
		setIsBusy(false);
		setResult({
			isOk: isOk(reply),
			text: readCrewLine(reply) || (isOk(reply) ? 'Saved.' : 'Not saved.'),
		});

		if (isOk(reply)) {
			setValue(null);
		}
	};

	const isBad = result !== null && !result.isOk;

	return (
		<div className="box-row key-row" data-key={name}>
			<span className={`dot ${isMissing || isBad ? 'ask' : 'ok'}`} />
			<span className="sub">
				<b>{title}</b>
				<span className={`m ${isBad ? 'c-crit' : ''}`}>
					{result?.text ?? (isMissing ? `not set · ${what}` : what)}
				</span>
				{value !== null && (
					<form className="key-form" onSubmit={save}>
						<input
							type="password"
							autoComplete="off"
							aria-label={`${title} key`}
							placeholder={name === 'anthropic' ? 'sk-ant-…' : 'Soniox API key'}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
						<button type="submit" className="btn sm primary" disabled={isBusy}>
							{isBusy ? 'Checking…' : 'Check and save'}
						</button>
						<button type="button" className="btn sm ghost" onClick={() => setValue(null)}>
							Cancel
						</button>
					</form>
				)}
				{value !== null && (
					<CommandLine commands={[{ type: 'keys_set', name, value: value || '-' }]} />
				)}
			</span>
			{value === null && (
				<button type="button" className="btn sm" onClick={() => setValue('')}>
					{isMissing ? 'Add' : 'Replace'}
				</button>
			)}
		</div>
	);
};

// crew server discord channels --json: where a message can go.
interface DiscordChannelRow {
	id: string;
	name: string;
	kind: 'text' | 'voice';
	is_voice: boolean;
	is_current: boolean;
}

// The voice channel itself is chosen as "voice": its chat stays where messages go if it is renamed.
const VOICE_CHAT = 'voice';

// Where a session posts when the developer asks it to send something to Discord: the voice channel's
// own chat, or a text channel picked here (crew server discord setup --text-channel).
const MessagesChannel = () => {
	const channels = useCrew<DiscordChannelRow[]>(LOCAL_MACHINE, { type: 'discord_channels' });
	const [line, setLine] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const rows = channels.data ?? [];
	const voice = rows.find((row) => row.is_voice);
	const current = rows.find((row) => row.is_current);
	const chosen = !current || current.is_voice ? VOICE_CHAT : current.id;

	const choose = async (channel: string) => {
		setIsSaving(true);
		const reply = await runCrew(LOCAL_MACHINE, { type: 'discord_text_channel', channel });
		setIsSaving(false);
		setLine(readCrewLine(reply) || (isOk(reply) ? 'Saved.' : 'Not saved.'));
		channels.refresh();
	};

	return (
		<>
			<div className="box-row">
				<span className="sub">
					<b>Messages</b>
					<span className="m">
						where a session posts when you ask it to send something to Discord
					</span>
				</span>
				<span className="row-actions">
					<select
						className="sel"
						aria-label="Messages channel"
						value={chosen}
						disabled={rows.length === 0 || isSaving}
						onChange={(event) => void choose(event.target.value)}
					>
						<option value={VOICE_CHAT}>
							{voice ? `${voice.name}'s chat` : "the voice channel's chat"}
						</option>
						{rows
							.filter((row) => row.kind === 'text')
							.map((row) => (
								<option key={row.id} value={row.id}>
									#{row.name}
								</option>
							))}
					</select>
				</span>
			</div>
			{line ? (
				<p className="vs-note">{line}</p>
			) : (
				channels.reply &&
				!isOk(channels.reply) && <p className="vs-note">{readCrewLine(channels.reply)}</p>
			)}
		</>
	);
};

const DiscordSection = ({ state }: { state: State }) => {
	const [line, setLine] = useState<string | null>(null);
	const [isConfirming, setIsConfirming] = useState(false);
	const discord = state.discord;

	if (!discord) {
		return (
			<div className="vs-sec" id="vs-discord">
				<h2>Discord</h2>
				<p className="vs-lead">Talk to Voice OS from a private voice channel, on your phone.</p>
				<div className="box">
					<div className="box-row">
						<span className="dot ring" />
						<span className="sub">
							<b>Not set up</b>
							<span className="m">crew server discord setup</span>
						</span>
					</div>
				</div>
				<p className="vs-note">
					Four steps: make a private server with a voice channel, create a bot in Discord's
					developer portal, invite it with View Channel, Connect and Speak, then run{' '}
					<code>crew server discord setup</code> in a terminal and paste its token.
				</p>
			</div>
		);
	}

	const turnOff = async () => {
		const reply = await runCrew(LOCAL_MACHINE, { type: 'discord_off' });
		setIsConfirming(false);
		setLine(readCrewLine(reply) || (isOk(reply) ? 'Discord turned off.' : 'Not turned off.'));
	};

	return (
		<div className="vs-sec" id="vs-discord">
			<h2>Discord</h2>
			<p className="vs-lead">Talk to Voice OS from a private voice channel, on your phone.</p>
			<div className="box">
				<div className="box-row">
					<span className={`dot ${discord.isConnected ? 'ok' : 'run'}`} />
					<span className="sub">
						<b>{discord.isConnected ? 'Connected' : 'Connecting'}</b>
						<span className="m">
							{discord.channelName} ·{' '}
							{discord.isOwnerIn ? "you're in the channel" : 'only your voice is heard'}
						</span>
					</span>
					<span className="row-actions">
						{isConfirming ? (
							<>
								<button type="button" className="btn sm danger" onClick={() => void turnOff()}>
									Turn off: the token is removed
								</button>
								<button
									type="button"
									className="btn sm ghost"
									onClick={() => setIsConfirming(false)}
								>
									Keep it
								</button>
							</>
						) : (
							<button type="button" className="btn sm danger" onClick={() => setIsConfirming(true)}>
								Turn off
							</button>
						)}
					</span>
				</div>
				<MessagesChannel />
			</div>
			{line && <p className="vs-note">{line}</p>}
		</div>
	);
};

const NamesSection = ({ state, dispatch }: { state: State; dispatch: Dispatch }) => {
	const [renaming, setRenaming] = useState<string | null>(null);
	const names = Object.entries(state.names);

	return (
		<div className="vs-sec" id="vs-names">
			<h2>Names</h2>
			<p className="vs-lead">
				What you call a session out loud. A name replaces the ref everywhere.
			</p>
			{names.length === 0 ? (
				<p className="vs-note">
					No names yet. Rename a session from its page, or say “call checkout payments”.
				</p>
			) : (
				<div className="box">
					{names.map(([ref, name]) => (
						<div key={ref} className="box-row">
							<span className="dot" />
							<span className="sub">
								{renaming === ref ? (
									<RenameSession
										sessionRef={ref}
										current={name}
										dispatch={dispatch}
										onDone={() => setRenaming(null)}
									/>
								) : (
									<b>{name}</b>
								)}
								<span className="m">{ref}</span>
							</span>
							<span className="row-actions">
								<button type="button" className="btn sm" onClick={() => setRenaming(ref)}>
									Rename
								</button>
								<button
									type="button"
									className="btn sm ghost"
									onClick={() => dispatch({ type: 'rename_session', ref, name: '' })}
								>
									Clear
								</button>
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

// The side menu: each entry scrolls to its section on the one page, so nothing is hidden behind it.
const SECTIONS = [
	{ id: 'vs-listening', title: 'Listening' },
	{ id: 'vs-voice', title: 'Voice' },
	{ id: 'vs-keys', title: 'Keys' },
	{ id: 'vs-discord', title: 'Discord' },
	{ id: 'vs-names', title: 'Names' },
	{ id: 'vs-machines', title: 'Machines' },
	{ id: 'vs-opening', title: 'Opening crew' },
] as const;

export const Settings = ({
	state,
	dispatch,
	listenMode,
	onListenMode,
	onSetUpMachine,
}: SettingsProps) => {
	const [isAlwaysVoice, setIsAlwaysVoice] = useState(readAlwaysVoice);
	const [shown, setShown] = useState<string>(SECTIONS[0].id);

	// The menu follows the page: the section nearest the top of the view is the current one.
	useEffect(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				const seen = entries.find((entry) => entry.isIntersecting);

				if (seen) {
					setShown(seen.target.id);
				}
			},
			{ rootMargin: '0px 0px -70% 0px' },
		);

		for (const section of SECTIONS) {
			const element = document.getElementById(section.id);

			if (element) {
				observer.observe(element);
			}
		}

		return () => observer.disconnect();
	}, []);

	const goTo = (id: string) => {
		setShown(id);
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	};

	return (
		<section className="vo-view vs-page" aria-label="Voice OS settings">
			<nav className="vs-nav" aria-label="Settings sections">
				<h1>Settings</h1>
				{SECTIONS.map((section) => (
					<button
						key={section.id}
						type="button"
						aria-current={shown === section.id}
						onClick={() => goTo(section.id)}
					>
						{section.title}
					</button>
				))}
			</nav>
			<div className="vs-set">
				<div className="vs-sec" id="vs-listening">
					<h2>Listening</h2>
					<p className="vs-lead">
						How your turn starts and ends. The menu in the voice bar sets the same thing.
					</p>
					<div className="vs-modes">
						{INPUT_MODES.map((mode) => (
							<button
								key={mode}
								type="button"
								className="vs-mode"
								aria-pressed={listenMode === mode}
								onClick={() => onListenMode(mode)}
							>
								<b>{MODE_COPY[mode].name}</b>
								<span>{MODE_COPY[mode].description}</span>
							</button>
						))}
					</div>
					<h3>Languages you speak</h3>
					<div className="language-grid">
						{SPOKEN_LANGUAGES.map(({ code, name }) => {
							const isPicked = state.languages.includes(code);

							return (
								<button
									key={code}
									type="button"
									className="language-item"
									aria-pressed={isPicked}
									onClick={() =>
										dispatch({
											type: 'set_languages',
											languages: isPicked
												? state.languages.filter((picked) => picked !== code)
												: [...state.languages, code],
										})
									}
								>
									{name}
								</button>
							);
						})}
					</div>
				</div>
				<div className="vs-sec" id="vs-voice">
					<h2>Voice</h2>
					<p className="vs-lead">Turn every voice thing off at once. Typing keeps working.</p>
					<div className="box">
						<div className="box-row">
							<span className={`dot ${state.voiceOff ? '' : 'ok'}`} />
							<span className="sub">
								<b>{state.voiceOff ? 'Voice is off' : 'Voice is on'}</b>
								<span className="m">
									{state.voiceOff
										? 'Nothing listens or speaks. Discord’s bot is out of its channel.'
										: 'Also in the top bar: click “voice”.'}
								</span>
							</span>
							<button
								type="button"
								className="btn"
								onClick={() => dispatch({ type: 'set_voice_off', voiceOff: !state.voiceOff })}
							>
								{state.voiceOff ? 'Turn voice on' : 'Mute voice'}
							</button>
						</div>
					</div>
				</div>
				<div className="vs-sec" id="vs-keys">
					<h2>Keys</h2>
					<p className="vs-lead">
						Kept on This Mac, readable by you only. crew checks each one before saving it.
					</p>
					<div className="box">
						{KEYS.map((key) => (
							<KeyRow key={key.name} {...key} isMissing={isKeyMissing(state, key.name)} />
						))}
					</div>
				</div>
				<DiscordSection state={state} />
				<NamesSection state={state} dispatch={dispatch} />
				<div className="vs-sec" id="vs-machines">
					<h2>Machines</h2>
					<p className="vs-lead">Where your sessions run. Added and configured in Set up.</p>
					<div className="box">
						<div className="box-row">
							<span className="dot ok" />
							<span className="sub">
								<b>This Mac</b>
								<span className="m">here · runs crew's server</span>
							</span>
							<span className="chip ok">main</span>
						</div>
						{Object.values(state.machines).map((machine) => (
							<div key={machine.id} className="box-row" data-machine={machine.id}>
								<span
									className={`dot ${machine.status === 'connected' ? 'ok' : machine.status === 'connecting' || machine.status === 'syncing' ? 'run' : 'ask'}`}
								/>
								<span className="sub">
									<b>{machine.name}</b>
									<span className="m">
										ssh {machine.host} · {MACHINE_WORDS[machine.status]}
										{machine.detail ? ` · ${machine.detail}` : ''}
									</span>
								</span>
								<span className="row-actions">
									<button
										type="button"
										className="btn"
										onClick={() =>
											dispatch({
												type: 'switch_view',
												view: { kind: 'activate', machine: machine.id },
											})
										}
									>
										Open
									</button>
									<button
										type="button"
										className="btn ghost"
										onClick={() => onSetUpMachine(machine.id)}
									>
										In Set up
									</button>
								</span>
							</div>
						))}
					</div>
				</div>
				<div className="vs-sec" id="vs-opening">
					<h2>Opening crew</h2>
					<label className="check-line">
						<input
							type="checkbox"
							checked={isAlwaysVoice}
							onChange={(event) => {
								writeAlwaysVoice(event.target.checked);
								setIsAlwaysVoice(event.target.checked);
							}}
						/>
						Always open Voice OS (skip crew’s Home when crew opens)
					</label>
				</div>
			</div>
		</section>
	);
};
