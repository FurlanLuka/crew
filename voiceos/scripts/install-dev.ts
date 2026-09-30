// Compiles Voice OS from source into the executable `crew voice` runs, replacing a downloaded release
// build (and replaced by the next `crew update`).
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { packFor } from '../src/voice-gate/pack.js';

const targetPath =
	process.env.CREW_VOICEOS_BIN ||
	join(process.env.CREW_CONFIG_DIR || join(homedir(), '.crew'), 'bin', 'voiceos');
mkdirSync(dirname(targetPath), { recursive: true });

const build = Bun.spawn(
	[
		'bun',
		'build',
		'--compile',
		'--minify',
		'--sourcemap',
		// No onnxruntime addon for this platform (an Intel Mac): the voice gate stays off.
		...(packFor(process.platform, process.arch) ? [] : ['--external', 'onnxruntime-node']),
		join(import.meta.dir, '..', 'src', 'main.ts'),
		'--outfile',
		targetPath,
	],
	{
		stdout: 'inherit',
		stderr: 'inherit',
	},
);
const exitCode = await build.exited;

if (exitCode !== 0) {
	process.exit(exitCode);
}

// A build from source is no release: the stamp crew update compares against goes, so the next
// update brings the release back.
rmSync(`${targetPath}.version`, { force: true });

console.log(`Installed Voice OS at ${targetPath}. Start it with: crew voice`);
