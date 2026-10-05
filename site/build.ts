// Builds crew's site into site/dist from the repo's own docs and release notes.
// Run from anywhere: `bun site/build.ts`. Release dates come from git tags, so CI checks out full history.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { landingPage, startPage } from './home';
import { escapeHtml, page, REPO_URL } from './layout';
import { firstParagraph, firstSentence, inlineHtml, renderMarkdown, type Routes } from './markdown';

type Guide = { slug: string; file: string; kicker: string; blurb: string; featured?: boolean };

type Release = { version: string; file: string; markdown: string; date: string | undefined };

const SITE_DIR = import.meta.dir;
const REPO_DIR = join(SITE_DIR, '..');
const DIST_DIR = join(SITE_DIR, 'dist');

const GUIDES: Guide[] = [
  {
    slug: 'voice-os',
    file: 'docs/guides/voice-os.md',
    kicker: 'Start here',
    blurb:
      "The half of crew's page that runs one Claude Code session per worktree and lets you drive all of them by talking, typing or clicking. From first run to other machines.",
    featured: true,
  },
  {
    slug: 'setup',
    file: 'docs/guides/setup.md',
    kicker: 'The page',
    blurb:
      'Where projects, workspaces, worktrees and machines are configured. Every form runs a crew command and shows it to you before you press anything.',
    featured: true,
  },
  {
    slug: 'voice-os-commands',
    file: 'docs/guides/voice-os-commands.md',
    kicker: 'What you can say',
    blurb: 'Everything the router can do, one tool at a time, with things to say for each, taken from real use.',
    featured: true,
  },
  {
    slug: 'concepts',
    file: 'docs/concepts.md',
    kicker: 'Underneath',
    blurb:
      'What a project, a workspace and a worktree are, how services find each other, and how crew proves a copy works.',
  },
  {
    slug: 'getting-set-up',
    file: 'docs/guides/getting-set-up.md',
    kicker: 'As commands',
    blurb: 'From an empty crew to two copies of your stack side by side, typed out as commands.',
  },
  {
    slug: 'remote-vm',
    file: 'docs/guides/remote-vm.md',
    kicker: 'Other machines',
    blurb: 'Worktrees, dev servers and Claude Code on a Linux VM, and the Voice OS on your Mac driving it.',
  },
  {
    slug: 'commands',
    file: 'docs/commands.md',
    kicker: 'Reference',
    blurb: "Every command and exactly what it prints, generated from crew's own help.",
  },
];

function read(repoPath: string): string {
  return readFileSync(join(REPO_DIR, repoPath), 'utf8');
}

function write(sitePath: string, html: string): void {
  const file = join(DIST_DIR, sitePath, sitePath.endsWith('.html') ? '' : 'index.html');

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

function titleOf(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);

  return match ? match[1].trim() : '';
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return right[i] - left[i];
    }
  }

  return 0;
}

function tagDates(): Map<string, string> {
  const result = Bun.spawnSync(
    ['git', 'for-each-ref', '--format=%(refname:short) %(creatordate:iso-strict)', 'refs/tags'],
    { cwd: REPO_DIR },
  );
  const dates = new Map<string, string>();

  for (const line of result.stdout.toString().split('\n')) {
    const [tag, date] = line.split(' ');
    if (tag && date) {
      dates.set(tag, date);
    }
  }

  return dates;
}

function formatDate(iso: string | undefined): string {
  if (!iso) {
    return '';
  }

  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function loadReleases(): Release[] {
  const dates = tagDates();

  return readdirSync(join(REPO_DIR, 'docs/releases'))
    .filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
    .map((name) => {
      const version = name.slice(1, -3);
      const file = `docs/releases/${name}`;

      return { version, file, markdown: read(file), date: dates.get(`v${version}`) };
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}

function routesFor(releases: Release[]): Routes {
  const routes: Routes = new Map();

  for (const guide of GUIDES) {
    routes.set(guide.file, `/guides/${guide.slug}/`);
  }
  for (const release of releases) {
    routes.set(release.file, `/releases/${release.version}/`);
  }

  return routes;
}

function linkPullRequests(html: string): string {
  return html.replace(/\(#(\d+)\)/g, `(<a href="${REPO_URL}/pull/$1">#$1</a>)`);
}

function pullRequestCount(markdown: string): number {
  const section = markdown.split(/^## Pull requests\s*$/m)[1] ?? '';

  return (section.match(/^- .*\(#\d+\)/gm) ?? []).length;
}

function pager(previous: { href: string; label: string; kicker: string } | undefined, next: typeof previous): string {
  const link = (entry: NonNullable<typeof previous>) =>
    `<a href="${entry.href}"><span class="kicker">${entry.kicker}</span><br>${escapeHtml(entry.label)}</a>`;

  return `<div class="pager">${previous ? link(previous) : ''}${next ? link(next) : ''}</div>`;
}

function guidePage(guide: Guide, index: number, routes: Routes): string {
  const markdown = read(guide.file);
  const title = titleOf(markdown);
  const { html, headings } = renderMarkdown(markdown, guide.file, routes);
  const previous = GUIDES[index - 1];
  const next = GUIDES[index + 1];

  const side = GUIDES.map(
    (entry) =>
      `<a${entry === guide ? ' class="on"' : ''} href="/guides/${entry.slug}/">${escapeHtml(titleOf(read(entry.file)).split(':')[0])}</a>`,
  ).join('\n');
  const toc = headings
    .filter((heading) => heading.depth === 2 && heading.text !== 'Contents')
    .map((heading) => `<a href="#${heading.id}">${escapeHtml(heading.text)}</a>`)
    .join('\n');

  const body = `<div class="guide">
<aside class="side" aria-label="Guides">
<span class="kicker">Guides</span>
${side}
</aside>
<article class="prose">
${html}
${pager(
  previous && { href: `/guides/${previous.slug}/`, label: titleOf(read(previous.file)), kicker: 'Previous' },
  next && { href: `/guides/${next.slug}/`, label: titleOf(read(next.file)), kicker: 'Next' },
)}
</article>
<aside class="toc" aria-label="On this page">
<span class="kicker">On this page</span>
<div style="margin-top: 10px">
${toc}
</div>
<div class="edit">
<span class="kicker">Edit</span>
<a href="${REPO_URL}/edit/main/${guide.file}">Improve this page on GitHub</a>
</div>
</aside>
</div>`;

  return page({
    title: `${title} · Crew`,
    description: guide.blurb,
    path: `/guides/${guide.slug}/`,
    section: 'guides',
    body,
    navBar: true,
    flat: true,
  });
}

function guidesIndex(): string {
  const card = (guide: Guide) =>
    `<a class="card" href="/guides/${guide.slug}/"><span class="kicker">${guide.kicker}</span><b>${escapeHtml(titleOf(read(guide.file)))}</b><p>${escapeHtml(guide.blurb)}</p><span class="go">read →</span></a>`;
  const row = (guide: Guide) =>
    `<a class="listrow" href="/guides/${guide.slug}/"><b>${escapeHtml(titleOf(read(guide.file)).split(':')[0])}</b><span>${escapeHtml(guide.blurb)}</span></a>`;

  const body = `<header class="wrap page-head" style="padding-bottom: 40px">
<span class="kicker">Guides</span>
<h1>Everything, written down.</h1>
<p>Start with Voice OS if you want to talk to your sessions, or Set up if you want to know what crew is doing underneath. Every guide works on its own.</p>
</header>
<section class="wrap" aria-label="Main guides">
<div class="grid">
${GUIDES.filter((guide) => guide.featured).map(card).join('\n')}
</div>
</section>
<section class="wrap" aria-label="More" style="padding-top: 56px">
<span class="kicker">More</span>
<div style="margin-top: 12px">
${GUIDES.filter((guide) => !guide.featured).map(row).join('\n')}
</div>
</section>`;

  return page({
    title: 'Guides · Crew',
    description: "crew's guides: Voice OS, Set up, what you can say, and every command.",
    path: '/guides/',
    section: 'guides',
    body,
  });
}

function releasePage(release: Release, index: number, releases: Release[], routes: Routes): string {
  const { html } = renderMarkdown(release.markdown, release.file, routes);
  const older = releases[index + 1];
  const newer = releases[index - 1];
  const count = pullRequestCount(release.markdown);
  const meta = [formatDate(release.date), count > 0 ? `${count} pull request${count === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .map((part) => `<span class="kicker">${part}</span>`)
    .join('<span class="kicker">·</span>');

  const body = `<article class="wrap prose-width prose" style="padding-top: 48px">
<a class="back" href="/releases/">← All releases</a>
<div style="display: flex; align-items: center; gap: 12px; margin: 22px 0 10px; flex-wrap: wrap">${meta}</div>
${linkPullRequests(html)}
<div class="update"><span class="kicker">Update</span><code>crew update</code><span>then restart the server when it suits you</span></div>
${pager(
  older && { href: `/releases/${older.version}/`, label: older.version, kicker: 'Older' },
  newer && { href: `/releases/${newer.version}/`, label: newer.version, kicker: 'Newer' },
)}
</article>`;

  return page({
    title: `v${release.version} · Crew`,
    description: firstSentence(firstParagraph(release.markdown)),
    path: `/releases/${release.version}/`,
    section: 'releases',
    body,
  });
}

function releasesIndex(releases: Release[], routes: Routes): string {
  const latestMajor = releases[0]?.version.split('.')[0];
  const recent = releases.filter((release) => release.version.split('.')[0] === latestMajor);
  const earlier = releases.filter((release) => !recent.includes(release));

  const card = (release: Release, index: number) => {
    const pill =
      index === 0
        ? '<span class="pill latest">latest</span>'
        : release.version.endsWith('.0.0')
          ? '<span class="pill major">major</span>'
          : '';

    return `<div class="rel">
<div class="meta"><a class="ver" href="/releases/${release.version}/">${release.version}</a><span class="date">${formatDate(release.date)}</span>${pill}</div>
<div class="sum"><p>${inlineHtml(firstParagraph(release.markdown), release.file, routes)}</p><a class="more" href="/releases/${release.version}/">Read the notes →</a></div>
</div>`;
  };
  const row = (release: Release) =>
    `<a class="small" href="/releases/${release.version}/"><code>${release.version}</code><span>${escapeHtml(firstSentence(firstParagraph(release.markdown)))}</span></a>`;

  const body = `<header class="wrap narrow page-head">
<span class="kicker">Releases</span>
<h1>What changed, and why.</h1>
<p><code>crew update</code> gets you the latest. A running server keeps its version until you restart it.</p>
</header>
<section class="wrap narrow" aria-label="Recent releases">
${recent.map(card).join('\n')}
</section>
<section class="wrap narrow" aria-label="Earlier" style="padding-top: 40px">
<span class="kicker">Earlier</span>
<div style="margin-top: 12px">
${earlier.map(row).join('\n')}
<a class="small" href="${REPO_URL}/releases"><code>4.x and before</code><span>On GitHub's releases page.</span></a>
</div>
</section>`;

  return page({
    title: 'Releases · Crew',
    description: 'Every crew release since 5.0, what changed and why.',
    path: '/releases/',
    section: 'releases',
    body,
  });
}

function notFoundPage(): string {
  const body = `<header class="wrap page-head" style="padding-top: 120px; align-items: center; text-align: center">
<span class="kicker">404</span>
<h1>Nothing here.</h1>
<p><a href="/">Back to the start</a>, or have a look in the <a href="/guides/">guides</a>.</p>
</header>`;

  return page({ title: 'Not found · Crew', description: 'Nothing here.', path: '/404.html', section: 'home', body });
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><text x="16" y="22" font-family="-apple-system,Segoe UI,sans-serif" font-size="18" font-weight="700" fill="#f5f7fa" text-anchor="middle">C</text></svg>`;

function build(): void {
  const releases = loadReleases();
  const routes = routesFor(releases);

  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

  write('/', landingPage());
  write('/start/', startPage());
  write('/guides/', guidesIndex());
  GUIDES.forEach((guide, index) => write(`/guides/${guide.slug}/`, guidePage(guide, index, routes)));
  write('/releases/', releasesIndex(releases, routes));
  releases.forEach((release, index) => write(`/releases/${release.version}/`, releasePage(release, index, releases, routes)));
  write('/404.html', notFoundPage());

  cpSync(join(SITE_DIR, 'style.css'), join(DIST_DIR, 'style.css'));
  writeFileSync(join(DIST_DIR, 'favicon.svg'), FAVICON);
  if (existsSync(join(REPO_DIR, 'docs/images'))) {
    cpSync(join(REPO_DIR, 'docs/images'), join(DIST_DIR, 'images'), { recursive: true });
  }

  console.log(`site: ${GUIDES.length} guides, ${releases.length} releases → ${DIST_DIR}`);
}

build();
