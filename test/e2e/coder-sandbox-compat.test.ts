/**
 * Claude Code sandbox compatibility: the coder path's transport invariants.
 *
 * The broker speaks HTTP over a Unix Domain Socket. That keeps it out of the
 * sandbox's HOST allowlists (`sandbox.network.allowedDomains`,
 * `strictAllowlist` from 2.1.219), which have no host or port to match, and
 * the first block below pins that so a refactor to loopback TCP (the Hermes
 * transport) can't quietly turn the broker into a domain-allowlist subject.
 *
 * But a UDS is NOT exempt from the sandbox. Corrected in v0.15.0 (v0.14.1 said
 * otherwise): Claude Code's sandbox denies every Unix-socket connect unless
 * the path is in `sandbox.network.allowUnixSockets` (macOS) or
 * `allowAllUnixSockets` is set (the only option on Linux/WSL2, where seccomp
 * can't filter by path). Verified 2026-09-18 with @anthropic-ai/sandbox-runtime
 * 0.0.76, the runtime Claude Code embeds: default settings → `connect EPERM`;
 * the exact socket path or its parent directory → allowed; glob entries →
 * still EPERM. Filesystem read rules never gate the connect. So
 * `aquaman coder setup claude-code` allowlists the socket on macOS (unit
 * tests: coder-claude-code-setup.test.ts), and a blocked connect surfaces as
 * a sandbox hint instead of a bare errno (below).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { BrokerClient, BrokerError, defaultSocketPath } from 'aquaman-coder';

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKER_CLIENT_SRC = path.resolve(
  here,
  '../../packages/coder/src/broker-client.ts'
);

describe('Claude Code sandbox compatibility', () => {
  describe('broker transport is a UDS, not a network host', () => {
    it('defaults to the daemon socket path (honoring AQUAMAN_CONFIG_DIR)', () => {
      const socketPath = defaultSocketPath();
      const configDir = process.env['AQUAMAN_CONFIG_DIR'] || path.join(os.homedir(), '.aquaman');
      expect(socketPath).toBe(path.join(configDir, 'proxy.sock'));
      expect(path.extname(socketPath)).toBe('.sock');
      // A path, never a URL — nothing for a host allowlist to evaluate.
      expect(socketPath).not.toMatch(/^https?:\/\//);
    });

    it('never dials a host or port', () => {
      const src = fs.readFileSync(BROKER_CLIENT_SRC, 'utf-8');
      // http.request is called with { socketPath }, never { host, port }.
      expect(src).toContain('socketPath:');
      expect(src).not.toMatch(/\bhost\s*:/);
      expect(src).not.toMatch(/\bport\s*:/);
      // No loopback literals — the Hermes path uses TCP, the coder path must not.
      expect(src).not.toContain('127.0.0.1');
      expect(src).not.toContain('localhost');
    });

    it('rejects a socket path that is actually a URL', async () => {
      // Guards against a config/refactor mistake turning the UDS dial into a
      // network dial, which WOULD become an allowlist subject.
      const broker = new BrokerClient({
        socketPath: 'http://127.0.0.1:8585',
        timeoutMs: 500,
      });
      await expect(
        broker.resolve({ service: 'anthropic', key: 'api_key' })
      ).rejects.toThrow();
    });
  });

  describe('a blocked socket connect explains the sandbox, not just the errno', () => {
    // An owner-inaccessible socket makes connect() fail with EACCES, the same
    // errno class the sandbox produces (EPERM on macOS Seatbelt; EPERM/EACCES
    // under Linux seccomp).
    it.skipIf(process.getuid?.() === 0)('maps EACCES/EPERM to the sandbox hint with code socket_blocked', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqsb-'));
      const sock = path.join(dir, 'p.sock');
      const server = http.createServer((_req, res) => res.end('{}'));
      await new Promise<void>((resolve) => server.listen(sock, resolve));
      try {
        fs.chmodSync(sock, 0o000);
        const err = await new BrokerClient({ socketPath: sock, timeoutMs: 1000 }).health().catch((e) => e);
        expect(err).toBeInstanceOf(BrokerError);
        expect(err.code).toBe('socket_blocked');
        expect(err.message).toContain('sandbox');
        expect(err.message).toContain('aquaman coder setup claude-code');
        expect(err.message).toContain('allowAllUnixSockets');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('hook output carries no network configuration', () => {
    it('does not inject proxy env vars that a sandbox would need allowlisted', async () => {
      const { handlePreToolUse } = await import('aquaman-coder');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-sandbox-'));
      try {
        const out = await handlePreToolUse({
          session_id: 'sandbox-compat',
          transcript_path: path.join(tmpDir, 'transcript.jsonl'),
          cwd: tmpDir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'echo hi' },
        });
        const serialized = JSON.stringify(out ?? {});
        // The wrapper rewrites the command; it must not hand Claude Code a
        // base URL or proxy host that sandbox networking would then gate.
        expect(serialized).not.toContain('HTTP_PROXY');
        expect(serialized).not.toContain('HTTPS_PROXY');
        expect(serialized).not.toContain('127.0.0.1');
        expect(serialized).not.toContain('aquaman.local');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
