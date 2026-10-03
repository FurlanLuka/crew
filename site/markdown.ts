import { posix } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { REPO_URL } from './layout';

export type Heading = { depth: number; id: string; text: string };

export type Rendered = { html: string; headings: Heading[] };

// Repo path of a markdown file → its URL on the site; anything else in the repo links to GitHub.
export type Routes = Map<string, string>;

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

// GitHub's anchor rule, so the docs' existing #links keep working on the site.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]/g, '');
}

export function rewriteHref(href: string, sourcePath: string, routes: Routes): string {
  if (href.startsWith('#') || EXTERNAL.test(href)) {
    return href;
  }

  const hashAt = href.indexOf('#');
  const target = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const repoPath = posix.normalize(posix.join(posix.dirname(sourcePath), target));

  const route = routes.get(repoPath);
  if (route) {
    return route + hash;
  }
  if (repoPath.startsWith('docs/images/')) {
    return `/images/${repoPath.slice('docs/images/'.length)}`;
  }

  return `${REPO_URL}/blob/main/${repoPath}${hash}`;
}

export function renderMarkdown(markdown: string, sourcePath: string, routes: Routes): Rendered {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true });

  marked.use({
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        token.href = rewriteHref(token.href, sourcePath, routes);
      }
    },
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const base = slugify(plainText(text));
        const count = seen.get(base) ?? 0;
        const id = count === 0 ? base : `${base}-${count}`;

        seen.set(base, count + 1);
        headings.push({ depth, id, text: plainText(text) });

        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });

  // GFM autolinks the git@github.com in clone URLs as an email address.
  const html = marked.parse(markdown, { async: false }).replace(/<a href="mailto:[^"]*">([^<]*)<\/a>/g, '$1');

  return { html, headings };
}

// The first paragraph, for a release's summary in the list.
export function firstParagraph(markdown: string): string {
  const token = new Marked().lexer(markdown).find((candidate) => candidate.type === 'paragraph');

  return token ? token.raw.trim() : '';
}

export function inlineHtml(markdown: string, sourcePath: string, routes: Routes): string {
  const marked = new Marked({
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        token.href = rewriteHref(token.href, sourcePath, routes);
      }
    },
  });

  return marked.parseInline(markdown, { async: false });
}

export function firstSentence(markdown: string): string {
  const text = plainText(markdown).replace(/\s+/g, ' ').trim();
  const end = text.search(/[.!?](\s|$)/);

  return end === -1 ? text : text.slice(0, end + 1);
}
