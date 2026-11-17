import type { APIRoute } from 'astro';
import { agentNote } from '../lib/site';

// Agents probe this path. It answers with the short instruction and where the contract is.
export const GET: APIRoute = ({ site }) =>
  new Response(
    [
      '# aquaman, for agents',
      '',
      agentNote(site!),
      '',
      `- Contract (fields, statuses, exit codes, what init changes): ${new URL('/docs/agent-setup.md', site!).href}`,
      `- Index of this site in Markdown: ${new URL('/llms.txt', site!).href}`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
  );
