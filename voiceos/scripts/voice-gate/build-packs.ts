// Builds the voice gate packs Voice OS downloads on its first start, one per platform in the
// manifest (src/voice-gate/pack.ts): the models export_models.py wrote, their licenses, and that
// platform's onnxruntime library from onnxruntime-node — the version the binary embeds the addon of.
//
//   bun scripts/voice-gate/build-packs.ts <models dir>
//
// Prints each archive's sha256 for the manifest. Upload them to the release the manifest names.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeLibraryName } from '../../src/voice-gate/models.js';
import { listPackFiles, PACK_MANIFEST } from '../../src/voice-gate/pack.js';

const modelsDir = process.argv[2];

if (!modelsDir) {
	console.error('Usage: bun scripts/voice-gate/build-packs.ts <models dir>');
	process.exit(1);
}

const root = join(import.meta.dir, '..', '..');
const dist = join(root, 'dist', 'voice-gate');
const runtimeDir = join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
const licenses = readdirSync(modelsDir).filter(
	(name) => name.startsWith('LICENSE') || name.startsWith('ThirdParty'),
);

rmSync(dist, { recursive: true, force: true });

for (const [key, entry] of Object.entries(PACK_MANIFEST.platforms)) {
	const [platform, arch] = key.split('-') as [NodeJS.Platform, string];
	const stage = join(dist, key);
	const library = runtimeLibraryName(platform);

	mkdirSync(stage, { recursive: true });
	copyFileSync(join(runtimeDir, platform, arch, library), join(stage, library));

	for (const file of [...listPackFiles(platform).filter((name) => name !== library), ...licenses]) {
		copyFileSync(join(modelsDir, file), join(stage, file));
	}

	const archive = join(dist, entry.url.split('/').at(-1) as string);
	const tar = Bun.spawn(['tar', '-czf', archive, '-C', stage, ...readdirSync(stage)], {
		stdout: 'inherit',
		stderr: 'inherit',
		// Without it macOS tar adds extended attributes GNU tar warns about.
		env: { ...process.env, COPYFILE_DISABLE: '1' },
	});

	if ((await tar.exited) !== 0) {
		console.error(`failed: ${archive}`);
		process.exit(1);
	}

	const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');

	console.log(`${key}\t${sha256}\t${archive}`);
}
