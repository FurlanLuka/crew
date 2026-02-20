---
name: js-ts-clean-code
description: >
  JavaScript and TypeScript clean code guidelines. Covers readability, simplicity, formatting,
  naming, comments, and import conventions. Use when writing, reviewing, or refactoring JS/TS code.
user-invocable: false
---

# JavaScript / TypeScript Clean Code Guidelines

Code should be as readable as possible and as simple as possible. If something feels too complex, split it up or rethink the architecture.

## Readability

- Code is read far more than it is written. Optimize for the reader.
- Functions can do multiple steps, but they should stay linear and readable. If a function has too many branches, deeply nested conditionals, or you're losing track of what it does — split it. Sequential steps are fine; tangled complexity is not.
- Prefer early returns over deep nesting. The happy path should live at the top indentation level.
- Name things for what they represent, not how they work. Verb-first for functions (`createUser`, `resolveEndpoint`), noun for types (`CommunicationContract`, `PaginatedResult`).
- Boolean variables get `is`/`has` prefix. No guessing what `valid` means — `isValid` is clear.
- Avoid clever code. Boring code is good code.

## Simplicity

- The right amount of abstraction is the minimum needed for the current task. Three similar lines are better than a premature helper.
- If a function has more than 3 parameters, use a named options object.
- Prefer pure functions over stateful classes. Use classes only when you genuinely need to manage state or lifecycle.

## Formatting

- Indent with tabs. Line width limit: 100 characters.
- Always use semicolons. Single quotes for strings, double quotes for JSX.
- Trailing commas everywhere.
- Always wrap arrow function parameters in parentheses, even single ones.
- One blank line between top-level declarations, between class members, and between logical steps within a function.
- No blank line after an opening brace or before a closing brace.
- One blank line after a guard clause / early return block.
- When arguments don't fit on one line, put each on its own line with a trailing comma. Closing paren aligns with the call site.
- Short objects on one line. Multi-line objects get one key per line with trailing comma.
- One blank line between the last import and the first line of code. Never more.

## Comments

- Minimal comments. Well-named functions and variables should speak for themselves.
- No JSDoc. No comment blocks above functions.
- Only add inline comments inside a function when the logic is genuinely complex and not obvious from the code alone.
- Never comment what the code does. If you feel the need, rename things until the code is self-explanatory.

## Imports and Exports

- External packages first, then internal packages, then relative imports.
- Use `import type` for type-only imports.
- Use `.js` extensions in relative imports (ESM).
- No wildcard imports.
- No index/barrel files. Import directly from the source file.
- Always use named exports. Never use default exports.

## Naming Conventions

- Variables, functions, and parameters: `camelCase`.
- Interfaces and types: `PascalCase`.
- Error codes and constants: `SCREAMING_SNAKE_CASE`.
