/**
 * UDS test helper - creates temp socket paths and makes requests over Unix domain sockets
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

export function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-test-'));
  return path.join(dir, 'proxy.sock');
}

export function cleanupSocket(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch { /* already removed */ }
  try {
    fs.rmdirSync(path.dirname(socketPath));
  } catch { /* not empty or already removed */ }
}

export async function udsFetch(socketPath: string, urlPath: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: init?.method || 'GET',
        headers: init?.headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on('error', reject);

    if (init?.body) {
      req.write(init.body);
    }
    req.end();
  });
}
