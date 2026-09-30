// Reads a byte stream chunk by chunk until it ends. Bun's streams are async-iterable, but the
// TypeScript that CI type-checks with does not know it, so no `for await` over them.
export const forEachChunk = async (
	stream: ReadableStream<Uint8Array>,
	onChunk: (chunk: Uint8Array) => void,
): Promise<void> => {
	const reader = stream.getReader();

	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		onChunk(read.value);
	}
};
