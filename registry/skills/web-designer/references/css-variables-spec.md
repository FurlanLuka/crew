# CSS Variables Specification

Complete specification for theme CSS variables. Each theme file contains a single `:root { ... }` block with these variables.

## Primary Scale (10 shades, light to dark)

The primary color is the brand/accent color used for buttons, links, and interactive elements.

```
--primary-50   → lightest tint (backgrounds, subtle highlights)
--primary-100  → very light
--primary-200  → light
--primary-300  → medium light
--primary-400  → medium
--primary-500  → medium saturated
--primary-600  → main action color (buttons, links)
--primary-700  → dark (hover states)
--primary-800  → darker
--primary-900  → darkest
```

## Neutral Scale (10 shades)

Used for text, backgrounds, borders, and UI chrome.

```
--neutral-50   → lightest (near white)
--neutral-100  → very light gray
--neutral-200  → light gray
--neutral-300  → medium light gray
--neutral-400  → medium gray
--neutral-500  → middle gray
--neutral-600  → medium dark gray
--neutral-700  → dark gray
--neutral-800  → very dark gray
--neutral-900  → near black
```

## Surface Colors

```
--background        → page background
--surface           → card/modal background
--surface-elevated  → elevated elements (popovers, dropdowns)
--border            → default border color
```

## Semantic Colors

```
--success     → #22c55e (green)
--success-bg  → #dcfce7 (light green background)
--warning     → #f59e0b (amber)
--warning-bg  → #fef3c7 (light amber background)
--error       → #ef4444 (red)
--error-bg    → #fee2e2 (light red background)
--info        → #3b82f6 (blue)
--info-bg     → #dbeafe (light blue background)
```

## Typography Colors

For **light themes**:
```
--text-heading  → dark but soft, not pure black (e.g., #1a1a1a)
--text-body     → slightly lighter (e.g., #3d3d3d)
--text-muted    → medium gray (e.g., #6b6b6b)
```

For **dark themes**:
```
--text-heading  → bright off-white (e.g., #fafafa)
--text-body     → slightly dimmer (e.g., #e5e5e5)
--text-muted    → medium gray (e.g., #a3a3a3)
```

Other text colors:
```
--text-link          → var(--primary-600)
--text-link-hover    → var(--primary-700)
--text-on-primary    → #ffffff (text on primary-colored backgrounds)
--text-on-secondary  → var(--text-body)
--text-disabled      → #9ca3af
```

## Spacing Scale

```
--space-1   → 0.25rem (4px)
--space-2   → 0.5rem  (8px)
--space-3   → 0.75rem (12px)
--space-4   → 1rem    (16px)
--space-6   → 1.5rem  (24px)
--space-8   → 2rem    (32px)
--space-12  → 3rem    (48px)
```

## Effects

```
--radius-sm    → 0.25rem
--radius-md    → 0.5rem
--radius-lg    → 0.75rem
--radius-full  → 9999px
--shadow-sm    → 0 1px 2px rgba(0,0,0,0.05)
--shadow-md    → 0 4px 6px rgba(0,0,0,0.1)
--shadow-lg    → 0 10px 15px rgba(0,0,0,0.1)
```

## Complete Example

```css
:root {
  /* Primary - Ocean Blue */
  --primary-50: #f0f9ff;
  --primary-100: #e0f2fe;
  --primary-200: #bae6fd;
  --primary-300: #7dd3fc;
  --primary-400: #38bdf8;
  --primary-500: #0ea5e9;
  --primary-600: #0284c7;
  --primary-700: #0369a1;
  --primary-800: #075985;
  --primary-900: #0c4a6e;

  /* Neutral */
  --neutral-50: #fafafa;
  --neutral-100: #f5f5f5;
  --neutral-200: #e5e5e5;
  --neutral-300: #d4d4d4;
  --neutral-400: #a3a3a3;
  --neutral-500: #737373;
  --neutral-600: #525252;
  --neutral-700: #404040;
  --neutral-800: #262626;
  --neutral-900: #171717;

  /* Surface */
  --background: #ffffff;
  --surface: #ffffff;
  --surface-elevated: #f8fafc;
  --border: #e2e8f0;

  /* Semantic */
  --success: #22c55e;
  --success-bg: #dcfce7;
  --warning: #f59e0b;
  --warning-bg: #fef3c7;
  --error: #ef4444;
  --error-bg: #fee2e2;
  --info: #3b82f6;
  --info-bg: #dbeafe;

  /* Typography */
  --text-heading: #1a1a1a;
  --text-body: #3d3d3d;
  --text-muted: #6b6b6b;
  --text-link: var(--primary-600);
  --text-link-hover: var(--primary-700);
  --text-on-primary: #ffffff;
  --text-on-secondary: var(--text-body);
  --text-disabled: #9ca3af;

  /* Spacing */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-12: 3rem;

  /* Effects */
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --radius-full: 9999px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
}
```
