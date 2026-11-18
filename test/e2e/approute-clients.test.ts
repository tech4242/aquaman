/**
 * E2E: every client library docs/app-through-proxy.md shows, run as its own
 * process against a real proxy with local servers standing in for the
 * vendors. The scripts in test/fixtures/approute/ are the code the guide
 * prints.
 *
 * Each process is given what `aquaman-coder exec` gives a routed command: the
 * route token in the variable that would hold the key, and the proxy's URL
 * (plus the binding's base path) in the URL variable. Each test asserts that
 * the vendor received the real credential and never the token, and that the
 * process's whole environment held no real credential.
 *
 * The Python clients run under `python3`. A test whose module is not
 * importable skips itself and says which package to install.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { udsFetch } from '../helpers/uds-proxy.js';
import { startVendorUpstream, type VendorUpstream, type VendorRequest } from '../helpers/approute-vendor-upstream.js';

const FIXTURES = path.resolve('test/fixtures/approute');
const T = 120_000;

const REAL = {
  anthropic: 'sk-ant-real-vault-key-0123456789abcdef',
  openai: 'sk-proj-real-vault-key-0123456789abcdef',
  github: 'ghp_realVaultToken0123456789abcdefghij',
  stripe: 'sk_live_real_vault_key_0123456789abcdef',
  slack: 'xoxb-real-vault-token-0123456789',
  zendeskUser: 'agent@example.com/token',
  zendeskPassword: 'zd_real_api_token_0123456789abcdef',
};
const REAL_VALUES = Object.values(REAL);
const LOOPBACK_TOKEN = 'aqm_lb_approute_clients_0123456789abcdef';

/** What `aquaman-coder bind NAME=ref --via-proxy URL_ENV` records for the worked example in the guide. */
const PROJECTS_YAML = (appDir: string) => `projects:
  support-app:
    paths: ["${appDir}"]
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      OPENAI_API_KEY: aquaman://openai/api_key
      GITHUB_TOKEN: aquaman://github/token
      STRIPE_SECRET_KEY: aquaman://stripe/secret_key
      SLACK_BOT_TOKEN: aquaman://slack/bot_token
      ZENDESK_API_TOKEN: aquaman://zendesk/api_token
    routes:
      ANTHROPIC_API_KEY: { url_env: ANTHROPIC_BASE_URL }
      OPENAI_API_KEY: { url_env: OPENAI_BASE_URL, base_path: /v1 }
      GITHUB_TOKEN: { url_env: GITHUB_API_URL }
      STRIPE_SECRET_KEY: { url_env: STRIPE_API_BASE }
      SLACK_BOT_TOKEN: { url_env: SLACK_API_URL, base_path: /api }
      ZENDESK_API_TOKEN: { url_env: ZENDESK_API_URL }
`;

function run(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { env, cwd, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code as number) ?? 1 : 0, stdout, stderr });
    });
  });
}

const pythonModules = new Map<string, boolean>();
/** Whether `python3` on PATH can import the module. Asked once per module. */
function pythonHas(module: string): boolean {
  if (!pythonModules.has(module)) {
    const r = spawnSync('python3', ['-c', `import ${module}`], { stdio: 'ignore', timeout: 60_000 });
    pythonModules.set(module, r.status === 0);
  }
  return pythonModules.get(module)!;
}

describe('client libraries routed through the proxy', () => {
  let root: string;
  let appDir: string;
  let home: string;
  let socketPath: string;
  let upstream: VendorUpstream;
  let proxy: CredentialProxy;
  let log: RequestInfo[];
  /** The variables a routed command is started with: tokens and proxy URLs, nothing from the vault. */
  let routedEnv: Record<string, string>;
  let routeToken: string;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqar-')));
    appDir = path.join(root, 'app');
    home = path.join(root, 'home');
    fs.mkdirSync(appDir);
    fs.mkdirSync(home);
    socketPath = path.join(root, 'proxy.sock');
    upstream = await startVendorUpstream(REAL);

    // Zendesk's host is per tenant, so it is a services.yaml entry. The
    // built-in definitions are pointed at the local server; a daemon cannot
    // do that, which is why the proxy runs in this process.
    const servicesPath = path.join(root, 'services.yaml');
    fs.writeFileSync(servicesPath, [
      'services:',
      '  - name: zendesk',
      `    upstream: http://127.0.0.1:${upstream.port}`,
      '    authMode: basic',
      '    authHeader: Authorization',
      '    credentialKey: email',
      '    additionalCredentialKeys: [api_token]',
      '',
    ].join('\n'));
    const registry = createServiceRegistry({ configPath: servicesPath });
    for (const name of ['anthropic', 'openai', 'github', 'stripe', 'slack']) {
      registry.override(name, { upstream: `http://127.0.0.1:${upstream.port}` });
    }

    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL.anthropic);
    await store.set('openai', 'api_key', REAL.openai);
    await store.set('github', 'token', REAL.github);
    await store.set('stripe', 'secret_key', REAL.stripe);
    await store.set('slack', 'bot_token', REAL.slack);
    await store.set('zendesk', 'email', REAL.zendeskUser);
    await store.set('zendesk', 'api_token', REAL.zendeskPassword);

    const projectsPath = path.join(root, 'projects.yaml');
    fs.writeFileSync(projectsPath, PROJECTS_YAML(appDir));

    log = [];
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      // Nothing is forwarded for agent hosts here: the routes are the only way in.
      allowedServices: [],
      broker: createBrokerScope({ configPath: path.join(root, 'config.yaml'), projectsPath }),
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      // The guide's policy: Stripe is read-only for the app.
      policyConfig: { stripe: { defaultAction: 'deny', rules: [{ method: 'GET', path: '/v1/**', action: 'allow' }] } },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();

    // What `aquaman-coder exec` does for each routed binding.
    const project = parseYaml(fs.readFileSync(projectsPath, 'utf-8')).projects['support-app'];
    routedEnv = {};
    for (const [name, ref] of Object.entries(project.env as Record<string, string>)) {
      const [, service, key] = /^aquaman:\/\/([^/]+)\/(.+)$/.exec(ref)!;
      const res = await udsFetch(socketPath, '/broker/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service, key }) });
      expect(res.status, ref).toBe(200);
      const { url, token } = JSON.parse(res.body);
      const route = project.routes[name];
      routedEnv[name] = token;
      routedEnv[route.url_env] = url + (route.base_path ?? '');
      routeToken = token;
    }
  }, T);

  afterAll(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    upstream.clear();
    log.length = 0;
  });

  /** The environment of the app process: PATH, an empty HOME, the routed variables, and plain settings. */
  const appEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ...routedEnv,
    ...extra,
  });

  /** Every header the vendor received, plus the decoded form of anything that is base64. */
  const headerText = (req: VendorRequest): string => {
    const values = Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    const decoded = values.flatMap((v) => (v.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []).map((m) => Buffer.from(m, 'base64').toString('latin1')));
    return [...values, ...decoded].join('\n');
  };

  /** The checks every client gets: it ran, it held no real credential, and the vendor saw no local token. */
  function expectIsolated(result: { code: number; stdout: string; stderr: string }, vendorPath: string): { out: any; request: VendorRequest } {
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const out = JSON.parse(result.stdout.trim().split('\n').pop()!);
    const everything = result.stdout + result.stderr;
    for (const value of REAL_VALUES) expect(everything, 'the app process output or environment held a real credential').not.toContain(value);
    const requests = upstream.seen(vendorPath);
    expect(requests.length, `requests to ${vendorPath}`).toBeGreaterThan(0);
    for (const request of upstream.requests) {
      const text = headerText(request);
      expect(text).not.toContain(routeToken);
      expect(text).not.toContain(LOOPBACK_TOKEN);
      expect(request.body).not.toContain(routeToken);
    }
    return { out, request: requests[requests.length - 1] };
  }

  it('the routed environment is tokens and local URLs, with the base path each client needs', () => {
    const address = proxy.getLoopbackAddress();
    expect(routedEnv).toEqual({
      ANTHROPIC_API_KEY: routeToken,
      ANTHROPIC_BASE_URL: `http://${address}/anthropic`,
      OPENAI_API_KEY: routeToken,
      OPENAI_BASE_URL: `http://${address}/openai/v1`,
      GITHUB_TOKEN: routeToken,
      GITHUB_API_URL: `http://${address}/github`,
      STRIPE_SECRET_KEY: routeToken,
      STRIPE_API_BASE: `http://${address}/stripe`,
      SLACK_BOT_TOKEN: routeToken,
      SLACK_API_URL: `http://${address}/slack/api`,
      ZENDESK_API_TOKEN: routeToken,
      ZENDESK_API_URL: `http://${address}/zendesk`,
    });
    expect(routeToken).toMatch(/^aqm_rt_[0-9a-f]{48}$/);
    for (const value of REAL_VALUES) expect(JSON.stringify(routedEnv)).not.toContain(value);
  });

  describe('JavaScript', () => {
    const node = (script: string, args: string[] = [], extra: Record<string, string> = {}) =>
      run(process.execPath, [path.join(FIXTURES, script), ...args], appEnv(extra), appDir);

    it('@anthropic-ai/sdk: ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY, no base path', async () => {
      const { out, request } = expectIsolated(await node('anthropic-sdk.mjs'), '/v1/messages');
      expect(out.result).toBe('routed through the proxy');
      expect(out.env.ANTHROPIC_API_KEY).toBe(routeToken);
      expect(request.method).toBe('POST');
      expect(request.headers['x-api-key']).toBe(REAL.anthropic);
      expect(JSON.parse(request.body).model).toBe('claude-opus-5-5');
      expect(log.some((r) => r.service === 'anthropic' && r.statusCode === 200 && r.authenticated)).toBe(true);
    }, T);

    it('openai: OPENAI_BASE_URL and OPENAI_API_KEY, base path /v1', async () => {
      const { out, request } = expectIsolated(await node('openai-sdk.mjs'), '/v1/chat/completions');
      expect(out.result).toBe('routed');
      expect(request.headers['authorization']).toBe(`Bearer ${REAL.openai}`);
    }, T);

    it('@octokit/rest: the baseUrl option and the auth option, no base path', async () => {
      const { out, request } = expectIsolated(await node('octokit-rest.mjs'), '/user');
      expect(out.result).toBe('octocat');
      expect(request.headers['authorization']).toBe(`Bearer ${REAL.github}`);
    }, T);

    it('stripe: a fetch client that swaps the origin; a read goes through with the real key', async () => {
      const { out, request } = expectIsolated(await node('stripe-sdk.mjs', ['list']), '/v1/customers');
      expect(out.result).toEqual(['cus_local_1']);
      expect(request.headers['authorization']).toBe(`Bearer ${REAL.stripe}`);
      expect(request.path).toBe('/v1/customers?limit=3');
    }, T);

    it('stripe: a write is refused by the read-only policy and never reaches Stripe', async () => {
      const result = await node('stripe-sdk.mjs', ['refund']);
      expect(result.code, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout.trim());
      expect(out.error.status).toBe(403);
      expect(out.result).toBeUndefined();
      expect(upstream.requests).toEqual([]);
      expect(log.some((r) => r.service === 'stripe' && r.statusCode === 403 && /Policy denied: POST \/v1\/refunds/.test(r.error ?? ''))).toBe(true);
      for (const value of REAL_VALUES) expect(result.stdout + result.stderr).not.toContain(value);
    }, T);

    it('@slack/web-api: the slackApiUrl option and the token argument, base path /api', async () => {
      const { out, request } = expectIsolated(await node('slack-web-api.mjs'), '/api/chat.postMessage');
      expect(out.result).toBe('1700000000.000100');
      expect(request.method).toBe('POST');
      expect(request.headers['authorization']).toBe(`Bearer ${REAL.slack}`);
      expect(request.body).toContain('C0SUPPORT');
    }, T);

    it('fetch with basic auth for Zendesk: the token as the password, the stored pair upstream', async () => {
      const { out, request } = expectIsolated(await node('zendesk-fetch.mjs', [], { ZENDESK_EMAIL: 'agent@example.com' }), '/api/v2/tickets.json');
      expect(out).toMatchObject({ status: 200, result: [42] });
      expect(out.env.ZENDESK_API_TOKEN).toBe(routeToken);
      expect(request.headers['authorization']).toBe(`Basic ${Buffer.from(`${REAL.zendeskUser}:${REAL.zendeskPassword}`).toString('base64')}`);
      expect(log.some((r) => r.service === 'zendesk' && r.statusCode === 200 && r.authenticated)).toBe(true);
    }, T);

    it('the worked example from the guide: one app, four routed APIs, and a Stripe write refused by policy', async () => {
      // The fixture and the guide carry the same code, so a change to one that is not made in the other fails here.
      const guide = fs.readFileSync(path.resolve('docs/app-through-proxy.md'), 'utf-8');
      const fixture = fs.readFileSync(path.join(FIXTURES, 'support-agent.mjs'), 'utf-8');
      const shared = fixture.slice(fixture.indexOf("import Anthropic"), fixture.indexOf('console.log('));
      expect(guide).toContain(shared.trim());

      const { out } = expectIsolated(await node('support-agent.mjs', [], { ZENDESK_EMAIL: 'agent@example.com' }), '/v1/messages');
      expect(out).toMatchObject({ ticket: 42, customers: 1, reply: 'routed through the proxy', posted: '1700000000.000100', refund: 'refused with 403' });
      expect(upstream.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /api/v2/tickets.json',
        'GET /v1/customers?limit=3',
        'POST /v1/messages',
        'POST /api/chat.postMessage',
      ]);
      expect(log.filter((r) => r.statusCode === 200).map((r) => r.service)).toEqual(['zendesk', 'stripe', 'anthropic', 'slack']);
      expect(log.filter((r) => r.statusCode === 403).map((r) => r.service)).toEqual(['stripe']);
    }, T);

    it('fetch with basic auth for Zendesk: whatever user name the app sends, the stored one goes upstream', async () => {
      const { out, request } = expectIsolated(await node('zendesk-fetch.mjs', [], { ZENDESK_EMAIL: 'someone-else@example.com' }), '/api/v2/tickets.json');
      expect(out.status).toBe(200);
      expect(headerText(request)).not.toContain('someone-else@example.com');
    }, T);
  });

  describe('Python', () => {
    const python = (script: string, extra: Record<string, string> = {}) =>
      run('python3', [path.join(FIXTURES, script)], appEnv(extra), appDir);
    const need = (ctx: { skip: (note?: string) => void }, module: string, pip: string) => {
      if (!pythonHas(module)) ctx.skip(`python3 cannot import "${module}". Install it to run this test: python3 -m pip install ${pip}`);
    };

    it('anthropic: ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY, no base path', async (ctx) => {
      need(ctx, 'anthropic', 'anthropic');
      const { out, request } = expectIsolated(await python('anthropic_sdk.py'), '/v1/messages');
      expect(out.result).toBe('routed through the proxy');
      expect(out.env.ANTHROPIC_API_KEY).toBe(routeToken);
      expect(request.headers['x-api-key']).toBe(REAL.anthropic);
    }, T);

    it('slack_sdk: the base_url argument and the token argument, base path /api', async (ctx) => {
      need(ctx, 'slack_sdk', 'slack_sdk');
      const { out, request } = expectIsolated(await python('slack_sdk_client.py'), '/api/chat.postMessage');
      expect(out.result).toBe('1700000000.000100');
      expect(request.headers['authorization']).toBe(`Bearer ${REAL.slack}`);
    }, T);

    for (const [module, script] of [['requests', 'zendesk_requests.py'], ['httpx', 'zendesk_httpx.py']]) {
      it(`${module} with basic auth for Zendesk: the token as the password, the stored pair upstream`, async (ctx) => {
        need(ctx, module, module);
        const { out, request } = expectIsolated(await python(script, { ZENDESK_EMAIL: 'agent@example.com' }), '/api/v2/tickets.json');
        expect(out).toMatchObject({ status: 200, result: [42] });
        expect(out.env.ZENDESK_API_TOKEN).toBe(routeToken);
        expect(request.headers['authorization']).toBe(`Basic ${Buffer.from(`${REAL.zendeskUser}:${REAL.zendeskPassword}`).toString('base64')}`);
      }, T);
    }
  });
});
