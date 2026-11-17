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
const site = process.env.SITE_URL ?? 'http://localhost:4399';

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
