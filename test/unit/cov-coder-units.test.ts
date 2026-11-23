/**
 * Unit: the failure and edge paths of the coder library that the CLI tests do
 * not reach. BrokerClient against a scripted proxy on a Unix socket,
 * projects.yaml validation, and the settings readers of both agent adapters.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BrokerClient, BrokerError } from '../../packages/coder/src/broker-client.js';
import { loadProjects, saveProjects, findProjectForCwd } from '../../packages/coder/src/projects.js';
import { claudeHookFailsClosed, installClaudeCodeHooks } from '../../packages/coder/src/adapters/claude-code/setup.js';
import { installCodexHooks, uninstallCodexHooks, codexHookStatus } from '../../packages/coder/src/adapters/codex/setup.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqu-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('BrokerClient against a proxy that misbehaves', () => {
  let server: http.Server;
  let socketPath: string;
  let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    socketPath = path.join(dir, 'proxy.sock');
    reply = (_req, res) => res.end('{}');
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => reply(req, res));
    });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const client = (timeoutMs = 5000) => new BrokerClient({ socketPath, timeoutMs });
  const json = (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const text = (status: number, body: string) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(body);
  };

  it('resolve: a non-JSON answer is an error that names the status, not a value', async () => {
    reply = text(502, '<html>Bad Gateway</html>');
    await expect(client().resolve({ service: 'github', key: 'token' }))
      .rejects.toThrow('Broker returned non-JSON response (status 502): <html>Bad Gateway</html>');
  });

  it('resolve: a 200 without value or expires_at is refused', async () => {
    reply = json(200, { value: 'v' });
    await expect(client().resolve({ service: 'github', key: 'token' })).rejects.toThrow('Broker response missing value / expires_at');
    reply = json(200, { value: 42, expires_at: 'soon' });
    await expect(client().resolve({ service: 'github', key: 'token' })).rejects.toThrow('Broker response missing value / expires_at');
  });

  it('resolve: a refusal carries the daemon code, status and fix; one without an error text gets a generic message', async () => {
    reply = json(404, { error: 'not declared', code: 'broker_ref_not_declared', fix: 'aquaman broker allow aquaman://github/token' });
    const err = await client().resolve({ service: 'github', key: 'token' }).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.message).toBe('not declared — aquaman broker allow aquaman://github/token');
    expect(err).toMatchObject({ code: 'broker_ref_not_declared', status: 404, fix: 'aquaman broker allow aquaman://github/token' });

    reply = json(500, {});
    const bare = await client().resolve({ service: 'github', key: 'token' }).catch((e) => e);
    expect(bare.message).toBe('Broker error (HTTP 500)');
    expect(bare.status).toBe(500);
  });

  it('available: a non-JSON answer, a refusal and a wrong-length list all throw; only `true` counts as available', async () => {
    const refs = [{ service: 'a', key: 'k' }, { service: 'b', key: 'k' }];
    reply = text(404, 'Not Found');
    const nonJson = await client().available(refs).catch((e) => e);
    expect(nonJson).toBeInstanceOf(BrokerError);
    expect(nonJson.message).toBe('Proxy cannot report availability (HTTP 404)');
    expect(nonJson.status).toBe(404);

    reply = json(404, { error: 'broker is off', code: 'broker_disabled' });
    const refused = await client().available(refs).catch((e) => e);
    expect(refused).toMatchObject({ message: 'broker is off', code: 'broker_disabled', status: 404 });

    reply = json(200, { available: [true] });
    await expect(client().available(refs)).rejects.toThrow('Proxy cannot report availability (HTTP 200)');

    reply = json(200, { available: [true, 'yes'] });
    expect(await client().available(refs)).toEqual([true, false]);
  });

  it('route: a non-JSON answer, a refusal and an incomplete answer throw; a full answer returns url, token and named variables only', async () => {
    const ref = { service: 'openai', key: 'api_key' };
    reply = text(500, 'oops');
    const nonJson = await client().route(ref).catch((e) => e);
    expect(nonJson).toBeInstanceOf(BrokerError);
    expect(nonJson).toMatchObject({ message: 'Proxy returned no route (HTTP 500)', status: 500 });

    reply = json(404, { error: 'not routed', code: 'broker_ref_not_routed', fix: 'aquaman-coder bind ... --via-proxy' });
    const refused = await client().route(ref).catch((e) => e);
    expect(refused).toMatchObject({ message: 'not routed', code: 'broker_ref_not_routed', fix: 'aquaman-coder bind ... --via-proxy', status: 404 });

    reply = json(200, { url: 'http://127.0.0.1:8585/openai' });
    await expect(client().route(ref)).rejects.toThrow('Proxy returned no route (HTTP 200)');

    reply = json(200, { url: 'http://127.0.0.1:8585/openai', token: 'aqm_rt_x', value: 'must-not-surface' });
    expect(await client().route(ref)).toEqual({ url: 'http://127.0.0.1:8585/openai', token: 'aqm_rt_x', env: {} });

    // Variables the proxy names for the program are passed on when they are strings, and nothing else is.
    reply = json(200, { url: 'http://127.0.0.1:8585/aws', token: 'aqm_rt_x', env: { AWS_SECRET_ACCESS_KEY: 'placeholder', COUNT: 3, NESTED: { a: 1 } } });
    expect(await client().route({ service: 'aws', key: 'access_key_id' })).toEqual({ url: 'http://127.0.0.1:8585/aws', token: 'aqm_rt_x', env: { AWS_SECRET_ACCESS_KEY: 'placeholder' } });
    reply = json(200, { url: 'http://127.0.0.1:8585/aws', token: 'aqm_rt_x', env: ['AWS_SECRET_ACCESS_KEY'] });
    expect((await client().route({ service: 'aws', key: 'access_key_id' })).env).toEqual({});
  });

  it('health: any status but 200 is a failure', async () => {
    reply = json(503, { status: 'starting' });
    await expect(client().health()).rejects.toThrow('Proxy health check failed: HTTP 503');
    reply = json(200, { status: 'ok', version: '1.2.3' });
    expect(await client().health()).toEqual({ status: 'ok', version: '1.2.3' });
  });

  it('gives up after the timeout when the proxy accepts but never answers', async () => {
    reply = () => { /* hold the request open */ };
    const started = Date.now();
    await expect(client(150).health()).rejects.toThrow('Broker request timed out after 150ms');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('a missing socket is `proxy_unreachable` with the start command; a connection the peer drops is passed through as it is', async () => {
    const missing = await new BrokerClient({ socketPath: path.join(dir, 'none.sock') }).health().catch((e) => e);
    expect(missing).toBeInstanceOf(BrokerError);
    expect(missing.code).toBe('proxy_unreachable');
    expect(missing.message).toContain('aquaman init --agent <agent> --no-hooks');

    // A listener that hangs up without speaking HTTP: neither "not running" nor "blocked".
    const rawPath = path.join(dir, 'raw.sock');
    const raw = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => raw.listen(rawPath, () => r()));
    try {
      const dropped = await new BrokerClient({ socketPath: rawPath }).health().catch((e) => e);
      expect(dropped).toBeInstanceOf(Error);
      expect(dropped).not.toBeInstanceOf(BrokerError);
      // Which errno the kernel reports depends on who loses the race.
      expect(['ECONNRESET', 'EPIPE']).toContain(dropped.code);
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });
});

describe('projects.yaml', () => {
  const file = () => path.join(dir, 'projects.yaml');
  const write = (yaml: string) => fs.writeFileSync(file(), yaml);

  it('an empty file, or one without a projects map, is no projects', () => {
    write('');
    expect(loadProjects(file())).toEqual({ version: 1, projects: {} });
    write('version: 1\n');
    expect(loadProjects(file())).toEqual({ version: 1, projects: {} });
    write('just a string\n');
    expect(loadProjects(file())).toEqual({ version: 1, projects: {} });
  });

  it('a project without an env map gets an empty one', () => {
    write('projects:\n  app:\n    paths: [/code/app]\n  other:\n    paths: [/code/other]\n    env: nope\n');
    const loaded = loadProjects(file());
    expect(loaded.projects.app.env).toEqual({});
    expect(loaded.projects.other.env).toEqual({});
  });

  it('refuses an env name that is not a POSIX variable name', () => {
    write('projects:\n  app:\n    paths: [/code/app]\n    env:\n      "MY-VAR": aquaman://a/k\n');
    expect(() => loadProjects(file())).toThrow('Project "app" has invalid env name "MY-VAR"');
  });

  it('refuses a routes entry that is not a map, names no binding, or has a bad base_path', () => {
    const head = 'projects:\n  app:\n    paths: [/code/app]\n    env:\n      OPENAI_API_KEY: aquaman://openai/api_key\n';
    write(head + '    routes: [a]\n');
    expect(() => loadProjects(file())).toThrow('Project "app" has an invalid routes map');
    write(head + '    routes: null\n');
    expect(() => loadProjects(file())).toThrow('Project "app" has an invalid routes map');

    write(head + '    routes:\n      OTHER: { url_env: OPENAI_BASE_URL }\n');
    expect(() => loadProjects(file())).toThrow('Project "app" routes OTHER, which is not in its env map');

    // A dot segment in base_path would let a route spell a path the proxy refuses.
    write(head + '    routes:\n      OPENAI_API_KEY: { url_env: OPENAI_BASE_URL, base_path: /v1/../admin }\n');
    expect(() => loadProjects(file())).toThrow('Project "app" route OPENAI_API_KEY has an invalid base_path: "/v1/../admin"');
    write(head + '    routes:\n      OPENAI_API_KEY: { url_env: OPENAI_BASE_URL, base_path: 7 }\n');
    expect(() => loadProjects(file())).toThrow('invalid base_path');

    write(head + '    routes:\n      OPENAI_API_KEY: { url_env: OPENAI_BASE_URL, base_path: /v1 }\n');
    expect(loadProjects(file()).projects.app.routes).toEqual({ OPENAI_API_KEY: { url_env: 'OPENAI_BASE_URL', base_path: '/v1' } });
  });

  it('saveProjects creates the config directory private to the user and leaves no temp file', () => {
    const nested = path.join(dir, 'new', 'projects.yaml');
    saveProjects({ projects: { app: { paths: ['/code/app'], env: { A: 'aquaman://a/k' } } } }, nested);
    expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(nested))).toEqual(['projects.yaml']);
    expect(parseYaml(fs.readFileSync(nested, 'utf-8'))).toEqual({ version: 1, projects: { app: { paths: ['/code/app'], env: { A: 'aquaman://a/k' } } } });
  });

  describe('paths under ~', () => {
    const savedHome = process.env.HOME;
    beforeEach(() => { process.env.HOME = dir; });
    afterEach(() => { process.env.HOME = savedHome; });

    it('"~/x" and "~" are matched against the home directory', () => {
      fs.mkdirSync(path.join(dir, 'code', 'app', 'src'), { recursive: true });
      const projects = {
        projects: {
          app: { paths: ['~/code/app'], env: {} },
          home: { paths: ['~'], env: {} },
        },
      };
      // Longest prefix wins.
      expect(findProjectForCwd(path.join(dir, 'code', 'app', 'src'), projects)?.name).toBe('app');
      expect(findProjectForCwd(path.join(dir, 'code'), projects)?.name).toBe('home');
      expect(findProjectForCwd(path.dirname(dir), projects)).toBeNull();
    });
  });
});

describe('agent settings readers', () => {
  it('claudeHookFailsClosed is false for a missing or unparseable settings file, true only with onFailure: block', () => {
    const settings = path.join(dir, 'settings.json');
    expect(claudeHookFailsClosed(settings)).toBe(false);
    fs.writeFileSync(settings, '{ not json');
    expect(claudeHookFailsClosed(settings)).toBe(false);

    fs.rmSync(settings);
    installClaudeCodeHooks({ settingsPath: settings, socketPath: path.join(dir, 'proxy.sock') });
    expect(claudeHookFailsClosed(settings)).toBe(false);
    installClaudeCodeHooks({ settingsPath: settings, socketPath: path.join(dir, 'proxy.sock'), failClosed: true });
    expect(claudeHookFailsClosed(settings)).toBe(true);
  });

  it('Codex: an unparseable hooks.json stops install and uninstall without touching it, and reads as not installed', () => {
    const hooks = path.join(dir, 'hooks.json');
    fs.writeFileSync(hooks, '{ "hooks": ');
    expect(() => installCodexHooks({ hooksPath: hooks })).toThrow(`Existing ${hooks} is not valid JSON`);
    expect(() => uninstallCodexHooks({ hooksPath: hooks })).toThrow('is not valid JSON');
    expect(fs.readFileSync(hooks, 'utf-8')).toBe('{ "hooks": ');
    expect(codexHookStatus(hooks, path.join(dir, 'config.toml'))).toEqual({ installed: false, trusted: false });
  });
});
