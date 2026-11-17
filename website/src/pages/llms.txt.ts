import type { APIRoute } from 'astro';
import { getPages, llmsIndex } from '../lib/site';

export const GET: APIRoute = async ({ site }) =>
  new Response(llmsIndex(await getPages(), site!), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
