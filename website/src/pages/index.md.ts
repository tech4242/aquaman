import type { APIRoute } from 'astro';
import { getPages, homeMarkdownTwin } from '../lib/site';

export const GET: APIRoute = async ({ site }) =>
  new Response(homeMarkdownTwin(await getPages(), site!), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
