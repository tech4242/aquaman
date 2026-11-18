/**
 * A local server that stands in for the vendors a routed app calls. It
 * answers each known path with a body the vendor's own client library
 * accepts, and only when the request carries the real credential for that
 * vendor: anything else, a route token included, gets the vendor's 401.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface VendorRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface VendorUpstream {
  port: number;
  requests: VendorRequest[];
  /** Requests whose path starts with the prefix. */
  seen(prefix: string): VendorRequest[];
  clear(): void;
  stop(): Promise<void>;
}

interface Route {
  method: string;
  path: string;
  /** Header that must carry the real credential, and its exact value. */
  auth: [header: string, value: string];
  reply: unknown;
}

export async function startVendorUpstream(credentials: {
  anthropic: string;
  openai: string;
  github: string;
  stripe: string;
  slack: string;
  zendeskUser: string;
  zendeskPassword: string;
}): Promise<VendorUpstream> {
  const basic = `Basic ${Buffer.from(`${credentials.zendeskUser}:${credentials.zendeskPassword}`).toString('base64')}`;
  const routes: Route[] = [
    {
      method: 'POST', path: '/v1/messages', auth: ['x-api-key', credentials.anthropic],
      reply: { id: 'msg_local', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'routed through the proxy' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 9, output_tokens: 5 } },
    },
    {
      method: 'POST', path: '/v1/chat/completions', auth: ['authorization', `Bearer ${credentials.openai}`],
      reply: { id: 'chatcmpl_local', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'routed' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    },
    { method: 'GET', path: '/user', auth: ['authorization', `Bearer ${credentials.github}`], reply: { login: 'octocat', id: 1 } },
    {
      method: 'GET', path: '/v1/customers', auth: ['authorization', `Bearer ${credentials.stripe}`],
      reply: { object: 'list', url: '/v1/customers', has_more: false, data: [{ id: 'cus_local_1', object: 'customer' }] },
    },
    { method: 'POST', path: '/v1/refunds', auth: ['authorization', `Bearer ${credentials.stripe}`], reply: { id: 're_local_1', object: 'refund' } },
    {
      method: 'POST', path: '/api/chat.postMessage', auth: ['authorization', `Bearer ${credentials.slack}`],
      reply: { ok: true, channel: 'C0SUPPORT', ts: '1700000000.000100', message: { text: 'Ticket 42 answered.' } },
    },
    { method: 'GET', path: '/api/v2/tickets.json', auth: ['authorization', basic], reply: { tickets: [{ id: 42, subject: 'Refund request' }], count: 1 } },
  ];

  const requests: VendorRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body });
      const route = routes.find((r) => r.method === req.method && r.path === path);
      res.setHeader('Content-Type', 'application/json');
      if (!route) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found', ok: false }));
        return;
      }
      if (req.headers[route.auth[0]] !== route.auth[1]) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'invalid credential', ok: false, type: 'error' }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify(route.reply));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    seen: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    clear: () => { requests.length = 0; },
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
