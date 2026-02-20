---
name: react-clean-code
description: React clean code guidelines. Covers component structure, state management, data fetching, composition, and naming conventions. Use when writing, reviewing,
or refactoring React code.
user-invocable: false
---

# React Clean Code Guidelines

Components should be small, focused, and self-sufficient. If a component is hard to name, it's doing too much.

## Component Structure

- Functional components only. Arrow function syntax, always named exports. No default exports.
- One component per file. File name matches the component name in PascalCase.
- Props are always destructured in the function signature, never accessed via `props.`.
- Props interface is named `ComponentNameProps` and defined directly above the component in the same file.
- Use `interface` for props. Use `type` for unions and aliases.

```tsx
interface ProjectHeaderProps {
    name: string;
    status: string;
}

export const ProjectHeader = ({ name, status }: ProjectHeaderProps) => {
    // ...
};
```

Data Fetching & State Ownership

- Components fetch their own data. No prop drilling of server data through multiple layers.
- A component that needs data should call the hook itself, even if a parent already has it.
- Keep state as local as possible. Lift only when two siblings genuinely need the same state.

Custom Hooks

- Discouraged unless genuinely reusable across multiple components.
- Don't create "controller" hooks that extract all logic from a component. Components are small — they should own their own lifecycle.
- Valid uses: shared UI behavior (table controls, debounce, media queries), abstracting a browser API, encapsulating a subscription.
- If a hook is only used by one component, inline the logic.

State Management

- Server state: a query/cache library (React Query, SWR). No manual fetch-and-setState.
- UI state: useState for local concerns — modal visibility, selected items, form inputs.
- Cross-cutting state: React Context, used sparingly (auth, theme, locale).
- No global UI state libraries unless the app genuinely needs it. Most UI state is local.

Event Handlers

- handle* prefix for functions defined in the component: handleDelete, handleSort, handleSubmit.
- on* prefix for callback props passed to children: onClose, onSuccess, onRowClick.
- Inline handlers for simple one-liners: onClick={() => setOpen(true)}.
- Use e.stopPropagation() on action buttons inside clickable parent elements.

Conditional Rendering

- Loading state: early return with a spinner/skeleton.
- Not found / error: early return with error message.
- Empty state: ternary — data present renders content, otherwise a fallback message.
- Optional elements: && operator. {subtitle && <Text>{subtitle}</Text>}.
- Two-state toggle: ternary.
- Components with nothing to show return null.

Composition

- Pages compose sub-components. Sub-components are small and focused on one concern.
- Modals, drawers, and popovers are separate components controlled by the parent's useState.
- Prefer composition via props over deeply nested children patterns.

Forms

- Use a form library (useForm, React Hook Form, etc.) over manual useState per field.
- Colocate form state with the form component. Don't lift form state to a parent.
- Validation: inline functions, returning an error string or null.
- Handle submission errors explicitly — show feedback to the user, never swallow.
- Reset form state when the form unmounts or the user cancels.

Delete / Destructive Action Pattern

- Track the item pending deletion in state: useState<string | null>(null).
- Show a confirmation dialog controlled by the truthiness of that state.
- On confirm: perform the action. On cancel: reset to null.

Routing

- Use the router's hooks for navigation (useNavigate) and URL params (useParams).
- Type your URL params.
- Protected routes wrap content and redirect unauthenticated users.

Types

- Data model interfaces in dedicated interface files, separate from component code.
- Const object + type pattern instead of enums:
export const Status = { ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' } as const;
export type Status = (typeof Status)[keyof typeof Status];
- Use import type for type-only imports.

Imports

- Order: external packages → internal modules (state, utils, hooks) → local components → type imports.
- Group related imports on one line.
- No barrel/index files. Import directly from the source file.