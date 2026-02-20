---
name: nodejs-clean-code
description: >
  Node.js and backend TypeScript guidelines. Covers error handling, async patterns, and
  backend-specific type conventions. Complements `js-ts-clean-code` and `code-structure`.
user-invocable: false
---

# Node.js / Backend TypeScript Guidelines

Backend-specific patterns. Use alongside `js-ts-clean-code` (formatting, naming, imports) and `code-structure` (assignments, objects, blocks, types).

## Types and Interfaces

- Shared interfaces go in a separate interfaces file, following the project's structure.
- Function parameter interfaces are named after the function with a `Params` suffix (e.g., `CreateUserParams` for `createUser`), and defined directly above the function that uses them.

## Error Handling

- All errors must be handled. No unhandled promises, no swallowed exceptions, no unexpected behavior.
- Never silently ignore errors. If you catch it, either handle it, re-throw it, or log it.
- Prefer explicit error handling at every boundary — function calls, async operations, external APIs.

## Async

- Run independent operations in parallel with `Promise.all`.
- Guard concurrent execution with a boolean flag and `try/finally`.
- Prefer explicit `async/await` over `.then()` chains.
