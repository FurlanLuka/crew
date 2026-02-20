---
name: code-structure
description: >
  Code structure and expression patterns. Covers assignment patterns, object construction,
  block formatting, type extraction, logical grouping, and iteration. Use when writing,
  reviewing, or refactoring JS/TS code.
user-invocable: false
---

# Code Structure & Expression Patterns

Guidelines for how to construct assignments, objects, blocks, and types. Complements `js-ts-clean-code` (formatting, naming, imports) with structural patterns.

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
- Empty line before `return`/`throw` in multi-statement blocks. No empty line when it's the only statement.

```ts
// Good — multi-statement block
if (isExpired) {
  logger.warn('Token expired');

  throw new AuthError('TOKEN_EXPIRED');
}

// Good — single statement, no blank line
if (!user) {
  return null;
}

// Bad — no braces
if (!user) return null;
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
