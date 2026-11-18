/**
 * E2E: the whole path for a basic-auth service whose host is per tenant.
 * A `services.yaml` entry, `aquaman-coder bind --via-proxy`, a real
 * `aquaman daemon`, and `aquaman-coder exec` running an app that sends basic
 * auth. Real processes, each with its own HOME and config directory, the
 * encrypted-file vault, and a local server in place of Zendesk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { createSandbox, startDaemon, freePort, CODER_CLI, TSX, PASSWORD, T, type Sandbox, type RunResult } from './cov-cli-core-helpers.js';
import { startVendorUpstream, type VendorUpstream } from '../helpers/approute-vendor-upstream.js';

const FIXTURES = path.resolve('test/fixtures/approute');
const REAL_USER = 'agent@example.com/token';
const REAL_PASSWORD = 'zd_real_api_token_0123456789abcdef';
const REAL_BASIC = `Basic ${Buffer.from(`${REAL_USER}:${REAL_PASSWORD}`).toString('base64')}`;
const LOOPBACK_TOKEN = 'aqm_lb_approute_cli_0123456789abcdef';

describe('a basic-auth service routed from services.yaml to exec', () => {
  let sb: Sandbox;
  let upstream: VendorUpstream;
  let port: number;

  const coder = (args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(TSX, [CODER_CLI, ...args], { cwd: sb.project, stdio: ['ignore', 'pipe', 'pipe'], env: sb.env(extraEnv) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  const vault = () => new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));
  const projects = () => parseYaml(fs.readFileSync(path.join(sb.config, 'projects.yaml'), 'utf-8')).projects;

  beforeEach(async () => {
    sb = createSandbox();
    upstream = await startVendorUpstream({
      anthropic: 'unused', openai: 'unused', github: 'unused', stripe: 'unused', slack: 'unused',
      zendeskUser: REAL_USER, zendeskPassword: REAL_PASSWORD,
    });
    port = await freePort();
    sb.writeConfig([
      'credentials:',
      '  backend: encrypted-file',
      '  proxiedServices: []',
      'loopback:',
      '  enabled: true',
      `  port: ${port}`,
      '  host: 127.0.0.1',
      `  token: ${LOOPBACK_TOKEN}`,
      'policy:',
      '  zendesk:',
      '    defaultAction: allow',
      '    rules:',
      '      - { method: DELETE, path: "/api/v2/**", action: deny }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(sb.config, 'services.yaml'), [
      'services:',
      '  - name: zendesk',
      `    upstream: http://127.0.0.1:${upstream.port}`,
      '    authMode: basic',
      '    authHeader: Authorization',
      '    credentialKey: email',
      '    additionalCredentialKeys: [api_token]',
      '',
    ].join('\n'));
    await vault().set('zendesk', 'email', REAL_USER);
    await vault().set('zendesk', 'api_token', REAL_PASSWORD);
    sb.installRealCoder();
  });

  afterEach(async () => {
    await sb.cleanup();
    await upstream.stop();
  });

  it('services validate accepts the entry, bind records the route, and exec runs the app with a token while Zendesk gets the stored pair', async () => {
    const validated = await sb.run(['services', 'validate']);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain('services.yaml is valid');

    expect((await coder(['init', '--agent', 'claude-code', '--no-hooks', '--json'])).code).toBe(0);
    const bound = await coder(['bind', 'ZENDESK_API_TOKEN=aquaman://zendesk/api_token', '--via-proxy', 'ZENDESK_API_URL', '--json']);
    expect(bound.code, bound.stderr).toBe(0);
    expect(JSON.parse(bound.stdout)).toMatchObject({ ok: true, env: 'ZENDESK_API_TOKEN', ref: 'aquaman://zendesk/api_token', via_proxy: { url_env: 'ZENDESK_API_URL' } });
    expect(projects().app.routes).toEqual({ ZENDESK_API_TOKEN: { url_env: 'ZENDESK_API_URL' } });

    await startDaemon(sb);
    const ran = await coder(['exec', '--', 'node', path.join(FIXTURES, 'zendesk-fetch.mjs'), '--summary'], { ZENDESK_EMAIL: 'agent@example.com' });
    expect(ran.code, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout.trim())).toEqual({
      status: 200,
      result: [42],
      tokenIsLocal: true,
      url: `http://127.0.0.1:${port}/zendesk`,
      error: null,
    });
    expect(ran.stdout + ran.stderr).not.toContain(REAL_PASSWORD);

    const seen = upstream.seen('/api/v2/tickets.json');
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe(REAL_BASIC);
    expect(JSON.stringify(seen[0].headers)).not.toMatch(/aqm_/);

    // The password is bound only through the proxy, so nothing is handed its value.
    const got = await sb.run(['get', 'aquaman://zendesk/api_token']);
    expect(got.code).not.toBe(0);
    expect(got.stdout + got.stderr).not.toContain(REAL_PASSWORD);
    expect(got.stderr).toContain('aquaman://zendesk/api_token is bound through the proxy, so its value is not handed out');

    // The audit log names the service and holds neither the token nor a value.
    const audit = fs.readFileSync(path.join(sb.config, 'audit', 'current.jsonl'), 'utf-8');
    expect(audit).toContain('zendesk');
    expect(audit).not.toMatch(/aqm_rt_/);
    expect(audit).not.toContain(REAL_PASSWORD);
  }, T * 3);

  it('exec names the missing half when the user name is not stored, and does not run the command with half a pair', async () => {
    await coder(['init', '--agent', 'claude-code', '--no-hooks', '--json']);
    await coder(['bind', 'ZENDESK_API_TOKEN=aquaman://zendesk/api_token', '--via-proxy', 'ZENDESK_API_URL', '--json']);
    await vault().delete('zendesk', 'email');
    await startDaemon(sb);
    const ran = await coder(['exec', '--', 'node', '-e', 'console.log(JSON.stringify([process.env.ZENDESK_API_TOKEN ?? null, process.env.ZENDESK_API_URL ?? null]))']);
    // The route is the project's only binding, so nothing resolved and exec stops.
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('the command was not run');
    expect(ran.stderr).toContain('ZENDESK_API_TOKEN is not set for this command: Credential not found: zendesk/email. Run: aquaman credentials add zendesk email');
    expect(upstream.requests).toEqual([]);
  }, T * 3);

  it('bind gives a Slack route the /api base path its clients expect, and --base-path overrides it', async () => {
    await coder(['init', '--agent', 'claude-code', '--no-hooks', '--json']);
    const slack = await coder(['bind', 'SLACK_BOT_TOKEN=aquaman://slack/bot_token', '--via-proxy', 'SLACK_API_URL', '--json']);
    expect(JSON.parse(slack.stdout).via_proxy).toEqual({ url_env: 'SLACK_API_URL', base_path: '/api' });
    const anthropic = await coder(['bind', 'ANTHROPIC_API_KEY=aquaman://anthropic/api_key', '--via-proxy', 'ANTHROPIC_BASE_URL', '--json']);
    expect(JSON.parse(anthropic.stdout).via_proxy).toEqual({ url_env: 'ANTHROPIC_BASE_URL' });
    const custom = await coder(['bind', 'SLACK_BOT_TOKEN=aquaman://slack/bot_token', '--via-proxy', 'SLACK_API_URL', '--base-path', '/api/v2', '--json']);
    expect(JSON.parse(custom.stdout).via_proxy).toEqual({ url_env: 'SLACK_API_URL', base_path: '/api/v2' });
    expect(projects().app.routes).toEqual({
      SLACK_BOT_TOKEN: { url_env: 'SLACK_API_URL', base_path: '/api/v2' },
      ANTHROPIC_API_KEY: { url_env: 'ANTHROPIC_BASE_URL' },
    });
  }, T * 3);
});
