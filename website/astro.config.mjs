// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { remarkDocLinks } from './src/lib/links.mjs';
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

export default defineConfig({
  site,
  // Canonical URLs end in a slash; the dev server also answers without one.
  trailingSlash: 'ignore',
  server: { host: '127.0.0.1', port: 4399 },
  // Pages for earlier releases point at the current page as canonical, so they stay out of the sitemap.
  integrations: [sitemap({ filter: (page) => !/\/docs\/\d+\.\d+\.\d+\//.test(page) })],
  markdown: {
    processor: unified({ remarkPlugins: [remarkDocLinks] }),
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark-dimmed' } },
  },
});
