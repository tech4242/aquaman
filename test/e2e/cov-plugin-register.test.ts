/**
 * The OpenClaw plugin entry (packages/plugin/index.ts), called the way the
 * gateway calls it: `register(api)` with a hand-built api object, in every
 * `registrationMode`. No gateway is started. The proxy the plugin spawns is the
 * fake `aquaman` from test/helpers/cov-plugin-fake-proxy.ts, found on a private
 * PATH; HOME and OPENCLAW_STATE_DIR point into a temp directory.
 *
 * The contract under test (AGENTS.md, "OpenClaw integration"): register
 * everything in every mode, do side effects (files, process env, logs) only on
 * a full load; never set sentinel URLs without a proxy; the interceptor covers
 * only the services the operator configured.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { Command } from 'commander';
import { createFakeProxy, isAlive, snapshotEnv, type FakeProxy } from '../helpers/cov-plugin-fake-proxy.js';

const T = 60_000;
const PLUGIN_VERSION = JSON.parse(fs.readFileSync(path.resolve('packages/plugin/package.json'), 'utf-8')).version as string;
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GITHUB_API_URL', 'CLOUDFLARE_AI_BASE_URL', 'SLACK_BASE_URL'];

type Logs = { info: string[]; warn: string[]; error: string[] };

function makeApi(opts: { mode?: string; config?: unknown; version?: string; cli?: boolean } = {}) {
  const logs: Logs = { info: [], warn: [], error: [] };
  const logger = {
    info: (m: string) => { logs.info.push(m); },
    warn: (m: string) => { logs.warn.push(m); },
    error: (m: string) => { logs.error.push(m); },
  };
  const services: any[] = [];
  const commands: any[] = [];
  const tools: Array<{ factory: () => any; opts: { names: string[] } }> = [];
  const cli: Array<{ fn: (o: { program: any }) => void; opts: { commands: string[] } }> = [];
  const api: any = {
    logger,
    pluginConfig: opts.config,
    registerService: (def: any) => { services.push(def); },
    registerCommand: (def: any) => { commands.push(def); },
    registerTool: (factory: () => any, o: { names: string[] }) => { tools.push({ factory, opts: o }); },
  };
  if (opts.mode !== undefined) api.registrationMode = opts.mode;
  if (opts.version !== undefined) api.runtime = { version: opts.version };
  if (opts.cli !== false) api.registerCli = (fn: any, o: any) => { cli.push({ fn, opts: o }); };
  return { api, logs, logger, services, commands, tools, cli };
}

describe('aquaman-plugin register(api)', () => {
  let fake: FakeProxy;
  let restoreEnv: () => void;
  let home: string;
  let stateDir: string;
  let realFetch: typeof globalThis.fetch;
  let started: Array<{ stop(ctx: any): Promise<void> | void }>;
  let servers: http.Server[];

  const profilesPath = () => path.join(stateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
  const defaultSock = () => path.join(home, '.aquaman', 'proxy.sock');

  /** A fresh copy of the plugin: its proxy, interceptor and socket live in module state. */
  async function loadPlugin() {
    vi.resetModules();
    return (await import('aquaman-plugin')).default as { id: string; name: string; version: string; description: string; register(api: any): void };
  }

  async function register(opts: Parameters<typeof makeApi>[0] = {}) {
    const plugin = await loadPlugin();
    const made = makeApi(opts);
    plugin.register(made.api);
    return { plugin, ...made };
  }

  async function status(made: { tools: Array<{ factory: () => any }> }) {
    return (await made.tools[0].factory().execute('call-1', {})).details;
  }

  async function startService(made: ReturnType<typeof makeApi>) {
    const service = made.services[0];
    started.push(service);
    await service.start({ logger: made.logger });
    return service;
  }

  /** An "already running" proxy on the default socket, in this process. */
  function listenOnDefaultSocket(hostMap: Record<string, string>, version = PLUGIN_VERSION): Promise<void> {
    fs.mkdirSync(path.dirname(defaultSock()), { recursive: true });
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/_health') return res.end(JSON.stringify({ status: 'ok', version }));
      if (req.url === '/_hostmap') return res.end(JSON.stringify(hostMap));
      res.statusCode = 404;
      res.end('{}');
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(defaultSock(), () => resolve()));
  }

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    realFetch = globalThis.fetch;
    fake = createFakeProxy();
    home = path.join(fake.base, 'h');
    stateDir = path.join(fake.base, 'oc');
    fs.mkdirSync(home);
    fs.mkdirSync(stateDir);
    started = [];
    servers = [];
    process.env.HOME = home;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.PATH = fake.binDir;
    process.env.AQUAMAN_CONFIG_DIR = fake.configDir;
    process.env.AQUAMAN_FAKE_LOG = fake.logPath;
    process.env.AQUAMAN_FAKE_VERSION = PLUGIN_VERSION;
    delete process.env.AQUAMAN_FAKE_MODE;
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    try {
      for (const s of started) await s.stop({ logger: { info() {}, warn() {}, error() {} } });
      await fake.waitForExit();
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    } finally {
      globalThis.fetch = realFetch;
      fake.cleanup();
      restoreEnv();
    }
  });

  it('describes itself with the id of the manifest and the version of its package.json', async () => {
    const plugin = await loadPlugin();
    const manifest = JSON.parse(fs.readFileSync(path.resolve('packages/plugin/openclaw.plugin.json'), 'utf-8'));
    expect(plugin.id).toBe('aquaman-plugin');
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.version).toBe(PLUGIN_VERSION);
    expect(plugin.name).toContain('Aquaman');
    expect(typeof plugin.register).toBe('function');
  });

  // ---------------- registration modes ----------------

  describe.each(['discovery', 'tool-discovery'])('registrationMode "%s"', (mode) => {
    it('registers the service, command, CLI and tool, and touches nothing', async () => {
      const made = await register({ mode, version: '2026.5.1' });

      expect(made.services.map((s) => s.id)).toEqual(['aquaman-proxy']);
      expect(made.commands.map((c) => c.name)).toEqual(['aquaman-status']);
      expect(made.commands[0]).toMatchObject({ acceptsArgs: false, requireAuth: true });
      expect(made.cli.map((c) => c.opts)).toEqual([{ commands: ['aquaman'] }]);
      expect(made.tools.map((t) => t.opts)).toEqual([{ names: ['aquaman_status'] }]);
      expect(made.tools[0].factory().name).toBe('aquaman_status');

      // No logs, no env, no files, no process.
      expect(made.logs).toEqual({ info: [], warn: [], error: [] });
      for (const k of ENV_KEYS) expect(process.env[k]).toBeUndefined();
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(fs.readdirSync(home)).toEqual([]);
      expect(fake.calls()).toEqual([]);
      expect(globalThis.fetch).toBe(realFetch);
    });

    it('stays silent when the proxy is not installed, and still registers the command, CLI and tool', async () => {
      process.env.PATH = fake.emptyDir;
      const made = await register({ mode });
      expect(made.services).toEqual([]);
      expect(made.commands.map((c) => c.name)).toEqual(['aquaman-status']);
      expect(made.cli).toHaveLength(1);
      expect(made.tools.map((t) => t.opts.names)).toEqual([['aquaman_status']]);
      expect(made.logs).toEqual({ info: [], warn: [], error: [] });
      expect(fs.readdirSync(stateDir)).toEqual([]);
    });
  });

  describe.each([['full', 'full'], ['absent (older hosts)', undefined]])('registrationMode %s', (_label, mode) => {
    it('registers everything and does the load-time side effects', async () => {
      const made = await register({ mode, version: '2026.5.1', config: { services: ['anthropic', 'openai', 'github', 'cloudflare-ai'] } });

      expect(made.services.map((s) => s.id)).toEqual(['aquaman-proxy']);
      expect(made.commands.map((c) => c.name)).toEqual(['aquaman-status']);
      expect(made.cli.map((c) => c.opts)).toEqual([{ commands: ['aquaman'] }]);
      expect(made.tools.map((t) => t.opts)).toEqual([{ names: ['aquaman_status'] }]);
      expect(made.logs.info[0]).toBe('Aquaman plugin loaded');
      expect(made.logs.info.at(-1)).toBe('Aquaman plugin registered successfully');
      expect(made.logs.info).toContain('aquaman proxy found, will start proxy on gateway start');
      expect(made.logs.warn).toEqual([]);

      // Sentinel URLs for the configured services, each under the name its client reads.
      expect(process.env.ANTHROPIC_BASE_URL).toBe('http://aquaman.local/anthropic');
      expect(process.env.OPENAI_BASE_URL).toBe('http://aquaman.local/openai');
      expect(process.env.GITHUB_API_URL).toBe('http://aquaman.local/github');
      expect(process.env.CLOUDFLARE_AI_BASE_URL).toBe('http://aquaman.local/cloudflare-ai');
      expect(made.logs.info).toContain('Set GITHUB_API_URL=http://aquaman.local/github');

      // Placeholder profiles for the two LLM providers only, private to the user, never a key.
      const profiles = JSON.parse(fs.readFileSync(profilesPath(), 'utf-8'));
      expect(profiles).toEqual({
        version: 1,
        profiles: {
          'anthropic:default': { type: 'api_key', provider: 'anthropic', key: 'aquaman-proxy-managed' },
          'openai:default': { type: 'api_key', provider: 'openai', key: 'aquaman-proxy-managed' },
        },
        order: { anthropic: ['anthropic:default'], openai: ['openai:default'] },
      });
      expect(fs.statSync(profilesPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(profilesPath())).mode & 0o777).toBe(0o700);

      // Registering starts no process; that waits for the gateway to start the service.
      expect(fake.calls()).toEqual([]);
      expect(globalThis.fetch).toBe(realFetch);
    });
  });

  it('defaults to anthropic and openai when the plugin has no config', async () => {
    const made = await register({ mode: 'full' });
    expect(process.env.ANTHROPIC_BASE_URL).toBe('http://aquaman.local/anthropic');
    expect(process.env.OPENAI_BASE_URL).toBe('http://aquaman.local/openai');
    expect(process.env.GITHUB_API_URL).toBeUndefined();
    expect((await status(made)).services).toEqual(['anthropic', 'openai']);
  });

  // ---------------- auth-profiles.json ----------------

  describe('legacy auth-profiles.json', () => {
    it('leaves an existing file alone', async () => {
      fs.mkdirSync(path.dirname(profilesPath()), { recursive: true });
      fs.writeFileSync(profilesPath(), '{"mine":true}');
      const made = await register({ mode: 'full', version: '2026.5.1' });
      expect(fs.readFileSync(profilesPath(), 'utf-8')).toBe('{"mine":true}');
      expect(made.logs.info.join('\n')).not.toContain('Generated auth-profiles.json');
    });

    it.each(['2026.6.5', '2026.9.1-beta.2', '2026.11.3', '2027.1.1'])('is not written on gateway %s, which reads SecretRefs; setup is named instead', async (version) => {
      const made = await register({ mode: 'full', version });
      expect(fs.existsSync(profilesPath())).toBe(false);
      expect(made.logs.warn).toHaveLength(1);
      expect(made.logs.warn[0]).toContain(`OpenClaw ${version} reads provider credentials from SecretRefs`);
      expect(made.logs.warn[0]).toContain('aquaman openclaw setup');
    });

    it.each(['2026.6.4', '2026.5.30', '2025.12.9', 'dev', undefined])('is written on gateway %s (older, or a version it cannot read)', async (version) => {
      const made = await register({ mode: 'full', version });
      expect(fs.existsSync(profilesPath())).toBe(true);
      expect(made.logs.warn).toEqual([]);
      expect(made.logs.info).toContain(`Generated auth-profiles.json with placeholder keys at ${profilesPath()}`);
    });

    it('is skipped when openclaw.json carries the aquaman SecretRef provider, whatever the version', async () => {
      fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({
        secrets: { providers: { aquaman: { source: 'exec', pluginIntegration: { pluginId: 'aquaman-plugin' } } } },
      }));
      const made = await register({ mode: 'full', version: '2026.5.1' });
      expect(fs.existsSync(profilesPath())).toBe(false);
      expect(made.logs.info).toContain('SecretRef wiring active — skipping legacy auth-profiles.json generation');
      expect(made.logs.warn).toEqual([]);
    });

    it('a SecretRef provider that belongs to another plugin does not count', async () => {
      fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({
        secrets: { providers: { aquaman: { source: 'exec', pluginIntegration: { pluginId: 'someone-else' } } } },
      }));
      await register({ mode: 'full', version: '2026.5.1' });
      expect(fs.existsSync(profilesPath())).toBe(true);
    });

    it('is not written when the operator set autoGenerateAuthProfiles: false', async () => {
      const made = await register({ mode: 'full', version: '2026.5.1', config: { autoGenerateAuthProfiles: false } });
      expect(fs.existsSync(profilesPath())).toBe(false);
      expect(made.logs.info).toContain('auto-generation of auth-profiles.json disabled by plugin config');
    });
  });

  // ---------------- sentinel env vars ----------------

  it('sets no sentinel URL for a provider openclaw.json already routes to a loopback listener', async () => {
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({
      models: {
        providers: {
          anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' },
          // Not loopback: the user's own endpoint is not "routed by aquaman".
          openai: { baseUrl: 'https://llm.internal.example/v1' },
          mistral: { baseUrl: 'http://[::1]:8585/mistral' },
        },
      },
    }));
    const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['anthropic', 'openai', 'mistral'] } });
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.MISTRAL_BASE_URL).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBe('http://aquaman.local/openai');
    expect(made.logs.info.find((m) => m.startsWith('Model traffic for'))).toContain('anthropic, mistral');
  });

  it('with no proxy installed: warns with the install steps, sets no sentinel URL, registers no service', async () => {
    process.env.PATH = fake.emptyDir;
    const made = await register({ mode: 'full', version: '2026.9.37' });
    expect(made.services).toEqual([]);
    expect(made.logs.warn).toContain('aquaman proxy not found. Install with: npm install -g aquaman-proxy');
    expect(made.logs.warn).toContain('Then run: aquaman openclaw setup');
    // A sentinel URL with nothing behind it would break every API call.
    for (const k of ENV_KEYS) expect(process.env[k]).toBeUndefined();

    const s = await status(made);
    expect(s).toMatchObject({
      cliInstalled: false,
      proxyRunning: false,
      httpInterceptorActive: false,
      socketPath: defaultSock(),
      fix: 'Run: npm install -g aquaman-proxy && aquaman openclaw setup',
      environmentVariables: { ANTHROPIC_BASE_URL: null, OPENAI_BASE_URL: null },
    });
  });

  // ---------------- status surfaces ----------------

  it('the status tool and the /aquaman-status command report the same thing, before the proxy is started', async () => {
    const made = await register({ mode: 'full', version: '2026.5.1' });
    const tool = made.tools[0].factory();
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, required: [] });
    const result = await tool.execute('call-1', {});
    expect(result.details).toEqual({
      cliInstalled: true,
      proxyRunning: false,
      socketPath: defaultSock(),
      services: ['anthropic', 'openai'],
      httpInterceptorActive: false,
      fix: 'Run: aquaman openclaw setup',
      environmentVariables: {
        ANTHROPIC_BASE_URL: 'http://aquaman.local/anthropic',
        OPENAI_BASE_URL: 'http://aquaman.local/openai',
      },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(result.content[0].type).toBe('text');

    const command = await made.commands[0].handler();
    expect(JSON.parse(command.text)).toEqual(result.details);
  });

  // ---------------- the proxy service ----------------

  describe('service "aquaman-proxy"', () => {
    it('start: spawns the proxy, activates the interceptor for the configured services only; stop: undoes both', async () => {
      process.env.AQUAMAN_FAKE_HOSTMAP = JSON.stringify({
        'api.anthropic.com': 'anthropic',
        'api.telegram.org': 'telegram',
        'custom.internal.example': 'anthropic',
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['anthropic'] } });
      const service = await startService(made);

      expect(made.logs.info).toContain('Starting aquaman proxy...');
      expect(made.logs.info).toContain('Aquaman proxy started successfully');
      expect(made.logs.error).toEqual([]);
      const [call] = fake.calls();
      expect(call.args).toEqual(['openclaw', 'plugin-mode']);

      // The proxy's own host map is used, cut down to what the operator opted into.
      expect(made.logs.info).toContain(
        'HTTP interceptor active: 2 host patterns redirected through proxy (1 known patterns skipped — not in plugin services config)'
      );
      expect(globalThis.fetch).not.toBe(realFetch);
      expect(await status(made)).toMatchObject({
        cliInstalled: true,
        proxyRunning: true,
        httpInterceptorActive: true,
        socketPath: fake.socketPath,
      });
      expect((await status(made)).fix).toBeUndefined();
      // Same version on both sides: nothing to say about versions.
      expect(made.logs.warn.filter((m) => m.includes('plugin version'))).toEqual([]);

      await service.stop({ logger: made.logger });
      expect(made.logs.info).toContain('Stopping aquaman proxy...');
      expect(globalThis.fetch).toBe(realFetch);
      expect(await status(made)).toMatchObject({ proxyRunning: false, httpInterceptorActive: false, socketPath: defaultSock() });
      await fake.waitForExit();
      expect(isAlive(call.pid)).toBe(false);
    }, T);

    it('start: falls back to the builtin host map when the proxy sends none, and warns on a version mismatch', async () => {
      process.env.AQUAMAN_FAKE_VERSION = '0.0.1';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['anthropic', 'slack'] } });
      await startService(made);

      // api.anthropic.com, slack.com and *.slack.com out of the builtin map.
      const line = made.logs.info.find((m) => m.startsWith('HTTP interceptor active'))!;
      expect(line).toMatch(/^HTTP interceptor active: 3 host patterns redirected through proxy \(\d+ known patterns skipped/);
      const mismatch = made.logs.warn.filter((m) => m.includes('plugin version'));
      expect(mismatch).toHaveLength(1);
      expect(mismatch[0]).toContain(`plugin version ${PLUGIN_VERSION} ≠ proxy version 0.0.1`);
      expect(mismatch[0]).toContain('npm install -g aquaman-proxy && openclaw plugins install aquaman-plugin');
    }, T);

    it('notices when the proxy exits on its own', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const made = await register({ mode: 'full', version: '2026.9.37' });
      await startService(made);
      expect((await status(made)).proxyRunning).toBe(true);

      process.kill(fake.calls()[0].pid, 'SIGTERM');
      await vi.waitFor(() => expect(made.logs.warn).toContain('Proxy exited with code 0'), { timeout: 15_000 });
      const s = await status(made);
      expect(s.proxyRunning).toBe(false);
      expect(s.fix).toBe('Run: aquaman openclaw setup');
    }, T);

    it('start: when its own proxy fails but one is already on the default socket, uses that one and its host map', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'fail';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await listenOnDefaultSocket({ 'api.openai.com': 'openai', 'api.anthropic.com': 'anthropic', 'api.telegram.org': 'telegram' });
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['openai'] } });
      await startService(made);

      expect(made.logs.error.some((m) => m.startsWith('Failed to start proxy: Error: Proxy exited with code 3'))).toBe(true);
      expect(made.logs.error).toContain('Failed to start aquaman proxy');
      expect(made.logs.info).toContain('Another aquaman instance is already running — using it');
      expect(made.logs.info).toContain(
        'HTTP interceptor active: 1 host patterns redirected through proxy (2 known patterns skipped — not in plugin services config)'
      );
      expect(globalThis.fetch).not.toBe(realFetch);
      expect(await status(made)).toMatchObject({ proxyRunning: false, httpInterceptorActive: true, socketPath: defaultSock() });
    }, T);

    it('start: an already-running proxy without a host map gets the builtin one', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'fail';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await listenOnDefaultSocket({});
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['anthropic', 'openai'] } });
      await startService(made);
      expect(made.logs.info.find((m) => m.startsWith('HTTP interceptor active'))).toMatch(/^HTTP interceptor active: 2 host patterns/);
    }, T);

    it('start: with no proxy anywhere, says so and leaves fetch alone', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'fail';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const made = await register({ mode: 'full', version: '2026.9.37' });
      await startService(made);
      expect(made.logs.error).toContain('Failed to start aquaman proxy');
      expect(made.logs.error).toContain('No running proxy found. Check: openclaw aquaman doctor');
      expect(globalThis.fetch).toBe(realFetch);
      expect(await status(made)).toMatchObject({ proxyRunning: false, httpInterceptorActive: false });
    }, T);

    it('start: a binary that cannot be started is reported, not thrown', async () => {
      // Found at register time, gone bad by the time the gateway starts the service.
      const made = await register({ mode: 'full', version: '2026.9.37' });
      process.env.PATH = fake.brokenDir;
      await expect(startService(made)).resolves.toBeDefined();
      expect(made.logs.error.some((m) => m.startsWith('Proxy error: ') && m.includes('EACCES'))).toBe(true);
      expect(made.logs.error).toContain('No running proxy found. Check: openclaw aquaman doctor');
      expect(globalThis.fetch).toBe(realFetch);
    }, T);
  });

  // ---------------- `openclaw aquaman ...` CLI ----------------

  describe('CLI commands', () => {
    let out: string[];
    let err: string[];
    let written: string[];
    let writtenErr: string[];

    async function cliFor(made: ReturnType<typeof makeApi>) {
      const program = new Command();
      program.exitOverride();
      made.cli[0].fn({ program });
      return (...argv: string[]) => program.parseAsync(['aquaman', ...argv], { from: 'user' });
    }

    beforeEach(() => {
      out = []; err = []; written = []; writtenErr = [];
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => { written.push(String(chunk)); return true; }) as any);
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => { writtenErr.push(String(chunk)); return true; }) as any);
    });

    it('registers the aquaman command tree', async () => {
      const made = await register({ mode: 'discovery' });
      const program = new Command();
      made.cli[0].fn({ program });
      const aquaman = program.commands.find((c) => c.name() === 'aquaman')!;
      expect(aquaman.commands.map((c) => c.name()).sort()).toEqual(
        ['audit-tail', 'credentials', 'doctor', 'policy-list', 'services-list', 'setup', 'status']
      );
      const creds = aquaman.commands.find((c) => c.name() === 'credentials')!;
      expect(creds.commands.map((c) => c.name()).sort()).toEqual(['add', 'list']);
    });

    it('status: before the proxy runs it names the action needed; while it runs it lists the env vars', async () => {
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['anthropic', 'openai', 'slack'] } });
      const cli = await cliFor(made);
      await cli('status');
      expect(out).toContain('  Proxy binary: found');
      expect(out).toContain('  Proxy running: false');
      expect(out).toContain(`  Socket path: ${defaultSock()}`);
      expect(out).toContain('  Services: anthropic, openai, slack');
      expect(out).toContain('\n  Action needed: Run: aquaman openclaw setup');
      expect(out.join('\n')).not.toContain('Environment Variables');

      out.length = 0;
      await startService(made);
      await cli('status');
      expect(out).toContain('  Proxy running: true');
      expect(out).toContain(`  Socket path: ${fake.socketPath}`);
      expect(out.join('\n')).not.toContain('Action needed');
      expect(out).toContain('\nEnvironment Variables:');
      expect(out).toContain('  ANTHROPIC_BASE_URL=http://aquaman.local/anthropic');
      expect(out).toContain('  OPENAI_BASE_URL=http://aquaman.local/openai');
      expect(out).toContain('  SLACK_BASE_URL=http://aquaman.local/slack');
    }, T);

    it('status reads back the variable names the plugin sets, for GitHub and for a hyphenated service', async () => {
      const made = await register({ mode: 'full', version: '2026.9.37', config: { services: ['github', 'cloudflare-ai'] } });
      expect(process.env.GITHUB_API_URL).toBe('http://aquaman.local/github');
      expect(process.env.CLOUDFLARE_AI_BASE_URL).toBe('http://aquaman.local/cloudflare-ai');

      const tool = await made.tools[0].factory().execute('call-1', {});
      expect(tool.details.environmentVariables).toEqual({
        GITHUB_API_URL: 'http://aquaman.local/github',
        CLOUDFLARE_AI_BASE_URL: 'http://aquaman.local/cloudflare-ai',
      });

      const cli = await cliFor(made);
      await startService(made);
      await cli('status');
      expect(out).toContain('  GITHUB_API_URL=http://aquaman.local/github');
      expect(out).toContain('  CLOUDFLARE_AI_BASE_URL=http://aquaman.local/cloudflare-ai');
      expect(out.join('\n')).not.toContain('(not set)');
    }, T);

    it('status: says when the proxy binary is missing', async () => {
      process.env.PATH = fake.emptyDir;
      const made = await register({ mode: 'full' });
      await (await cliFor(made))('status');
      expect(out).toContain('  Proxy binary: NOT FOUND');
      expect(out).toContain('\n  Action needed: Run: npm install -g aquaman-proxy && aquaman openclaw setup');
    });

    it('setup and credentials add hand the terminal to the proxy CLI and pass its exit code on', async () => {
      process.env.AQUAMAN_FAKE_MODE = 'quiet';
      const made = await register({ mode: 'full' });
      const cli = await cliFor(made);

      await cli('setup');
      expect(process.exitCode ?? 0).toBe(0);
      await cli('credentials', 'add', 'github');
      await cli('credentials', 'add', 'slack', 'bot_token');
      expect(fake.calls().map((c) => c.args)).toEqual([
        ['openclaw', 'setup'],
        ['credentials', 'add', 'github', 'api_key'],
        ['credentials', 'add', 'slack', 'bot_token'],
      ]);

      process.env.AQUAMAN_FAKE_EXIT = '5';
      await cli('setup');
      expect(process.exitCode).toBe(5);
      process.exitCode = undefined;
      process.env.AQUAMAN_FAKE_EXIT = '6';
      await cli('credentials', 'add', 'github');
      expect(process.exitCode).toBe(6);
    }, T);

    it('setup and credentials add print the command to run yourself when the proxy CLI is missing', async () => {
      const made = await register({ mode: 'full' });
      const cli = await cliFor(made);
      process.env.PATH = fake.emptyDir;
      await cli('setup');
      expect(out).toContain('\n  Run in your terminal:\n    aquaman openclaw setup\n');
      await cli('credentials', 'add', 'slack', 'bot_token');
      expect(out).toContain('\n  Run in your terminal:\n    aquaman credentials add slack bot_token\n');
      expect(process.exitCode ?? 0).toBe(0);
    }, T);

    it('doctor relays the proxy CLI’s output and exit code', async () => {
      process.env.AQUAMAN_FAKE_STDERR = '1 issue found';
      process.env.AQUAMAN_FAKE_EXIT = '1';
      const made = await register({ mode: 'full' });
      await (await cliFor(made))('doctor');
      expect(written).toContain('ran: openclaw doctor\n');
      expect(writtenErr).toContain('1 issue found\n');
      expect(process.exitCode).toBe(1);
    }, T);

    it('doctor exits 0 and writes nothing to stderr when the proxy CLI is clean', async () => {
      const made = await register({ mode: 'full' });
      await (await cliFor(made))('doctor');
      expect(written).toContain('ran: openclaw doctor\n');
      expect(writtenErr).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
    }, T);

    it('doctor fails with exit code 1 when the proxy CLI is missing', async () => {
      const made = await register({ mode: 'full' });
      process.env.PATH = fake.emptyDir;
      await (await cliFor(made))('doctor');
      expect(err).toEqual(['Failed to run aquaman doctor: aquaman proxy binary not found. Install with: npm install -g aquaman-proxy']);
      expect(process.exitCode).toBe(1);
    }, T);

    it.each([
      [['credentials', 'list'], ['credentials', 'list']],
      [['policy-list'], ['policy', 'list']],
      [['audit-tail'], ['audit', 'tail']],
      [['services-list'], ['services', 'list']],
    ])('%j runs `aquaman %j` and relays its output', async (argv, expected) => {
      process.env.AQUAMAN_FAKE_STDERR = 'note on stderr';
      const made = await register({ mode: 'full' });
      const cli = await cliFor(made);
      await cli(...argv);
      expect(fake.calls().map((c) => c.args)).toEqual([expected]);
      expect(written).toContain(`ran: ${expected.join(' ')}\n`);
      expect(writtenErr).toContain('note on stderr\n');

      // Without stderr output nothing is written there; without the binary the failure is reported.
      delete process.env.AQUAMAN_FAKE_STDERR;
      writtenErr.length = 0;
      await cli(...argv);
      expect(writtenErr).toEqual([]);
      process.env.PATH = fake.emptyDir;
      await cli(...argv);
      expect(err).toEqual(['Failed: aquaman proxy binary not found. Install with: npm install -g aquaman-proxy']);
    }, T);
  });

  it('a host without registerCli still gets the service, command and tool', async () => {
    const made = await register({ mode: 'full', version: '2026.9.37', cli: false });
    expect(made.cli).toEqual([]);
    expect(made.services.map((s) => s.id)).toEqual(['aquaman-proxy']);
    expect(made.commands.map((c) => c.name)).toEqual(['aquaman-status']);
    expect(made.tools.map((t) => t.opts.names)).toEqual([['aquaman_status']]);
  });
});
