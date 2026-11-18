/**
 * A stand-in for a HashiCorp Vault server (KV v2) on 127.0.0.1, for tests
 * that run the CLI or the daemon as a child process against the `vault`
 * backend. It answers reads and lists from a table the test fills in and
 * records every request, so a test can assert that no write or delete was
 * ever sent. It changes nothing unless the test sets `acceptWrites`; then a
 * write or delete under aquaman's own prefix (`<mount>/data/aquaman/...`) is
 * kept in the table, which is what aquaman's own records need, and a write
 * anywhere else is still answered 404.
 *
 * It speaks HTTP over a plain socket because Vault's `LIST` method is not
 * one Node's HTTP server accepts.
 */

import * as net from 'node:net';

export interface FakeVault {
  address: string;
  /** Every request received, in order. */
  requests: Array<{ method: string; url: string }>;
  /** `GET <path>` answers `{ data: { data: <fields> } }`. Keys are request paths such as `/v1/secret/data/apps/github`. */
  secrets: Record<string, Record<string, string>>;
  /** `LIST <path>` answers `{ data: { keys } }`. Keys are request paths such as `/v1/secret/metadata/aquaman`. */
  lists: Record<string, string[]>;
  /** Keep writes and deletes of aquaman's own items (`/v1/<mount>/data/aquaman/...`). Off after `reset()`. */
  acceptWrites: boolean;
  /** Requests that would change something, had this been a real server. */
  writes(): Array<{ method: string; url: string }>;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeVault(): Promise<FakeVault> {
  const vault: FakeVault = {
    address: '',
    requests: [],
    secrets: {},
    lists: {},
    acceptWrites: false,
    writes: () => vault.requests.filter((r) => r.method !== 'GET' && r.method !== 'LIST'),
    reset() {
      vault.requests.length = 0;
      vault.secrets = {};
      vault.lists = {};
      vault.acceptWrites = false;
    },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  const sockets = new Set<net.Socket>();

  const OWN = /^\/v1\/[^/]+\/(data|metadata)\/aquaman\//;
  const answer = (method: string, url: string, text: string): { status: number; body: string } => {
    if (vault.acceptWrites && OWN.test(url)) {
      if (method === 'POST' || method === 'PUT') {
        vault.secrets[url] = (JSON.parse(text) as { data: Record<string, string> }).data;
        return { status: 200, body: '{"data":{}}' };
      }
      if (method === 'DELETE') {
        delete vault.secrets[url.replace('/metadata/', '/data/')];
        return { status: 204, body: '' };
      }
    }
    if (method === 'GET' && vault.secrets[url]) return { status: 200, body: JSON.stringify({ data: { data: vault.secrets[url] } }) };
    if (method === 'LIST' && vault.lists[url]) return { status: 200, body: JSON.stringify({ data: { keys: vault.lists[url] } }) };
    return { status: 404, body: '{"errors":[]}' };
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* the client went away */ });
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
        const length = Number(/^content-length:\s*(\d+)/im.exec(head.join('\n'))?.[1] ?? 0);
        if (buffer.length < end + 4 + length) return;
        const text = buffer.subarray(end + 4, end + 4 + length).toString('utf-8');
        buffer = buffer.subarray(end + 4 + length);
        const [method, url] = head[0].split(' ');
        vault.requests.push({ method, url });
        const { status, body } = answer(method, url, text);
        socket.write(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 204 ? 'No Content' : 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vault.address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return vault;
}
