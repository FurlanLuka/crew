// Builds the Voice OS archives a crew release carries, one per platform crew ships:
// voiceos_<version>_<goos>_<goarch>.tar.gz in dist/. `crew voice` downloads the one matching
// its own version, so crew and Voice OS always come from the same tag.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const version = (process.argv[2] ?? '').replace(/^v/, '');

if (!version) {
	console.error('Usage: bun scripts/build-release.ts <version>');
	process.exit(1);
}

// Bun's target names, and the Go names crew asks for (runtime.GOOS / runtime.GOARCH).
const TARGETS = [
	{ bun: 'bun-darwin-arm64', goos: 'darwin', goarch: 'arm64' },
	{ bun: 'bun-darwin-x64', goos: 'darwin', goarch: 'amd64' },
	{ bun: 'bun-linux-arm64', goos: 'linux', goarch: 'arm64' },
	{ bun: 'bun-linux-x64', goos: 'linux', goarch: 'amd64' },
];

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });

const run = async (command: string[], cwd = root) => {
	const exitCode = await Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;

	if (exitCode !== 0) {
		console.error(`failed: ${command.join(' ')}`);
		process.exit(exitCode);
	}
};

for (const target of TARGETS) {
	const dir = join(dist, `${target.goos}_${target.goarch}`);

	mkdirSync(dir, { recursive: true });
	await run([
		'bun',
		'build',
		'--compile',
		'--minify',
		'--sourcemap',
		`--target=${target.bun}`,
		join(root, 'src', 'main.ts'),
		'--outfile',
		join(dir, 'voiceos'),
	]);
	// Only the binary: the compiled executable carries its own source map.
	await run(
		['tar', '-czf', join(dist, `voiceos_${version}_${target.goos}_${target.goarch}.tar.gz`), 'voiceos'],
		dir,
	);
	console.log(`built voiceos_${version}_${target.goos}_${target.goarch}.tar.gz`);
}
