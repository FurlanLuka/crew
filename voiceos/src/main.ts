// One binary, two roles. With no arguments it is the cockpit (app.ts). `voiceos remote serve` is a
// remote machine's daemon and `voiceos remote attach` bridges an SSH link to it (remote/cli.ts).
// Each is imported only when chosen: the cockpit's module starts everything as it loads.

export {};

const [role, command] = process.argv.slice(2);

if (role === 'remote') {
	const { runRemote } = await import('./remote/cli.js');

	await runRemote(command);
} else {
	await import('./app.js');
}
