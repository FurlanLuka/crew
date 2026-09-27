// Generates the committed audio fixtures with Soniox TTS, so tests replay identical audio.
// Run again only when cases.json changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, resolvePaths } from '../src/config.js';
import { addNoise, decodeWav, encodeWav, speedUp } from '../src/speech/wav.js';

interface AudioCase {
	id: string;
	voice: string;
	text: string;
}

const audioDir = join(import.meta.dir, '..', 'evals', 'audio');
const { cases } = JSON.parse(readFileSync(join(audioDir, 'cases.json'), 'utf8')) as {
	cases: AudioCase[];
};
const sonioxKey = loadKeys(resolvePaths()).soniox;

if (!sonioxKey) {
	throw new Error('No Soniox key (~/.config/crew-voiceos/soniox.key or SONIOX_API_KEY)');
}

const onlyIds = process.argv.slice(2);

for (const audioCase of cases.filter(
	(candidate) => onlyIds.length === 0 || onlyIds.includes(candidate.id),
)) {
	const response = await fetch('https://tts-rt.soniox.com/tts', {
		method: 'POST',
		headers: { authorization: `Bearer ${sonioxKey}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: 'tts-rt-v2',
			language: 'en',
			voice: audioCase.voice,
			audio_format: 'wav',
			sample_rate: 16000,
			text: audioCase.text,
		}),
	});

	if (!response.ok) {
		throw new Error(`${audioCase.id}: TTS ${response.status} ${await response.text()}`);
	}

	const clean = decodeWav(new Uint8Array(await response.arrayBuffer()));

	// Noise and 1.2x speed stress recognition.
	writeFileSync(join(audioDir, 'fixtures', `${audioCase.id}.clean.wav`), encodeWav(clean));
	writeFileSync(
		join(audioDir, 'fixtures', `${audioCase.id}.noise.wav`),
		encodeWav(addNoise(clean, 0.02, 7)),
	);
	writeFileSync(
		join(audioDir, 'fixtures', `${audioCase.id}.fast.wav`),
		encodeWav(speedUp(clean, 1.2)),
	);
	console.log(`${audioCase.id}: ${(clean.length / 16000).toFixed(1)}s`);
}
