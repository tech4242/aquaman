import type { APIRoute } from 'astro';

// RFC 9116. Reports go through GitHub's private vulnerability reporting; the
// file is rebuilt on every deploy, so the expiry stays a year ahead.
export const GET: APIRoute = ({ site }) => {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  return new Response(
    [
      'Contact: https://github.com/tech4242/aquaman/security/advisories/new',
      `Expires: ${expires}`,
      `Policy: ${new URL('/docs/security/', site!).href}`,
      `Canonical: ${new URL('/.well-known/security.txt', site!).href}`,
      'Preferred-Languages: en',
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
};
