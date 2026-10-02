// Every form shows the crew commands it runs, live as the fields change: the page never does what
// the command line can't.
import { type SetupCommand, toCrewArgv } from '../../crew/commands.js';

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quote = (word: string): string =>
	PLAIN.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// A flag keeps its name bare and quotes only its value, as a developer would type it.
export const shellQuote = (word: string): string => {
	const flag = /^(--[a-z][a-z-]*=)(.*)$/.exec(word);

	return flag ? `${flag[1]}${quote(flag[2] ?? '')}` : quote(word);
};

// The line a developer would type: --json is the page's own business, a value fed on stdin is said
// as such and never printed, and the server's commands go by their name (the argv runs the alias
// every crew release answers).
export const formatCommand = (command: SetupCommand): string => {
	const argv = toCrewArgv(command)
		.filter((word) => word !== '--json')
		.map((word, index) => (index === 0 && word === 'voice' ? 'server' : word));
	const line = `crew ${argv.map(shellQuote).join(' ')}`;

	switch (command.type) {
		case 'keys_set':
			return `${line} < the key`;
		case 'import_plan':
		case 'import_project':
		case 'import_workspace':
		case 'import_all':
			return `${line} < crew-export.json`;
		default:
			return line;
	}
};

interface CommandLineProps {
	commands: (SetupCommand | null | undefined)[];
	// What happens after, in words ("then: main is checked out, installed and its servers started").
	then?: string;
	machineTitle?: string;
}

export const CommandLine = ({ commands, then, machineTitle }: CommandLineProps) => {
	const lines = commands
		.filter((command): command is SetupCommand => Boolean(command))
		.map(formatCommand);

	if (lines.length === 0) {
		return null;
	}

	return (
		<div className="runs">
			<span className="label">Runs{machineTitle ? ` on ${machineTitle}` : ''}</span>
			<pre>
				{lines.join('\n')}
				{then ? `\nthen: ${then}` : ''}
			</pre>
		</div>
	);
};
