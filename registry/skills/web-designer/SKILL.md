---
name: web-designer
description: >
  Design system knowledge base for web design generation. Contains component definitions,
  page sections, design approaches, CSS variable specifications, structured markup rules,
  and real-world style references for 8 website categories. Support skill — not user-invocable.
user-invocable: false
---

# Web Designer Knowledge Base

This skill provides the design reference data used by the `web-designer` agent. It contains everything needed to generate professional, well-structured website designs across 8 categories.

## Reference Files

### `references/design-definitions.md`
**When to read**: During discovery (after determining category) and before mockup generation.

Contains per-category:
- **Base components** — universal UI components (button, card, input, badge, alert, avatar, checkbox)
- **Category-specific components** — specialized components (e.g., `price_tag` for ecommerce, `message_bubble` for chat)
- **Page sections** — the sections that make up a page (e.g., nav, hero, product_grid, footer)
- **Design approaches** — proven structural approaches with container width, nav placement, and traits

**Reading by category**: Search for `## {category}` to jump to the relevant section. Each category has Components, Page Sections, and Design Approaches subsections.

### `references/design-references.md`
**When to read**: During discovery to understand style options, and before mockup generation for structural inspiration.

Contains real-world site examples organized by category and style:
- Each category has 2-4 style groups (e.g., blog has Minimal, Magazine, Portfolio Blog, Dev Blog)
- Each style has characteristics and 2-3 reference sites with detailed structural notes
- Notes describe layout, navigation, content structure, and visual treatment — not just aesthetics

**Reading by category**: Search for `## {category}` to jump to the relevant section.

### `references/css-variables-spec.md`
**When to read**: Before theme generation (Phase 2).

Contains the complete CSS variable specification:
- Primary color scale (50-900)
- Neutral color scale (50-900)
- Surface colors (background, surface, surface-elevated, border)
- Semantic colors (success, warning, error, info + backgrounds)
- Typography colors (heading, body, muted, link — with light/dark theme variants)
- Spacing scale (space-1 through space-12)
- Effects (radius, shadow)
- Complete example `:root` block

### `references/structured-markup-rules.md`
**When to read**: Before mockup generation (Phase 4).

Contains HTML markup conventions for extractable, structured mockups:
- `data-section`, `data-component`, `data-variant` attribute usage
- `oc-*` CSS class naming (BEM-like)
- CSS organization with `/* === COMPONENT: {id} === */` markers
- Section manifest comment format
- Complete annotated HTML example

### `assets/theme-template.html`
**When to read**: During theme generation (Phase 2).

Base HTML template for theme preview. Contains:
- `<!-- INJECT_CSS -->` placeholder for generated CSS
- Static typography defaults (sizes, weights, line heights)
- Preview sections: color scales, typography, surfaces, semantic colors, buttons, cards
- All elements reference CSS variables — inject a `:root` block to see the theme

## Categories

1. **blog** — Personal blogs, company blogs, newsletters
2. **landing_page** — Product launches, marketing pages, conversion-focused
3. **ecommerce** — Online stores, product catalogs, shopping experiences
4. **dashboard** — Admin panels, analytics, data management interfaces
5. **documentation** — Technical docs, API references, knowledge bases
6. **chat_messaging** — Chat interfaces, messaging apps, support widgets
7. **saas_marketing** — SaaS product marketing, pricing pages, enterprise
8. **portfolio** — Personal portfolios, agency sites, creative showcases
9. **jam** — Freeform design, user describes everything from scratch
