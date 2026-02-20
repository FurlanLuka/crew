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

## Secondary Scale (10 shades)

A complementary or contrasting color for visual richness. Used for: secondary buttons, alternate section backgrounds, decorative elements, hover states on non-primary items, visual variety.

```
--secondary-50   → lightest tint
--secondary-100  → very light
--secondary-200  → light
--secondary-300  → medium light
--secondary-400  → medium
--secondary-500  → medium saturated
--secondary-600  → main secondary color
--secondary-700  → dark
--secondary-800  → darker
--secondary-900  → darkest
```

## Accent Scale (5 values)

A bold pop color for highlights and emphasis. Used sparingly for: badges, notification dots, special callouts, decorative accents, gradient endpoints.

```
--accent-100  → light tint
--accent-300  → medium
--accent-500  → main accent
--accent-700  → dark
--accent-900  → darkest
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

Choose colors that harmonize with the palette mood. These don't have to be the traditional green/amber/red/blue — pick hues that feel natural within the overall palette while still communicating their meaning clearly.

```
--success     → positive/confirmation color (often green, but could be teal, emerald, etc.)
--success-bg  → light background variant
--warning     → caution color (often amber, but could be gold, orange, etc.)
--warning-bg  → light background variant
--error       → danger/destructive color (often red, but could be crimson, rose, etc.)
--error-bg    → light background variant
--info        → informational color (often blue, but could be cyan, indigo, etc.)
--info-bg     → light background variant
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
--text-on-secondary  → #ffffff (text on secondary-colored backgrounds)
--text-on-accent     → #ffffff (text on accent-colored backgrounds)
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

A 3-color palette: deep blue primary + warm coral secondary + gold accent.

```css
:root {
  /* Primary - Deep Blue */
  --primary-50: #eff6ff;
  --primary-100: #dbeafe;
  --primary-200: #bfdbfe;
  --primary-300: #93c5fd;
  --primary-400: #60a5fa;
  --primary-500: #3b82f6;
  --primary-600: #2563eb;
  --primary-700: #1d4ed8;
  --primary-800: #1e40af;
  --primary-900: #1e3a8a;

  /* Secondary - Warm Coral */
  --secondary-50: #fff7ed;
  --secondary-100: #ffedd5;
  --secondary-200: #fed7aa;
  --secondary-300: #fdba74;
  --secondary-400: #fb923c;
  --secondary-500: #f97316;
  --secondary-600: #ea580c;
  --secondary-700: #c2410c;
  --secondary-800: #9a3412;
  --secondary-900: #7c2d12;

  /* Accent - Gold */
  --accent-100: #fef9c3;
  --accent-300: #fde047;
  --accent-500: #eab308;
  --accent-700: #a16207;
  --accent-900: #713f12;

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

  /* Semantic — colors chosen to harmonize with the blue/coral/gold palette */
  --success: #10b981;
  --success-bg: #d1fae5;
  --warning: #f59e0b;
  --warning-bg: #fef3c7;
  --error: #ef4444;
  --error-bg: #fee2e2;
  --info: #6366f1;
  --info-bg: #e0e7ff;

  /* Typography */
  --text-heading: #1a1a1a;
  --text-body: #3d3d3d;
  --text-muted: #6b6b6b;
  --text-link: var(--primary-600);
  --text-link-hover: var(--primary-700);
  --text-on-primary: #ffffff;
  --text-on-secondary: #ffffff;
  --text-on-accent: #1a1a1a;
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
