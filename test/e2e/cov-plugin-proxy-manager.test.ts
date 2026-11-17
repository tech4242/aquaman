/**
 * The plugin's process handling (packages/plugin/src/proxy-manager.ts) against
 * a real child process: a fake `aquaman` on a private PATH that follows the
 * plugin-mode start-up contract (test/helpers/cov-plugin-fake-proxy.ts).
 *
 * Covers what the real-binary test cannot provoke: a proxy that dies before it
 * is ready, one that never becomes ready, one that ignores SIGTERM, a binary
 * that cannot be started or is not installed, and the CLI pass-through helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import {
  createProxyManager,
  findAquamanProxyBinary,
  execAquamanProxyCli,
  execAquamanProxyInteractive,
  type ProxyManager,
} from '../../packages/plugin/src/proxy-manager.js';
import { createFakeProxy, isAlive, snapshotEnv, type FakeProxy } from '../helpers/cov-plugin-fake-proxy.js';

const T = 60_000;

/** A wait that keeps working while setTimeout is faked. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => { clearInterval(timer); resolve(); }, ms);
  });
}

function health(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/_health' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}

describe('plugin proxy-manager with a fake aquaman binary', () => {
  let fake: FakeProxy;
  let restoreEnv: () => void;
  let mgr: ProxyManager | null;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    fake = createFakeProxy();
    mgr = null;
    process.env.PATH = fake.binDir;
    process.env.AQUAMAN_CONFIG_DIR = fake.configDir;
    process.env.AQUAMAN_FAKE_LOG = fake.logPath;
    delete process.env.AQUAMAN_FAKE_MODE;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      if (mgr) await mgr.stop();
      await fake.waitForExit();
    } finally {
      fake.cleanup();
      restoreEnv();
    }
  });

  describe('findAquamanProxyBinary', () => {
    it('finds an executable named aquaman on PATH, in PATH order', () => {
      process.env.PATH = `${fake.emptyDir}:${fake.binDir}`;
      expect(findAquamanProxyBinary()).toBe(fake.binary);
    });

    it('returns null when no PATH directory has one, and with no PATH at all', () => {
      process.env.PATH = fake.emptyDir;
      expect(findAquamanProxyBinary()).toBeNull();
      delete process.env.PATH;
      expect(findAquamanProxyBinary()).toBeNull();
    });

    it('skips a file named aquaman that is not executable', () => {
      fs.writeFileSync(`${fake.emptyDir}/aquaman`, '#!/bin/sh\n', { mode: 0o644 });
      process.env.PATH = fake.emptyDir;
      expect(findAquamanProxyBinary()).toBeNull();
    });
  });

  describe('ProxyManager.start / stop', () => {
    it('becomes ready on the JSON line that says ready, wherever it is in the output, and stops cleanly', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onReady = vi.fn();
      const onExit = vi.fn();
      const onError = vi.fn();
      process.env.OPENAI_API_KEY = 'must-not-reach-the-proxy';
      process.env.GH_TOKEN = 'must-not-reach-the-proxy';
      mgr = createProxyManager({
        config: { backend: 'encrypted-file', vaultAddress: 'https://vault.test:8200', vaultMountPath: 'kv', onePasswordVault: 'Dev' } as any,
        onReady, onExit, onError,
      });
      expect(mgr.isRunning()).toBe(false);
      expect(mgr.getConnectionInfo()).toBeNull();
      expect(mgr.getSocketPath()).toBeNull();

      const info = await mgr.start();
      expect(info).toMatchObject({ ready: true, socketPath: fake.socketPath, backend: 'encrypted-file' });
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onReady).toHaveBeenCalledWith(info);
      expect(mgr.isRunning()).toBe(true);
      expect(mgr.getConnectionInfo()).toBe(info);
      expect(mgr.getSocketPath()).toBe(fake.socketPath);
      expect(await health(fake.socketPath)).toBe(200);

      // The proxy's stderr is passed on, labelled.
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith('[aquaman-proxy]', 'fake proxy: a line on stderr'));

      // Started as `aquaman openclaw plugin-mode`, with the plugin config as
      // AQUAMAN_* and nothing else from this process's environment.
      const [call] = fake.calls();
      expect(call.args).toEqual(['openclaw', 'plugin-mode']);
      expect(call.env).toMatchObject({
        AQUAMAN_BACKEND: 'encrypted-file',
        AQUAMAN_VAULT_ADDRESS: 'https://vault.test:8200',
        AQUAMAN_VAULT_MOUNT_PATH: 'kv',
        AQUAMAN_1PASSWORD_VAULT: 'Dev',
        AQUAMAN_CONFIG_DIR: fake.configDir,
      });
      expect(call.env.OPENAI_API_KEY).toBeUndefined();
      expect(call.env.GH_TOKEN).toBeUndefined();
      expect(call.env.AQUAMAN_VAULT_TOKEN).toBeUndefined();

      // A second start() hands back the running proxy; nothing new is spawned.
      expect(await mgr.start()).toBe(info);
      expect(fake.calls()).toHaveLength(1);

      await mgr.stop();
      expect(isAlive(call.pid)).toBe(false);
      expect(mgr.isRunning()).toBe(false);
      expect(mgr.getSocketPath()).toBeNull();
      expect(onExit).toHaveBeenCalledWith(0);
      expect(onError).not.toHaveBeenCalled();
      // Stopping again is a no-op.
      await expect(mgr.stop()).resolves.toBeUndefined();
    }, T);

    it('two start() calls made together share one process', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mgr = createProxyManager({ config: {} as any });
      const [a, b] = await Promise.all([mgr.start(), mgr.start()]);
      expect(a).toBe(b);
      expect(fake.calls()).toHaveLength(1);
    }, T);

    it('rejects with the install hint, and tells onError, when no binary is installed', async () => {
      process.env.PATH = fake.emptyDir;
      const onError = vi.fn();
      mgr = createProxyManager({ config: {} as any, onError });
      await expect(mgr.start()).rejects.toThrow('aquaman proxy binary not found. Install with: npm install -g aquaman-proxy');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toContain('binary not found');
      expect(mgr.isRunning()).toBe(false);
      expect(fake.calls()).toHaveLength(0);
    }, T);

    it('rejects, and tells onError, when the binary cannot be started', async () => {
      process.env.PATH = fake.brokenDir;
      const onError = vi.fn();
      const broken = createProxyManager({ config: {} as any, onError });
      const err = await broken.start().catch((e) => e);
      expect(err.code).toBe('EACCES');
      expect(onError).toHaveBeenCalledWith(err);
      expect(broken.isRunning()).toBe(false);
      expect(broken.getSocketPath()).toBeNull();

      // There is no process to wait for, so stop() returns instead of waiting for an exit.
      const stopped = await Promise.race([
        broken.stop().then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
      ]);
      expect(stopped).toBe('stopped');
      expect(broken.isRunning()).toBe(false);
    }, T);

    it('rejects with the exit code and the proxy’s own stderr when it dies before it is ready', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.AQUAMAN_FAKE_MODE = 'fail';
      const onExit = vi.fn();
      const onReady = vi.fn();
      mgr = createProxyManager({ config: {} as any, onExit, onReady });
      await expect(mgr.start()).rejects.toThrow(/^Proxy exited with code 3: boom: vault locked/);
      expect(onExit).toHaveBeenCalledWith(3);
      expect(onReady).not.toHaveBeenCalled();
      expect(mgr.isRunning()).toBe(false);
      expect(mgr.getConnectionInfo()).toBeNull();

      // A later start() tries again instead of reusing the failed attempt.
      await expect(mgr.start()).rejects.toThrow('Proxy exited with code 3');
      expect(fake.calls()).toHaveLength(2);
    }, T);

    it('gives up after 10 seconds without a ready line and stops the process it started', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'silent';
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      mgr = createProxyManager({ config: {} as any });
      const outcome = mgr.start().catch((e: Error) => e);
      // Real time passes until the process is up; the manager's clock does not move.
      while (fake.calls().length === 0) await sleep(25);
      await sleep(300);
      const { pid } = fake.calls()[0];

      vi.advanceTimersByTime(9_999);
      expect(isAlive(pid)).toBe(true);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();

      const err = await outcome;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Proxy startup timeout');
      await fake.waitForExit();
      expect(isAlive(pid)).toBe(false);
      expect(mgr.isRunning()).toBe(false);
    }, T);

    it('kills a proxy that ignores SIGTERM after 5 seconds', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.AQUAMAN_FAKE_MODE = 'stubborn';
      const onExit = vi.fn();
      const stubborn = createProxyManager({ config: {} as any, onExit });
      await stubborn.start();
      const { pid } = fake.calls()[0];

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const stopped = stubborn.stop();
      // SIGTERM has been sent, and ignored.
      await sleep(400);
      expect(isAlive(pid)).toBe(true);
      vi.advanceTimersByTime(4_999);
      expect(isAlive(pid)).toBe(true);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();

      await stopped;
      expect(isAlive(pid)).toBe(false);
      expect(stubborn.isRunning()).toBe(false);
      // Killed by a signal: there is no exit code.
      expect(onExit).toHaveBeenLastCalledWith(null);
    }, T);
  });

  describe('execAquamanProxyCli', () => {
    it('runs the binary with the given arguments and returns its output and exit code', async () => {
      process.env.AQUAMAN_FAKE_STDERR = 'a warning';
      process.env.AQUAMAN_FAKE_EXIT = '4';
      process.env.ANTHROPIC_API_KEY = 'must-not-reach-the-cli';
      const result = await execAquamanProxyCli(['openclaw', 'doctor']);
      expect(result).toEqual({ stdout: 'ran: openclaw doctor\n', stderr: 'a warning\n', exitCode: 4 });
      const [call] = fake.calls();
      expect(call.args).toEqual(['openclaw', 'doctor']);
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.AQUAMAN_CONFIG_DIR).toBe(fake.configDir);
    }, T);

    it('rejects with the install hint when no binary is installed', async () => {
      process.env.PATH = fake.emptyDir;
      await expect(execAquamanProxyCli(['credentials', 'list'])).rejects.toThrow('aquaman proxy binary not found. Install with: npm install -g aquaman-proxy');
    }, T);

    it('rejects when the binary cannot be started', async () => {
      process.env.PATH = fake.brokenDir;
      await expect(execAquamanProxyCli(['credentials', 'list'])).rejects.toMatchObject({ code: 'EACCES' });
    }, T);

    it('stops a command that outlives its timeout', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'hang';
      await expect(execAquamanProxyCli(['audit', 'tail'], { timeoutMs: 5000 })).rejects.toThrow('aquaman CLI timed out after 5000ms');
      await fake.waitForExit();
      expect(isAlive(fake.calls()[0].pid)).toBe(false);
    }, T);
  });

  describe('execAquamanProxyInteractive', () => {
    it('runs the binary on the caller’s terminal and resolves with its exit code', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'quiet';
      process.env.AWS_SECRET_ACCESS_KEY = 'must-not-reach-the-cli';
      expect(await execAquamanProxyInteractive(['credentials', 'add', 'anthropic', 'api_key'])).toBe(0);
      process.env.AQUAMAN_FAKE_EXIT = '2';
      expect(await execAquamanProxyInteractive(['openclaw', 'setup'])).toBe(2);
      const calls = fake.calls();
      expect(calls.map((c) => c.args)).toEqual([['credentials', 'add', 'anthropic', 'api_key'], ['openclaw', 'setup']]);
      expect(calls[0].env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    }, T);

    it('rejects with the install hint when no binary is installed, and when it cannot be started', async () => {
      process.env.PATH = fake.emptyDir;
      await expect(execAquamanProxyInteractive(['openclaw', 'setup'])).rejects.toThrow('aquaman proxy binary not found');
      process.env.PATH = fake.brokenDir;
      await expect(execAquamanProxyInteractive(['openclaw', 'setup'])).rejects.toMatchObject({ code: 'EACCES' });
    }, T);
  });
});
