// Imported `with { type: 'file' }`: Bun hands back the file's path, embedded in the compiled binary.
declare module '*.png' {
	const path: string;
	export default path;
}
