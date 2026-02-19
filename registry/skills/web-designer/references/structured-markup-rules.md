# Structured HTML Markup Rules

Every mockup MUST use these structured conventions so components and sections can be extracted later.

## Attribute Conventions

1. **Section markers**: Add `data-section="{id}"` on each page section (use section IDs from design-definitions.md)
2. **Component markers**: Add `data-component="{id}"` on component instances within sections (use component IDs from design-definitions.md)
3. **Variant markers**: Add `data-variant="{variant}"` on variant elements (e.g., `data-variant="primary"` on a primary button)

## CSS Class Naming

Use `oc-{id}` prefix for all component classes:

- `.oc-button`, `.oc-button--primary`, `.oc-card__title`
- Multi-word IDs use kebab-case: `stat_card` → `.oc-stat-card`
- BEM-like structure: `.oc-{component}`, `.oc-{component}--{variant}`, `.oc-{component}__{element}`

## CSS Organization

Group CSS rules between comment markers:

```css
/* === COMPONENT: {id} === */
.oc-button { ... }
.oc-button--primary { ... }
/* === END: {id} === */

/* === SECTION: {id} === */
[data-section="hero"] { ... }
/* === END: {id} === */
```

## Section Manifest

After the LAYOUT comment at the top of the HTML, add a manifest listing all sections:

```html
<!-- LAYOUT: Section Scroll, CONTAINER: wide, NAV: top-bar -->
<!-- SECTION_MANIFEST: nav, hero, features_grid, testimonials, cta, footer -->
```

## Rules

- **No inline styles** for component styling — all through `oc-*` classes referencing CSS variables
- **Self-contained component CSS** — each component's rules should work independently
- All colors, spacing, and effects must use CSS variables (`var(--primary-600)`, `var(--space-4)`, etc.)

## Complete Example

```html
<!-- LAYOUT: Section Scroll, CONTAINER: wide, NAV: top-bar -->
<!-- SECTION_MANIFEST: nav, hero, features_grid, testimonials, cta, footer -->
<style>
  :root { /* theme variables from theme.css */ }

  /* === COMPONENT: button === */
  .oc-button { display: inline-flex; padding: var(--space-2) var(--space-6); border-radius: var(--radius-md); font-weight: 600; }
  .oc-button--primary { background: var(--primary-600); color: var(--text-on-primary); }
  .oc-button--outline { border: 1.5px solid var(--primary-600); background: transparent; color: var(--primary-600); }
  /* === END: button === */

  /* === COMPONENT: card === */
  .oc-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-6); }
  .oc-card__title { font-weight: 600; color: var(--text-heading); margin-bottom: var(--space-2); }
  /* === END: card === */

  /* === SECTION: nav === */
  [data-section="nav"] { /* nav section styles */ }
  /* === END: nav === */

  /* === SECTION: hero === */
  [data-section="hero"] { /* hero section styles */ }
  /* === END: hero === */
</style>

<nav data-section="nav">
  <div class="nav-container">
    <a class="logo">Acme</a>
    <button class="oc-button oc-button--primary" data-component="button" data-variant="primary">Sign Up</button>
  </div>
</nav>

<section data-section="hero">
  <h1>Ship faster with Acme</h1>
  <button class="oc-button oc-button--primary" data-component="button" data-variant="primary">Get Started</button>
  <button class="oc-button oc-button--outline" data-component="button" data-variant="outline">Learn More</button>
</section>

<section data-section="features_grid">
  <div class="oc-card" data-component="card">
    <div class="oc-card__title">Fast Deploys</div>
    <p>Push to production in seconds.</p>
  </div>
</section>
```
