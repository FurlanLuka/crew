// What every compiled Voice OS needs beyond `bun build --compile`.
export const COMPILE_FLAGS = [
	// opusscript's WebAssembly goes into the binary as a file (its loader is patched in patches/).
	'--loader',
	'.wasm:file',
	// Optional codecs and native speedups the Discord libraries try and fall back from: never bundled.
	...[
		'ffmpeg-static',
		'@discordjs/opus',
		'node-opus',
		'sodium-native',
		'sodium',
		'libsodium-wrappers',
		'@stablelib/xchacha20poly1305',
		'@noble/ciphers',
		'zlib-sync',
		'bufferutil',
		'utf-8-validate',
	].flatMap((name) => ['--external', name]),
];
