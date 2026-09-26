import stylistic from '@stylistic/eslint-plugin';
import tsParser from 'typescript-eslint';

export default [
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/*.tsbuildinfo',
			'**/.next/**',
			'**/coverage/**',
		],
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parser: tsParser.parser,
		},
		plugins: {
			'@stylistic': stylistic,
		},
		rules: {
			// ── Padding lines ──────────────────────────────────────────────
			// Biome doesn't support padding-line-between-statements.
			// These rules make code more breathable and readable.
			'@stylistic/padding-line-between-statements': [
				'warn',
				// Blank line before return
				{ blankLine: 'always', prev: '*', next: 'return' },

				// Blank line before and after multiline block-like statements (if, for, while, try, switch)
				{ blankLine: 'always', prev: '*', next: 'multiline-block-like' },
				{ blankLine: 'always', prev: 'multiline-block-like', next: '*' },

				// Blank line after imports
				{ blankLine: 'always', prev: 'import', next: '*' },
				{ blankLine: 'any', prev: 'import', next: 'import' },

				// Blank line before and after interfaces/types
				{ blankLine: 'always', prev: '*', next: ['interface', 'type'] },
				{ blankLine: 'always', prev: ['interface', 'type'], next: '*' },
				{ blankLine: 'any', prev: 'type', next: 'type' },
				{ blankLine: 'any', prev: 'interface', next: 'interface' },

				// Fall-through case labels stay together
				{ blankLine: 'any', prev: 'case', next: 'case' },
			],
		},
	},
];
