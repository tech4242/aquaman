/**
 * The pages are the repository's own Markdown (docs/, SECURITY.md), which link
 * to each other and to source files by relative path. On the site a link to
 * another published page becomes its route; a link to anything else in the
 * repository becomes its GitHub URL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const GITHUB = 'https://github.com/tech4242/aquaman';

/** Repo-relative Markdown path -> site slug, or null when the file is not a page. */
export function slugForRepoPath(repoPath) {
  if (repoPath === 'SECURITY.md') return 'security';
  if (repoPath === 'docs/PACKAGES.md') return null;
  const m = /^docs\/(.+)\.md$/.exec(repoPath);
  return m ? m[1] : null;
}

/**
 * @param {string} href     link target as written in the Markdown
 * @param {string} fromRepoPath  repo-relative path of the file containing it
 * @param {(slug: string) => string} pageUrl  how to address a page (route or .md twin)
 */
export function resolveDocLink(href, fromRepoPath, pageUrl) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return href;
  const [target, hash = ''] = href.split('#');
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(fromRepoPath), target));
  if (repoPath.startsWith('..')) return href;
  const anchor = hash ? `#${hash}` : '';
  const slug = slugForRepoPath(repoPath);
  if (slug) return pageUrl(slug) + anchor;
  const isDir = !path.posix.extname(repoPath);
  return `${GITHUB}/${isDir ? 'tree' : 'blob'}/main/${repoPath.replace(/\/$/, '')}${anchor}`;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function remarkDocLinks() {
  return (tree, file) => {
    const abs = file.path ?? file.history?.[0];
    if (!abs) return;
    const from = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    walk(tree, (node) => {
      if (node.type === 'link' || node.type === 'definition') {
        node.url = resolveDocLink(node.url, from, (slug) => `/${slug}/`);
      }
    });
  };
}

/** The same rewrite on raw Markdown text, for the .md twins and llms-full.txt. */
export function rewriteMarkdownLinks(markdown, fromRepoPath, pageUrl) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (_, href) => `](${resolveDocLink(href, fromRepoPath, pageUrl)})`);
    })
    .join('\n');
}
