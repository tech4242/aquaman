/**
 * Claude Code sandbox compatibility — the coder path's transport invariants.
 *
 * Claude Code 2.1.216 added `sandbox.filesystem.disabled` and 2.1.219 added
 * `sandbox.network.strictAllowlist`, which denies non-allowlisted *hosts* for
 * sandboxed commands without prompting. Our Bash wrapper resolves credentials
 * through the broker, so the question is whether that resolution is an
 * allowlist subject.
 *
 * It is not: the broker speaks HTTP over a Unix Domain Socket, which has no
 * host and no port, so a network allowlist has nothing to match. These tests
 * pin that invariant so a future refactor to a loopback TCP transport (the
 * shape the Hermes path uses) cannot silently make the coder path
 * sandbox-blockable.
 *
 * NOT covered here, deliberately: filesystem sandboxing. The socket lives at
 * `$HOME/.aquaman/proxy.sock`, so a sandbox that hides `$HOME` from the
 * command blocks the broker regardless of network policy. That is a real
 * limitation, empirically unverified against a live sandboxed session, and it
 * is documented rather than asserted away.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrokerClient, defaultSocketPath } from 'aquaman-coder';

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKER_CLIENT_SRC = path.resolve(
  here,
  '../../packages/coder/src/broker-client.ts'
);

describe('Claude Code sandbox compatibility', () => {
  describe('broker transport is a UDS, not a network host', () => {
    it('defaults to a socket path under the home directory', () => {
      const socketPath = defaultSocketPath();
      expect(socketPath.startsWith(os.homedir())).toBe(true);
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
