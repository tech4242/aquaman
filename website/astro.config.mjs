// @ts-check
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { remarkDocLinks } from './src/lib/links.mjs';
import { remarkDiagrams } from './src/lib/diagram.mjs';
import { prepareVersions } from './src/lib/versions.mjs';

// Docs of earlier releases are copied out of git before content is loaded.
prepareVersions();

// The public origin. Set SITE_URL for a real build; every absolute URL the
// site prints (canonical, sitemap, llms.txt, the .md twins) is built from it.
// On Vercel without SITE_URL, the project's production domain is used. A
// hosted build must never print the local address.
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const site = process.env.SITE_URL ?? (vercelHost ? `https://${vercelHost}` : 'http://localhost:4399');
if (process.env.VERCEL && site.includes('localhost')) {
  throw new Error('Set SITE_URL: a build on Vercel has no public address to print.');
}

// When the source of a docs page last changed, from git, for the sitemap. Other pages get no date.
function lastChanged(pathname) {
  const slug = /^\/docs\/(.+)\/$/.exec(pathname)?.[1];
  if (!slug) return undefined;
  try {
    const file = slug === 'security' ? 'SECURITY.md' : `docs/${slug}.md`;
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  site,
  // Canonical URLs end in a slash; the dev server also answers without one.
  trailingSlash: 'ignore',
  server: { host: '127.0.0.1', port: 4399 },
  // Pages for earlier releases point at the current page as canonical, so they stay out of the sitemap.
  integrations: [
    sitemap({
      filter: (page) => !/\/docs\/\d+\.\d+\.\d+\//.test(page),
      serialize: (item) => ({ ...item, lastmod: lastChanged(new URL(item.url).pathname) }),
    }),
  ],
  markdown: {
    processor: unified({ remarkPlugins: [remarkDocLinks, remarkDiagrams] }),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark-dimmed' } },
  },
});
