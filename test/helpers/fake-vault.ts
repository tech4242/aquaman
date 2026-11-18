/**
 * A stand-in for a HashiCorp Vault server (KV v2) on 127.0.0.1, for tests
 * that run the CLI or the daemon as a child process against the `vault`
 * backend. It answers reads and lists from a table the test fills in,
 * refuses nothing, changes nothing, and records every request, so a test can
 * assert that no write or delete was ever sent.
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
    writes: () => vault.requests.filter((r) => r.method !== 'GET' && r.method !== 'LIST'),
    reset() {
      vault.requests.length = 0;
      vault.secrets = {};
      vault.lists = {};
    },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  const sockets = new Set<net.Socket>();

  const answer = (method: string, url: string): { status: number; body: string } => {
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
        buffer = buffer.subarray(end + 4 + length);
        const [method, url] = head[0].split(' ');
        vault.requests.push({ method, url });
        const { status, body } = answer(method, url);
        socket.write(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vault.address = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return vault;
}
