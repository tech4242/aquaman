import type { APIRoute } from 'astro';
import { AGENT_NOTE } from '../lib/site';

// Agents probe this path. It answers with the short instruction and where the contract is.
export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      '# aquaman, for agents',
      '',
      AGENT_NOTE,
      '',
      'Needs aquaman 0.18.0 or later. Write the app to read its keys from the environment as usual.',
      '',
      `- Contract (fields, statuses, exit codes, what init changes): ${new URL('/agent-setup.md', site!).href}`,
      `- Index of this site in Markdown: ${new URL('/llms.txt', site!).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
  );
