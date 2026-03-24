---
name: js-ts-clean-code
description: >
  JavaScript and TypeScript clean code guidelines. Covers readability, simplicity, formatting,
  naming, comments, imports, assignment patterns, object construction, block formatting, type
  extraction, logical grouping, and iteration. Use when writing, reviewing, or refactoring JS/TS code.
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
- Never comment what the code does. If you feel the need, rename things until the code is self-explanatory.
- For detailed commenting guidelines (when to use block comments, JSDoc, inline comments, documenting business context, external dependencies, and infrastructure chains), see the `code-documenting` skill.

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

## Assignment Patterns

- Always use `const`. Never use `let` except in `for` loop headers.
- `const` forces better structure — when you can't mutate, you extract a function, use a ternary, or use nullish coalescing. This naturally produces cleaner, more declarative code.
- Chain ternaries for 2-3 branches. Beyond that, extract to a helper or use a lookup.

```ts
// Good
const label = role === 'admin' ? 'Administrator'
  : role === 'editor' ? 'Editor'
  : 'Viewer';

const name = user.displayName ?? user.email ?? 'Anonymous';

// Good — complex logic extracted to a function
const permissions = resolvePermissions(role, org);

// Bad — let + mutation
let label = 'Viewer';
if (role === 'admin') {
  label = 'Administrator';
} else if (role === 'editor') {
  label = 'Editor';
}
```

## Object Construction

- Build objects inline at the call site. No pre-built mutable objects.
- Use conditional spreads for optional groups of properties.
- Pass `undefined` for single optional properties instead of conditional spreads.

```ts
// Good
await sendNotification({
  type: 'alert',
  message,
  channel: preferredChannel ?? undefined,
  ...(files.length > 0 && { files, hasAttachments: true }),
});

// Bad
const payload: any = { type: 'alert', message };
if (preferredChannel) {
  payload.channel = preferredChannel;
}
if (files.length > 0) {
  payload.files = files;
  payload.hasAttachments = true;
}
await sendNotification(payload);
```

## Block Formatting

- Always use braces for `if`/`else`/`for`/`while` — even single-line bodies.
- One blank line before `if`/`for`/`while`/`switch` when preceded by another statement. No blank line when it's the first statement after an opening brace.
- Empty line before `return`/`throw` in multi-statement blocks. No empty line when it's the only statement.

```ts
// Good — blank line before if, braces around single statement
const items = event.clipboardData?.items;

if (!items) {
  return false;
}

// Good — no blank line, if is first statement in function
const handleClose = () => {
  if (editor) {
    editor.commands.setContent('');
  }
};

// Good — multi-statement block
if (isExpired) {
  logger.warn('Token expired');

  throw new AuthError('TOKEN_EXPIRED');
}

// Good — single statement, no blank line before return
if (!user) {
  return null;
}

// Bad — no braces
if (!user) return null;

// Bad — no blank line before if
const file = files.find(f => f.id === id);
if (!file) {
  return null;
}
```

## Type Extraction

- Always extract types and interfaces — never define them inline in function signatures.
- Domain types use concept names (`Notification`, `Session`).
- Parameter types use `Params` suffix, defined directly above the function.

```ts
// Good — always extracted
interface RetryOptions {
  attempts: number;
  delay: number;
}

function retry(fn: () => Promise<void>, opts: RetryOptions) {}

// Bad — inline type in signature
function retry(fn: () => Promise<void>, opts: { attempts: number; delay: number }) {}
```

## Logical Grouping

- Group related declarations together with no blank lines between them.
- One blank line between groups.
- No section comments or step comments. Structure and naming should make grouping obvious.

```ts
interface AccessToken { ... }
interface RefreshToken { ... }

interface Session { ... }
interface SessionStore { ... }

async function setupConnection(host: string) {
  const config = await loadConfig(host);
  const transport = createTransport(config);

  const token = await authenticate(transport, credentials);
  const session = createSession(token);

  await session.ping();

  return session;
}
```

## Iteration

- `for...of` over `.forEach()`. It's clearer, supports `break`/`continue`/`await`, and avoids closure overhead.

```ts
// Good
for (const item of items) {
  await process(item);
}

// Bad
items.forEach(async (item) => {
  await process(item);
});
```
