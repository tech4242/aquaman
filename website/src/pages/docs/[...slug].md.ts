import type { APIRoute, GetStaticPaths } from 'astro';
import { getPages, getVersions, markdownFor, type Page } from '../../lib/site';

export const getStaticPaths: GetStaticPaths = async () => {
  const paths = [];
  for (const version of [null, ...getVersions().archived]) {
    for (const page of await getPages(version)) {
      paths.push({ params: { slug: version ? `${version}/${page.slug}` : page.slug }, props: { page } });
    }
  }
  return paths;
};

export const GET: APIRoute = ({ props }) =>
  new Response(markdownFor(props.page as Page), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
