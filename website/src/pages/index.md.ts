import type { APIRoute } from 'astro';
import { getPages, homeMarkdownTwin } from '../lib/site';

export const GET: APIRoute = async () =>
  new Response(homeMarkdownTwin(await getPages()), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
