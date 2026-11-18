/**
 * Compliance test: the cryptography aquaman implements itself, against
 * BSI TR-02102-1 "Cryptographic Mechanisms: Recommendations and Key Lengths",
 * Version 2026-01 (23 January 2026).
 *
 * In scope: the `encrypted-file` vault (the one backend whose encryption is
 * aquaman's own code) and the two local tokens. Each test reads the
 * parameter off what the code produces, or re-derives it independently with
 * Node's own primitives, so a silent change to a parameter fails here.
 *
 * Where the recommendation is not met, there is no test here: the difference
 * is recorded in docs/compliance/bsi-tr-02102.md (password-based key
 * derivation uses PBKDF2, the guideline recommends Argon2id).
 *
 * A self-assessment, not a certification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, createBrokerScope, type CredentialProxy } from 'aquaman-proxy';
import { EncryptedFileStore, MemoryStore, encryptWithPassword, decryptWithPassword, generateLoopbackToken } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../../helpers/uds-proxy.js';

const PASSWORD = 'a-long-test-password-for-the-vault';
const PLAINTEXT = JSON.stringify({ 'github:token': { value: 'ghp_example_value_0123456789' } });

interface Parts { salt: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer }

/** The four fields of the vault file: salt, nonce, tag, ciphertext, each base64, joined by `:`. */
function parts(blob: string): Parts {
  const [salt, iv, tag, ciphertext] = blob.split(':').map((p) => Buffer.from(p, 'base64'));
  return { salt, iv, tag, ciphertext };
}

const join = (p: Parts): string => [p.salt, p.iv, p.tag, p.ciphertext].map((b) => b.toString('base64')).join(':');

/** Decrypt with Node's primitives and the parameters named, independent of aquaman's own code. */
function independentDecrypt(blob: string, opts: { iterations: number; digest: string; cipher: string; keyBytes: number }): string {
  const p = parts(blob);
  const key = crypto.pbkdf2Sync(PASSWORD, p.salt, opts.iterations, opts.keyBytes, opts.digest);
  const decipher = crypto.createDecipheriv(opts.cipher, key, p.iv, { authTagLength: 16 } as crypto.CipherGCMOptions) as crypto.DecipherGCM;
  decipher.setAuthTag(p.tag);
  return Buffer.concat([decipher.update(p.ciphertext), decipher.final()]).toString('utf-8');
}

describe('BSI TR-02102-1 (2026-01): the encrypted-file vault', () => {
  const blob = encryptWithPassword(PLAINTEXT, PASSWORD);

  it('section 3.1: the cipher is AES with a 256-bit key, in GCM (section 3.1.2)', () => {
    const good = { iterations: 600_000, digest: 'sha256', cipher: 'aes-256-gcm', keyBytes: 32 };
    expect(independentDecrypt(blob, good)).toBe(PLAINTEXT);
    // The same file does not open as AES-128 or AES-192, so the key really is 256 bits.
    expect(() => independentDecrypt(blob, { ...good, cipher: 'aes-128-gcm', keyBytes: 16 })).toThrow();
    expect(() => independentDecrypt(blob, { ...good, cipher: 'aes-192-gcm', keyBytes: 24 })).toThrow();
  });

  it('section 3.1.2: the GCM nonce is 96 bits', () => {
    expect(parts(blob).iv).toHaveLength(12);
  });

  it('section 3.1.2: the GCM tag written is the full 128 bits (at least 96 are recommended)', () => {
    expect(parts(blob).tag).toHaveLength(16);
  });

  describe('section 3.1.2: a tag shorter than the full 128 bits is refused on read', () => {
    const rows: Array<{ bytes: number; accepted: boolean }> = [
      { bytes: 16, accepted: true },
      { bytes: 15, accepted: false },
      { bytes: 12, accepted: false },
      { bytes: 8, accepted: false },
      { bytes: 4, accepted: false },
      { bytes: 1, accepted: false },
    ];
    for (const row of rows) {
      it(`${row.bytes * 8}-bit tag: ${row.accepted ? 'accepted' : 'refused'}`, () => {
        const p = parts(blob);
        const cut = join({ ...p, tag: p.tag.subarray(0, row.bytes) });
        if (row.accepted) expect(decryptWithPassword(cut, PASSWORD)).toBe(PLAINTEXT);
        else expect(() => decryptWithPassword(cut, PASSWORD)).toThrow(/authentication tag is not 128 bits/);
      });
    }

    it('a longer tag is refused too, and a full-length tag with one bit changed fails authentication', () => {
      const p = parts(blob);
      expect(() => decryptWithPassword(join({ ...p, tag: Buffer.concat([p.tag, Buffer.from([0])]) }), PASSWORD)).toThrow(/not 128 bits/);
      const flipped = Buffer.from(p.tag);
      flipped[0] ^= 1;
      expect(() => decryptWithPassword(join({ ...p, tag: flipped }), PASSWORD)).toThrow();
    });

    it('the vault itself refuses a file whose tag was cut down', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-bsi-'));
      try {
        const file = path.join(dir, 'credentials.enc');
        await new EncryptedFileStore(PASSWORD, file).set('github', 'token', 'ghp_example_value_0123456789');
        const p = parts(fs.readFileSync(file, 'utf-8'));
        fs.writeFileSync(file, join({ ...p, tag: p.tag.subarray(0, 4) }));
        await expect(new EncryptedFileStore(PASSWORD, file).get('github', 'token')).rejects.toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('section 3.1.2: every write uses a fresh nonce and a fresh salt, so a nonce never repeats under one key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-bsi-'));
    try {
      const file = path.join(dir, 'credentials.enc');
      const store = new EncryptedFileStore(PASSWORD, file);
      const seen: Parts[] = [];
      for (let i = 0; i < 4; i++) {
        // The same value each time: nothing about the write depends on the content changing.
        await store.set('github', 'token', 'ghp_example_value_0123456789');
        seen.push(parts(fs.readFileSync(file, 'utf-8')));
      }
      expect(new Set(seen.map((p) => p.iv.toString('hex'))).size).toBe(seen.length);
      expect(new Set(seen.map((p) => p.salt.toString('hex'))).size).toBe(seen.length);
      for (const p of seen) {
        expect(p.iv).toHaveLength(12);
        expect(p.salt.length).toBeGreaterThanOrEqual(16);
        expect(p.tag).toHaveLength(16);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('key derivation: PBKDF2-HMAC-SHA256, 600,000 iterations, a 256-bit key, a random salt of at least 128 bits', () => {
    const good = { iterations: 600_000, digest: 'sha256', cipher: 'aes-256-gcm', keyBytes: 32 };
    expect(independentDecrypt(blob, good)).toBe(PLAINTEXT);
    // One iteration fewer, or another hash, derives a different key: the file does not open.
    expect(() => independentDecrypt(blob, { ...good, iterations: 599_999 })).toThrow();
    expect(() => independentDecrypt(blob, { ...good, digest: 'sha1' })).toThrow();
    expect(() => independentDecrypt(blob, { ...good, digest: 'sha512' })).toThrow();
    expect(parts(blob).salt.length * 8).toBeGreaterThanOrEqual(128);
  });
});

describe('BSI TR-02102-1 (2026-01): local tokens', () => {
  const SOURCE = {
    config: fs.readFileSync(path.resolve('packages/proxy/src/core/utils/config.ts'), 'utf-8'),
    daemon: fs.readFileSync(path.resolve('packages/proxy/src/daemon.ts'), 'utf-8'),
  };
  const TOKEN = 'aqm_lb_bsi_test_token_0123456789abcdef0123456789';
  const REAL_KEY = 'sk_live_real_vault_key_0123456789';
  let proxy: CredentialProxy | undefined;
  let socketPath = '';

  async function start(): Promise<number> {
    const store = new MemoryStore();
    await store.set('stripe', 'secret_key', REAL_KEY);
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['stripe'],
      broker: { ...scope, routedRefs: () => new Set(['aquaman://stripe/secret_key']) },
      loopback: { port: 0, token: TOKEN, host: '127.0.0.1' },
    });
    await proxy.start();
    return Number(proxy.getLoopbackAddress()!.split(':')[1]);
  }

  async function routeToken(): Promise<string> {
    const res = await udsFetch(socketPath, '/broker/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'stripe', key: 'secret_key' }),
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).token as string;
  }

  /** The status the loopback listener answers `GET /_hostmap` with for this token. */
  function loopbackStatus(port: number, token: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let raw = '';
      socket.on('data', (c) => { raw += c; });
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)));
      socket.on('error', reject);
      socket.write(`GET /_hostmap HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nx-aquaman-token: ${token}\r\n\r\n`);
    });
  }

  beforeEach(() => { proxy = undefined; });
  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  it('the loopback token carries 192 random bits (at least 128 are needed), from the system CSPRNG', () => {
    const tokens = Array.from({ length: 32 }, () => generateLoopbackToken());
    for (const t of tokens) expect(t).toMatch(/^aqm_lb_[0-9a-f]{48}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(SOURCE.config).toMatch(/return LOOPBACK_TOKEN_PREFIX \+ crypto\.randomBytes\(24\)\.toString\('hex'\);/);
  });

  it('the route token carries 192 random bits from the system CSPRNG, and is new for every proxy start', async () => {
    await start();
    const first = await routeToken();
    expect(first).toMatch(/^aqm_rt_[0-9a-f]{48}$/);
    await proxy!.stop();
    cleanupSocket(socketPath);
    await start();
    const second = await routeToken();
    expect(second).toMatch(/^aqm_rt_[0-9a-f]{48}$/);
    expect(second).not.toBe(first);
    expect(SOURCE.daemon).toMatch(/routeToken = `aqm_rt_\$\{crypto\.randomBytes\(24\)\.toString\('hex'\)\}`/);
  });

  it('both tokens are compared in constant time, and only an exact match is accepted', async () => {
    // Every comparison of a presented token goes through the one helper, which is crypto.timingSafeEqual.
    expect(SOURCE.daemon).toMatch(/some\(c => timingSafeStrEqual\(c, expected\)\)/);
    expect(SOURCE.daemon).toMatch(/some\(c => timingSafeStrEqual\(c, this\.routeToken\)\)/);
    expect(SOURCE.daemon).toMatch(/function timingSafeStrEqual\([^)]*\): boolean \{[^}]*crypto\.timingSafeEqual\(ab, ab\);[^}]*\}\s*return crypto\.timingSafeEqual\(ab, bb\);/s);
    expect(SOURCE.daemon).not.toMatch(/===\s*(expected|this\.routeToken|this\.options\.loopback\??\.token)\b/);

    const port = await start();
    const rows: Array<{ name: string; token: string; status: number }> = [
      { name: 'the token', token: TOKEN, status: 200 },
      { name: 'a prefix of it', token: TOKEN.slice(0, -1), status: 401 },
      { name: 'the token with one more character', token: `${TOKEN}0`, status: 401 },
      { name: 'the same length, last character different', token: `${TOKEN.slice(0, -1)}X`, status: 401 },
      { name: 'the same length, first character different', token: `X${TOKEN.slice(1)}`, status: 401 },
      { name: 'another case', token: TOKEN.toUpperCase(), status: 401 },
    ];
    for (const row of rows) {
      expect(await loopbackStatus(port, row.token), row.name).toBe(row.status);
    }
  });
});
