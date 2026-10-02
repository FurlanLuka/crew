// One Voice OS build for crew server dev push: `bun scripts/build-dev.ts <bun target> <version> <outfile>`.
// The same flags as a release, stamped with the push's version so every machine of it matches.
import { join } from 'node:path';
import { COMPILE_FLAGS } from './compile-flags.js';

const [target, version, outfile] = process.argv.slice(2);

if (!target || !version || !outfile) {
	console.error('Usage: bun scripts/build-dev.ts <bun target> <version> <outfile>');
	process.exit(1);
}

const exitCode = await Bun.spawn(
	[
		'bun',
		'build',
		'--compile',
		'--minify',
		'--sourcemap',
		...COMPILE_FLAGS,
		`--target=${target}`,
		`--define=VOICEOS_VERSION=${JSON.stringify(version)}`,
		join(import.meta.dir, '..', 'src', 'main.ts'),
		'--outfile',
		outfile,
	],
	{ stdout: 'inherit', stderr: 'inherit' },
).exited;

process.exit(exitCode);
