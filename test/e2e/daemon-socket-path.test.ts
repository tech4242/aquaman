/**
 * E2E: a config directory so deep that the proxy socket's path cannot be
 * bound. The daemon says so and how to fix it, and does not print a stack
 * trace.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_UNIX_SOCKET_PATH, socketPathTooLong } from '../../packages/proxy/src/daemon.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');

describe('proxy socket path', () => {
  it('accepts a path at the limit and refuses one byte more', () => {
    const at = '/' + 'a'.repeat(MAX_UNIX_SOCKET_PATH - 1);
    expect(socketPathTooLong(at)).toBeNull();
    expect(socketPathTooLong(at + 'a')).toContain(`${MAX_UNIX_SOCKET_PATH + 1} bytes`);
    // Bytes, not characters: a name outside ASCII takes more than one.
    expect(socketPathTooLong('/' + 'é'.repeat(60))).not.toBeNull();
  });

  it('aquaman daemon ends with the reason and the fix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqsock-'));
    const dir = path.join(root, 'd'.repeat(120));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'credentials:\n  backend: encrypted-file\n');
    try {
      const r = spawnSync('npx', ['tsx', CLI_PATH, 'daemon'], {
        encoding: 'utf-8',
        timeout: 40_000,
        env: { ...process.env, HOME: root, AQUAMAN_CONFIG_DIR: dir, AQUAMAN_ENCRYPTION_PASSWORD: 'socket-path-test-password', NO_COLOR: '1' },
      });
      const out = r.stdout + r.stderr;
      expect(r.status).toBe(1);
      expect(out).toContain('a Unix socket path can be at most');
      expect(out).toContain('AQUAMAN_CONFIG_DIR');
      expect(out).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
