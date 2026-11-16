import type { APIRoute } from 'astro';
import { getPages, markdownFor, homeMarkdownTwin } from '../lib/site';

export const GET: APIRoute = async ({ site }) => {
  const pages = await getPages();
  const parts = [`Source: ${new URL('/index.md', site!).href}\n\n${homeMarkdownTwin(pages)}`];
  for (const p of pages) {
    parts.push(`---\n\nSource: ${new URL(p.twin, site!).href}\n\n${markdownFor(p)}`);
  }
  return new Response(parts.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
