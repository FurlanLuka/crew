export const SITE_URL = 'https://getcrew.sh';
export const REPO_URL = 'https://github.com/FurlanLuka/crew';
export const INSTALL_LINE = 'curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh';

type Section = 'home' | 'start' | 'guides' | 'releases';

type PageOptions = {
  title: string;
  description: string;
  path: string;
  section: Section;
  body: string;
  navBar?: boolean;
  flat?: boolean;
};

const NAV_LINKS: { section: Section; href: string; label: string }[] = [
  { section: 'start', href: '/start/', label: 'Get started' },
  { section: 'guides', href: '/guides/', label: 'Guides' },
  { section: 'releases', href: '/releases/', label: 'Releases' },
];

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nav(section: Section, bar: boolean): string {
  const links = NAV_LINKS.map(
    (link) => `<a class="navlink${link.section === section ? ' on' : ''}" href="${link.href}">${link.label}</a>`,
  ).join('\n');

  return `<nav class="site-nav wrap${bar ? ' bar' : ''}" aria-label="Site">
<a class="brand" href="/">Crew <i></i> Voice OS</a>
<span class="grow"></span>
${links}
<a class="navlink" href="${REPO_URL}">GitHub</a>
</nav>`;
}

export function page(options: PageOptions): string {
  const url = `${SITE_URL}${options.path}`;
  const description = escapeHtml(options.description);
  const title = escapeHtml(options.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/images/social-preview.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#000000">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body${options.flat ? ' class="flat"' : ''}>
${nav(options.section, options.navBar ?? false)}
${options.body}
</body>
</html>
`;
}
