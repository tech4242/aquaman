import type { APIRoute, GetStaticPaths } from 'astro';
import { getPages, markdownFor, type Page } from '../lib/site';

export const getStaticPaths: GetStaticPaths = async () =>
  (await getPages()).map((page) => ({ params: { slug: page.slug }, props: { page } }));

export const GET: APIRoute = ({ props }) =>
  new Response(markdownFor(props.page as Page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
