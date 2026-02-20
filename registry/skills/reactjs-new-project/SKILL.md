---
name: react-project-setup
description: Recommended React project architecture and setup conventions. Covers folder structure, tooling, server-state layer, and styling approach. Use when
scaffolding a new React project or establishing conventions for an existing one.
user-invocable: false
---

# React Project Setup

Opinionated architecture for React apps. Prioritizes feature isolation, colocated concerns, and minimal boilerplate.

## Tooling

- Vite for bundling and dev server.
- TypeScript in strict mode.
- React Router for routing.
- React Query (TanStack Query) for server state.
- Mantine UI as the component and styling foundation.
- dayjs for date handling.
- i18next + react-i18next for internationalization.

## Mantine-First Approach

- Use Mantine for everything it supports: layout, forms, dates, notifications, modals, rich text, dropzone, hooks.
- Prefer `@mantine/form` over React Hook Form. Prefer `@mantine/dates` over a separate date picker. Prefer `@mantine/notifications` over toast libraries.
- Use Mantine's built-in props for spacing, typography, and layout. No CSS modules, no styled-components, no Tailwind.
- Inline `style` only for things Mantine props don't cover.
- Use Mantine CSS variables for theme values in inline styles: `var(--mantine-color-blue-4)`.
- Global CSS only for things that can't be expressed with Mantine (keyframes, link resets).

## Folder Structure

src/
App.tsx
pages/
    ProjectsPage.tsx
    ProjectDetailsPage.tsx
    MachinesPage.tsx
    MachineDetailsPage.tsx
    LoginPage.tsx
features/
    projects/
    ProjectHeader.tsx
    ProjectInfo.tsx
    ProjectWorkOrdersTable.tsx
    ProjectFormModal.tsx
    machines/
    MachineHeader.tsx
    MachineInfo.tsx
    MachineShiftsSection.tsx
    MachineFormModal.tsx
    auth/
    AuthContext.tsx
    ProtectedRoute.tsx
server-state/
    project.ts
    project.interfaces.ts
    machine.ts
    machine.interfaces.ts
    apiClient.ts
shared-components/
    ConfirmationModal.tsx
    StatusBadge.tsx
    EmptyState.tsx
hooks/
    useTableControls.ts
    useCurrentTime.ts
utils/
    notifications.ts
    enrichment.ts
theme/
    theme.ts

## Pages

- Pages are thin orchestrators. They fetch top-level data, manage modal state, and compose sub-components from their feature folder.
- Named `*Page.tsx` for list pages, `*DetailsPage.tsx` for detail pages.
- A page should read like a table of contents for the feature — you should understand the UI structure at a glance.

## Feature Folders

- Each feature owns its sub-components and modals.
- Sub-components are focused on one concern: a header, an info card, a table section, a form modal.
- Pages import from their feature folder. Feature folders never import from `pages/`.
- Cross-feature imports go through `server-state/` or `shared-components/`.

## Shared Components

- Reusable UI components used by two or more features.
- Each component is a single file. No nesting, no sub-folders unless the component is complex enough to warrant it.
- Don't pre-emptively extract to shared. Move a component here only when a second feature needs it.

## Theme

- Mantine theme configuration lives in `theme/theme.ts`.
- Custom colors, radius, spacing overrides, and component default props go here.
- Import and pass to `<MantineProvider theme={theme}>` in `App.tsx`.

## Server-State Layer

- One file per domain entity: `project.ts` paired with `project.interfaces.ts`.
- Define a query key factory at the top of each file:
```tsx
const projectKeys = {
    all: ['project'] as const,
    lists: () => [...projectKeys.all, 'list'] as const,
    details: () => [...projectKeys.all, 'detail'] as const,
    detail: (id: string) => [...projectKeys.details(), id] as const,
};
```
- Query hooks: useProjects, useProject(id).
- Mutation hooks: useCreateProject, useUpdateProject, useDeleteProject.
- Mutations invalidate related queries in onSuccess.
- Use mutateAsync inside try/catch for explicit error handling.
- When API data needs client-side computation, use a Raw → Enriched type pattern with React Query's select option.

Dates

- dayjs exclusively. No native Date in the UI layer.