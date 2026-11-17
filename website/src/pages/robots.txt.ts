import type { APIRoute } from 'astro';

// Everything here is meant to be read, by people, crawlers and agents alike.
export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${new URL('/sitemap-index.xml', site!).href}`,
      `# Markdown index for language models: ${new URL('/llms.txt', site!).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
