# Design Definitions

Components, page sections, and design approaches organized by category.

## Base Components

Available for ALL categories:

- **Buttons** [id: `button`]: Action buttons for user interactions (variants: primary, secondary, outline, ghost)
- **Inputs** [id: `input`]: Form input fields (variants: text, textarea, select)
- **Cards** [id: `card`]: Generic container for content
- **Badges/Tags** [id: `badge`]: Small labels for categorization or status
- **Alerts/Toasts** [id: `alert`]: Feedback messages for success, warning, error, info (variants: success, warning, error, info)
- **Avatars** [id: `avatar`]: User profile images or initials
- **Checkboxes/Toggles** [id: `checkbox`]: Selection controls (variants: checkbox, toggle)

---

## blog

### Components
- **Tag Pill** [id: `tag_pill`]: Rounded tag for article categories
- **Author Byline** [id: `author_byline`]: Author name, avatar, and date

### Page Sections
- **Navigation** [id: `nav`]: Top navigation bar with logo and links
- **Hero/Featured** [id: `hero`]: Featured post or welcome header
- **Article Grid** [id: `article_grid`]: Grid or list of article previews
- **Sidebar** [id: `sidebar`]: Categories, tags, recent posts
- **Newsletter CTA** [id: `newsletter_cta`]: Email subscription form
- **Footer** [id: `footer`]: Links, copyright, social icons

### Design Approaches

#### Centered Reader
Typography-focused single column optimized for reading. Articles separated by whitespace or subtle dividers. No sidebar, no grid. Content breathes.
- Container: narrow
- Nav: minimal
- Traits: single column, generous line-height, article separators, typography-focused, minimal navigation

#### Sidebar Navigation
Fixed left sidebar with categories, tags, and navigation. Main content scrolls independently. Good for blogs with many categories.
- Container: medium
- Nav: sidebar-left
- Traits: fixed sidebar, category navigation, scrollable content, two-panel layout

#### Magazine Grid
Editorial feel with multi-column article grid. Featured article spans wider. Image-heavy with strong visual hierarchy.
- Container: wide
- Nav: top-bar
- Traits: multi-column grid, featured articles, image thumbnails, editorial feel, category sections

#### Timeline Feed
Social-feed inspired vertical timeline. Date markers on the side. Narrow and focused, feels like scrolling through updates.
- Container: narrow
- Nav: top-bar
- Traits: vertical timeline, date markers, narrow feed, social-inspired, chronological flow

#### Technical Docs Style
Code-focused with prominent code blocks that break out wider than text. Sticky table of contents on the side. Monospace accents.
- Container: medium
- Nav: sidebar-left
- Traits: wide code blocks, sticky TOC, monospace accents, technical feel, syntax highlighting

---

## landing_page

### Components
- **Testimonial Quote** [id: `testimonial_quote`]: Customer quote with attribution
- **Feature Icon Box** [id: `feature_icon_box`]: Feature with icon, title, description

### Page Sections
- **Navigation** [id: `nav`]: Top nav with logo and CTA button
- **Hero** [id: `hero`]: Main headline, subheading, CTA
- **Features Grid** [id: `features_grid`]: Feature icons with descriptions
- **Social Proof** [id: `social_proof`]: Logos, numbers, or trust indicators
- **Testimonials** [id: `testimonials`]: Customer quotes or reviews
- **CTA Section** [id: `cta`]: Final call to action
- **Footer** [id: `footer`]: Links, legal, social icons

### Design Approaches

#### Full-Bleed Cinematic
Dramatic full-viewport sections stacking vertically. Transparent overlay navigation. Large headlines, centered content, immersive feel.
- Container: full-width
- Nav: overlay
- Traits: full-viewport sections, transparent nav, dramatic typography, centered content, immersive scroll

#### Split Sections
Alternating 50/50 horizontal splits. Content on one side, visual on the other, flipping each section. Strong horizontal rhythm.
- Container: full-width
- Nav: top-bar
- Traits: 50/50 splits, alternating sides, content and visual pairs, horizontal rhythm, full-width sections

#### Bento Features
Features displayed in a bento-style grid with tiles of varying sizes. No traditional section order. Playful, modern, tile-based.
- Container: wide
- Nav: top-bar
- Traits: bento grid, varying tile sizes, non-traditional layout, playful arrangement, rounded tiles

#### Narrow Storytelling
Narrow single column with narrative flow. Reads like a story or letter. No grids, just flowing text and occasional illustrations.
- Container: narrow
- Nav: minimal
- Traits: narrative flow, single column, storytelling approach, conversational, minimal structure

#### Product Showcase
Hero dominated by product screenshots or demos. Features shown alongside product UI. Demo-first, visual-heavy approach.
- Container: wide
- Nav: top-bar
- Traits: product screenshots, demo-focused, UI showcases, visual features, product-led

---

## ecommerce

### Components
- **Price Tag** [id: `price_tag`]: Product price display with optional discount
- **Rating Stars** [id: `rating_stars`]: Star rating display (1-5)
- **Quantity Selector** [id: `quantity_selector`]: Number input with +/- buttons

### Page Sections
- **Navigation** [id: `nav`]: Top nav with logo, search, cart icon
- **Hero Banner** [id: `hero_banner`]: Promotional banner or featured products
- **Product Grid** [id: `product_grid`]: Grid of product cards
- **Product Detail** [id: `product_detail`]: Single product with images, price, buy button
- **Cart Summary** [id: `cart_summary`]: Mini cart or cart page summary
- **Footer** [id: `footer`]: Links, payment icons, trust badges

### Design Approaches

#### Catalog Grid
Classic shopping layout with filter sidebar and product grid. Sort options, pagination or infinite scroll. Familiar e-commerce pattern.
- Container: wide
- Nav: top-bar
- Traits: filter sidebar, product grid, sort options, familiar shopping UX, category navigation

#### Editorial Shop
Magazine-like browsing with large hero products and horizontal scroll rows. Lifestyle imagery, curated collections feel.
- Container: full-width
- Nav: top-bar
- Traits: large product heroes, horizontal scroll, lifestyle imagery, curated feel, editorial layout

#### Single Product Focus
Large product display with image gallery. Details prominent, minimal navigation. Great for hero products or limited catalogs.
- Container: medium
- Nav: minimal
- Traits: large product images, image gallery, prominent details, minimal distractions, focused UX

#### Boutique Minimal
Luxury feel with lots of whitespace. Products displayed sparingly with large imagery. Minimal UI chrome, exclusive aesthetic.
- Container: medium
- Nav: minimal
- Traits: generous whitespace, large imagery, minimal UI, luxury feel, exclusive aesthetic

#### Marketplace Dense
High-density product listings like a marketplace. Many products visible at once, compact cards, reviews prominent.
- Container: wide
- Nav: top-bar
- Traits: dense listings, compact cards, reviews visible, many products, marketplace feel

---

## dashboard

### Components
- **Stat Card** [id: `stat_card`]: Metric display with label and trend
- **Progress Bar** [id: `progress_bar`]: Visual progress indicator
- **Table Row** [id: `table_row`]: Data table row styling
- **Status Dot** [id: `status_dot`]: Colored indicator for status

### Page Sections
- **Sidebar Navigation** [id: `sidebar_nav`]: Left sidebar with menu items
- **Top Bar** [id: `top_bar`]: Header with search, notifications, profile
- **Stats Row** [id: `stats_row`]: Row of KPI stat cards
- **Data Table** [id: `data_table`]: Sortable, filterable data table
- **Chart Area** [id: `chart_area`]: Charts and graphs section
- **Activity Feed** [id: `activity_feed`]: Recent activity or notifications list

### Design Approaches

#### Classic Sidebar
Traditional dashboard with dark left sidebar and top bar. Stats cards, charts, and tables in the main content area.
- Container: full-width
- Nav: sidebar-left
- Traits: dark sidebar, top bar, stats cards, charts, data tables

#### Top Tabs
No sidebar, navigation via horizontal tabs. Content width constrained. Cleaner, less chrome, focus on content.
- Container: wide
- Nav: top-bar
- Traits: horizontal tabs, no sidebar, constrained width, clean layout, tab-based navigation

#### Minimal Focus
Icon rail plus expandable panel. Minimal chrome, maximum focus on the task. Single-purpose feel.
- Container: full-width
- Nav: sidebar-left
- Traits: icon rail, expandable panel, minimal chrome, focused UX, single-purpose feel

#### Data Dense
Maximum information density. Full viewport tables, compact rows, small font. For power users who need to see lots of data.
- Container: full-width
- Nav: sidebar-left
- Traits: high density, compact rows, full viewport, power user focused, data-first

#### Kanban Board
Column-based board layout like Trello. Cards move between columns. Horizontal scrolling if many columns.
- Container: full-width
- Nav: top-bar
- Traits: column layout, draggable cards, status columns, horizontal scroll, visual workflow

---

## documentation

### Components
- **Code Block** [id: `code_block`]: Syntax-highlighted code display
- **Callout/Admonition** [id: `callout`]: Note, tip, warning, danger blocks
- **Breadcrumb** [id: `breadcrumb`]: Navigation path indicator

### Page Sections
- **Sidebar Navigation** [id: `sidebar_nav`]: Left sidebar with section tree
- **Breadcrumb Header** [id: `breadcrumb_header`]: Breadcrumb path and page title
- **Content Area** [id: `content_area`]: Main documentation content
- **TOC Sidebar** [id: `toc_sidebar`]: Right sidebar table of contents
- **Footer** [id: `footer`]: Navigation links, edit on GitHub

### Design Approaches

#### Three Column
Classic docs layout: left sidebar for navigation, main content, right sidebar for on-page TOC. Comprehensive but structured.
- Container: full-width
- Nav: sidebar-left
- Traits: left sidebar nav, right TOC, three columns, comprehensive layout, structured navigation

#### Centered Single
Clean single-column reading with collapsible sidebar. Focused on content, less visual noise. Good for tutorials.
- Container: medium
- Nav: hidden
- Traits: single column, collapsible sidebar, focused reading, clean layout, tutorial-friendly

#### API Reference Split
Split layout with documentation on one side and code examples on the other. Side-by-side learning, code-heavy.
- Container: full-width
- Nav: sidebar-left
- Traits: split layout, code examples, side-by-side, API-focused, language tabs

#### Search First
Prominent search bar as the main entry point. Quick links and categories below. Optimized for finding content fast.
- Container: medium
- Nav: top-bar
- Traits: prominent search, quick links, category cards, find-first, minimal browsing

---

## chat_messaging

### Components
- **Message Bubble** [id: `message_bubble`]: Chat message container
- **Typing Indicator** [id: `typing_indicator`]: Animated dots for typing
- **Online Status** [id: `online_status`]: User availability indicator

### Page Sections
- **Conversation List** [id: `conversation_list`]: List of chat conversations
- **Chat Header** [id: `chat_header`]: Contact name, status, actions
- **Message Area** [id: `message_area`]: Scrollable message history
- **Input Area** [id: `input_area`]: Message input with send button

### Design Approaches

#### Three Panel
Slack-style with conversation list, main chat, and details/thread panel. Full-featured messaging interface.
- Container: full-width
- Nav: sidebar-left
- Traits: conversation list, main chat, details panel, full-featured, desktop-focused

#### Centered Bubble
Simple iMessage-style centered chat. Bubble messages, minimal chrome. Clean and focused on the conversation.
- Container: narrow
- Nav: top-bar
- Traits: chat bubbles, centered layout, minimal chrome, mobile-inspired, focused conversation

#### Support Widget
Floating widget style with launcher button. Compact, embedded feel. Quick replies, agent info, help articles.
- Container: narrow
- Nav: hidden
- Traits: floating widget, compact, launcher button, quick replies, help integration

#### AI Chat Interface
Optimized for AI conversations. Thinking indicators, markdown rendering, suggested prompts, response streaming feel.
- Container: medium
- Nav: minimal
- Traits: thinking indicators, markdown support, suggested prompts, streaming feel, AI-optimized

---

## saas_marketing

### Components
- **Pricing Toggle** [id: `pricing_toggle`]: Monthly/yearly billing switch
- **Feature Check Item** [id: `feature_check_item`]: Feature list item with checkmark

### Page Sections
- **Navigation** [id: `nav`]: Top nav with logo, links, sign up button
- **Hero** [id: `hero`]: Product headline, screenshot, CTA
- **Features** [id: `features`]: Key feature highlights
- **Pricing Table** [id: `pricing_table`]: Pricing tiers comparison
- **Testimonials** [id: `testimonials`]: Customer success stories
- **FAQ** [id: `faq`]: Frequently asked questions
- **CTA Section** [id: `cta`]: Final sign up prompt
- **Footer** [id: `footer`]: Product links, legal, social

### Design Approaches

#### Section Scroll
Classic marketing page with distinct sections: hero, features, pricing, testimonials, CTA. Familiar and effective.
- Container: wide
- Nav: top-bar
- Traits: distinct sections, hero to CTA flow, familiar structure, conversion-focused, section-based

#### Product Demo First
Lead with product screenshots or interactive demos. Features shown alongside product UI. Demo-driven conversion.
- Container: wide
- Nav: top-bar
- Traits: product demos, screenshot-heavy, interactive elements, demo-driven, visual proof

#### Pricing Focused
Pricing table as the hero or near-top. Feature comparison prominent. For products where pricing is the main decision point.
- Container: medium
- Nav: top-bar
- Traits: pricing prominent, feature comparison, tier cards, decision-focused, comparison tables

#### Enterprise Trust
Trust-heavy with security badges, compliance logos, enterprise customer logos. Professional, corporate feel.
- Container: wide
- Nav: top-bar
- Traits: security badges, customer logos, compliance, enterprise focus, trust signals

#### Developer / Open Source
GitHub stars, code snippets in hero, contributor-friendly. Terminal aesthetics, developer-focused messaging.
- Container: medium
- Nav: top-bar
- Traits: code snippets, GitHub integration, terminal aesthetic, developer-focused, open source friendly

---

## portfolio

### Components
- **Project Thumbnail** [id: `project_thumbnail`]: Project preview with hover effect
- **Skill Tag** [id: `skill_tag`]: Technology/skill badge

### Page Sections
- **Navigation** [id: `nav`]: Simple nav with name and links
- **Hero/Intro** [id: `hero_intro`]: Personal introduction and photo
- **Project Grid** [id: `project_grid`]: Portfolio of work samples
- **About Section** [id: `about_section`]: Bio, skills, experience
- **Contact Form** [id: `contact_form`]: Get in touch form
- **Footer** [id: `footer`]: Social links, copyright

### Design Approaches

#### Project Grid
Responsive grid of project thumbnails with hover effects. Filter by category. Classic portfolio layout.
- Container: wide
- Nav: top-bar
- Traits: project grid, hover effects, category filters, thumbnail images, responsive layout

#### Case Study Scroll
Long-form case study focus. Narrow content with full-bleed images breaking out. Process documentation, results metrics.
- Container: medium
- Nav: minimal
- Traits: long-form, full-bleed images, process documentation, results metrics, narrative flow

#### Bento Showcase
Bento-style grid with mixed tile sizes. About, projects, skills, links as different tiles. Modern CV-like feel.
- Container: wide
- Nav: minimal
- Traits: bento grid, mixed tiles, about and projects, modern CV, visual variety

#### Photography Gallery
Image-first with minimal text. Masonry or uniform grid. Lightbox viewing. For visual-heavy portfolios.
- Container: wide
- Nav: minimal
- Traits: image-first, masonry grid, lightbox viewing, minimal text, visual focus

#### Agency / Team
Multiple team members showcased. Services grid, client logos, team photos. Agency or studio feel.
- Container: wide
- Nav: top-bar
- Traits: team showcase, services grid, client logos, agency feel, multiple people
