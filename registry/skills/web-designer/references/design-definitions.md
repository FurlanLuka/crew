# Design Toolkit

Techniques, patterns, and building blocks for web design. Mix and match freely — nothing is locked to a category. Every project is unique; pick the components, sections, and layouts that serve the design.

---

## Components

Universal building blocks available for any design. Use whatever serves the project.

### Core UI
- **Buttons** [id: `button`]: Action buttons (variants: primary, secondary, outline, ghost, accent)
- **Inputs** [id: `input`]: Form input fields (variants: text, textarea, select, search)
- **Cards** [id: `card`]: Content containers (variants: default, elevated, bordered, tinted)
- **Badges/Tags** [id: `badge`]: Labels for categorization or status
- **Alerts/Toasts** [id: `alert`]: Feedback messages (variants: success, warning, error, info)
- **Avatars** [id: `avatar`]: User profile images or initials
- **Checkboxes/Toggles** [id: `checkbox`]: Selection controls (variants: checkbox, toggle)

### Data & Metrics
- **Stat Cards** [id: `stat_card`]: Metric display with label and trend indicator
- **Progress Bars** [id: `progress_bar`]: Visual progress or completion indicator
- **Tables** [id: `table`]: Data table with sortable headers and row styling
- **Status Indicators** [id: `status_dot`]: Colored dots or badges for status

### Content
- **Tag Pills** [id: `tag_pill`]: Rounded tags for categories or topics
- **Author Bylines** [id: `author_byline`]: Author name, avatar, and date
- **Timestamps** [id: `timestamp`]: Date/time display
- **Testimonial Quotes** [id: `testimonial_quote`]: Customer quote with attribution
- **Feature Boxes** [id: `feature_icon_box`]: Feature with icon, title, description
- **Callouts/Admonitions** [id: `callout`]: Note, tip, warning, danger blocks
- **Code Blocks** [id: `code_block`]: Syntax-highlighted code display
- **Breadcrumbs** [id: `breadcrumb`]: Navigation path indicator

### Commerce
- **Price Tags** [id: `price_tag`]: Product price with optional discount
- **Rating Stars** [id: `rating_stars`]: Star rating display (1-5)
- **Quantity Selectors** [id: `quantity_selector`]: Number input with +/- buttons
- **Pricing Toggles** [id: `pricing_toggle`]: Monthly/yearly billing switch
- **Feature Check Items** [id: `feature_check_item`]: Feature list item with checkmark

### Messaging
- **Message Bubbles** [id: `message_bubble`]: Chat message container
- **Typing Indicators** [id: `typing_indicator`]: Animated typing dots
- **Online Status** [id: `online_status`]: User availability indicator

### Portfolio & Creative
- **Project Thumbnails** [id: `project_thumbnail`]: Project preview with hover effect
- **Skill Tags** [id: `skill_tag`]: Technology/skill badge

---

## Page Sections

Building blocks for page structure. Use what serves the design — there's no mandatory set.

### Navigation
- **Top bar** — Fixed or sticky, transparent or solid, full-width or constrained
- **Sidebar** — Collapsible, icon rail, full with sections, dark or light
- **Overlay/hamburger** — Full-screen takeover, slide-in panel
- **Minimal** — Just logo + one CTA, almost invisible
- **Hidden** — Scroll-triggered, keyboard-driven, appears on demand

### Heroes
- **Full-viewport** — 100vh, immersive, dramatic typography, optional background
- **Split** — Content on one side, visual on the other (50/50 or 60/40)
- **Compact** — Short header with headline and subtext, no drama
- **Editorial** — Narrow text with full-bleed image breaking out
- **None** — Skip the hero, go straight to content

### Content Areas
- **Grids** — Equal columns, responsive auto-fill, 2-4 columns
- **Single column** — Constrained width, focused reading, generous margins
- **Masonry** — Variable-height items filling columns naturally
- **Bento** — Mixed-size tiles in a grid, playful arrangement
- **Timeline** — Chronological flow with date markers
- **Alternating splits** — Content/visual pairs flipping sides each row

### Social Proof
- **Logo bars** — Client/partner logos in a horizontal row
- **Testimonials** — Quote cards, carousels, or inline pull-quotes
- **Case studies** — Detailed success stories with metrics
- **Metrics row** — Large numbers with labels (users, revenue, uptime)

### CTAs
- **Inline** — Button within content flow
- **Full-section** — Dedicated section with headline, subtext, button
- **Floating** — Fixed position, always visible
- **Embedded** — CTA woven into content (newsletter within article, etc.)

### Footers
- **Minimal** — Logo, copyright, few links
- **Comprehensive** — Multi-column with link groups, social, newsletter
- **Mega-footer** — Full sitemap with descriptions, multiple CTAs

---

## Layout Techniques

### Spatial Approaches
- **Full-bleed sections** — Edge-to-edge sections with contained content within
- **Constrained single column** — Narrow/medium max-width, focused reading experience
- **Asymmetric splits** — Unequal columns (60/40, 70/30), alternating sides for rhythm
- **Bento grid** — Mixed-size tiles in a grid, playful and modern arrangement
- **Masonry** — Variable-height items filling columns naturally
- **Editorial flow** — Full-bleed images breaking out of narrow text columns
- **Stacked cards** — Layered/overlapping elements with depth and z-index play
- **Dense data** — Full viewport, compact rows, information-first, power-user aesthetic

### Typography-Driven Design
- Type scale as the primary visual system — size and weight create all hierarchy
- Mixed font pairing (serif headlines + sans body, or vice versa) for sophistication
- Fluid typography (viewport-scaled with clamp) that feels alive
- Oversized display text (8-12vw) as a visual element, not just content
- Monospace accents for technical feel — data, code, timestamps, labels

### Rhythm and Whitespace
- Generous vertical spacing between sections — whitespace signals quality
- Tight/dense for data-heavy interfaces — maximize information per viewport
- Alternating rhythm (spacious section → dense section) creates pacing
- Asymmetric margins for editorial feel — off-center content

### Visual Depth
- Layered elements with subtle shadows at different elevations
- Glassmorphism (frosted glass effects with backdrop-filter)
- Gradient backgrounds and overlays for mood and direction
- Flat/borderless (depth through spacing and color, not shadows)
- Overlapping elements — images breaking over section boundaries

---

## Design Principles

### Composition
- Every page needs a clear visual hierarchy — one dominant element per viewport
- Contrast creates hierarchy: size contrast, weight contrast, color contrast
- Negative space is a design element, not empty space to fill
- Break the grid intentionally for emphasis — an image bleeding past its column, text overlapping a boundary

### Color
- Limit to 2-3 colors max + neutrals. Restraint over variety
- Use all three scales: primary for brand/actions, secondary for richness, accent for highlights
- Dark themes need adjusted contrast ratios, not just inverted light themes
- Duotone and split-complementary palettes for bold, memorable identity
- Color-as-navigation: different sections identified by color creates wayfinding

### Typography
- Two fonts maximum. One is often enough with weight/size contrast
- Font choice sets the entire personality — choose first, design second
- Line length: 50-75 characters for body text
- Heading hierarchy through size AND weight, not just size
