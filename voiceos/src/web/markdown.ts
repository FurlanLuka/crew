// For one-line previews: what Markdown says, without its signs. The stream renders it instead.
export const stripMarkdown = (text: string): string =>
	text
		// Fences keep their content, lose the ``` lines.
		.replace(/^\s*(?:```|~~~).*$/gm, '')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/gm, '')
		.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
		// Table separator rows go; cell pipes become gaps.
		.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
		// Only table rows (lines that start with a pipe): "ls | wc -l" in prose keeps its pipe.
		.replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, (_, cells: string) =>
			cells
				.split('|')
				.map((cell) => cell.trim())
				.join('  '),
		)
		// Emphasis only where it wraps words, so snake_case and 2 * 3 survive.
		.replace(/(^|[\s(])(\*\*|__)(?=\S)(.*?\S)\2(?=[\s).,;:!?]|$)/gm, '$1$3')
		.replace(/(^|[\s(])([*_])(?=\S)([^*_]*?\S)\2(?=[\s).,;:!?]|$)/gm, '$1$3')
		.replace(/~~(?=\S)([^~]*?\S)~~/g, '$1')
		.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
		.replace(/\n{2,}/g, '\n')
		.trim();
