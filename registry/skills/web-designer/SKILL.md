---
name: web-designer
description: >
  Design system knowledge base for award-winning web design generation. Contains universal
  component definitions, layout techniques, design principles, CSS variable specifications,
  and structured markup rules. Support skill — not user-invocable.
user-invocable: false
---

# Web Designer Knowledge Base

This skill provides the design reference data used by the `web-designer` agent. It contains everything needed to generate distinctive, award-worthy website designs for any type of project.

## Reference Files

### `references/design-definitions.md`
**When to read**: During research phase and before mockup generation.

A universal design toolkit — not organized by category. Contains:
- **Components** — all available UI components (buttons, cards, stat cards, pricing toggles, message bubbles, etc.) in a single pool. Any component can be used in any design.
- **Page sections** — building blocks for page structure (navigation styles, hero types, content areas, social proof, CTAs, footers). Pick what serves the design.
- **Layout techniques** — spatial approaches (bento, masonry, editorial, asymmetric), typography-driven design, rhythm and whitespace, visual depth.
- **Design principles** — composition, color, and typography guidelines.

**How to read**: Read the full file for the component and layout vocabulary. Components and sections are universal — mix and match freely based on what the project needs.

### `references/design-techniques.md`
**When to read**: During research phase for design thinking inspiration.

Principles and techniques for creating distinctive designs:
- Visual storytelling and narrative pacing
- Spatial composition and grid-breaking
- Typography as a design element
- Color psychology and palette strategies
- Layout archetypes and when to use them
- Navigation craft
- Component composition and anti-patterns
- Awwwards judging criteria breakdown

**How to read**: Read for design thinking principles. This teaches HOW to approach design, not what to copy. Real site examples come from live Playwright screenshots during the research phase, not this file.

### `references/css-variables-spec.md`
**When to read**: Before theme generation (Phase 3).

Contains the complete CSS variable specification:
- Primary color scale (50-900) — brand/action color
- Secondary color scale (50-900) — complementary color for visual richness
- Accent scale (5 values: 100-900) — bold pop color for highlights
- Neutral color scale (50-900)
- Surface colors (background, surface, surface-elevated, border)
- Semantic colors (success, warning, error, info + backgrounds) — flexible, not hardcoded
- Typography colors (heading, body, muted, link, on-primary, on-secondary, on-accent)
- Spacing scale (space-1 through space-12)
- Effects (radius, shadow)
- Complete 3-color example `:root` block

### `references/structured-markup-rules.md`
**When to read**: Before mockup generation (Phase 5).

Contains HTML markup conventions for extractable, structured mockups:
- `data-section`, `data-component`, `data-variant` attribute usage
- `oc-*` CSS class naming (BEM-like)
- CSS organization with `/* === COMPONENT: {id} === */` markers
- Section manifest comment format
- Complete annotated HTML example

### `assets/theme-template.html`
**When to read**: During theme generation (Phase 3).

Base HTML template for theme preview. Contains:
- `<!-- INJECT_CSS -->` placeholder for generated CSS
- Static typography defaults (sizes, weights, line heights)
- Preview sections: primary, secondary, accent, and neutral color scales, typography, surfaces, semantic colors, buttons (primary/secondary/accent/outline/neutral variants), cards (default/primary-tint/secondary-tint/accent-highlight)
- All elements reference CSS variables — inject a `:root` block to see the theme

## Design Research

Real-world site inspiration comes from **live visual research** during the agent's research phase (Phase 2), not from static reference files. The agent uses Playwright to screenshot real websites:
- Awwwards listing/tag pages to discover interesting sites
- CSS Design Awards, Godly, Dribbble, Behance, or any relevant source
- 3-5 individual reference sites for detailed visual analysis

The agent is multimodal — it reads the screenshots to identify layout approaches, typography, color, and spatial rhythm. This ensures every design session draws from current, award-winning work rather than a fixed set of memorized examples.
