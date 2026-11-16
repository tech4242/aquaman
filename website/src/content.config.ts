import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

// The repository's Markdown is the content. Nothing is copied into the site.
const pages = defineCollection({
  loader: glob({ base: '..', pattern: ['docs/**/*.md', 'SECURITY.md', '!docs/PACKAGES.md'] }),
});

export const collections = { pages };
