/**
 * E2E: `aquaman request` and `aquaman get` against every answer a proxy can
 * give, including the ones the real daemon only gives after a person has
 * answered a dialog.
 *
 * No dialog is ever shown: a server the test owns sits on the proxy's socket
 * and plays the daemon. What is under test is the CLI's side of the contract:
 * what it sends, the status it prints, the exit code, the fix it hands back,
 * and that a value never appears in its output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createSandbox, fakeProxy, json, T, type FakeProxy, type Sandbox } from './cov-cli-core-helpers.js';

const REF = 'aquaman://github/token';
const LOOPBACK_CONFIG = 'credentials:\n  backend: encrypted-file\nloopback:\n  enabled: true\n  port: 8585\n  token: aqm_lb_cov_cli_core_request\n';

describe('cli-core: aquaman request', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  /** The daemon's reply to POST /broker/request, chosen by the test. */
  const answer = async (status: number, body: unknown) => {
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, status, body));
  };
  const coder = (args: string[], cwd = sb.project) =>
    spawnSync(path.join(sb.bin, 'aquaman-coder'), args, { cwd, encoding: 'utf-8', env: sb.env() });
  /** A registered project at sb.project, made by the real coder CLI, with no hooks. */
  const registerProject = () => {
    sb.installRealCoder();
    const r = coder(['init', '--agent', 'claude-code', '--no-hooks', '--json']);
    expect(r.status, r.stderr).toBe(0);
  };
  const projectEntry = () => parseYaml(fs.readFileSync(path.join(sb.config, 'projects.yaml'), 'utf-8')).projects.app;

  it('stored: exit 0, one status line on stdout, and the request carries the ref, the project and the default wait', async () => {
    await answer(200, { status: 'stored', ref: REF });
    const r = await sb.run(['request', REF]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`stored: ${REF}`);
    expect(r.stderr).toBe('');
    expect(proxy!.requests).toEqual([{
      method: 'POST',
      url: '/broker/request',
      body: { service: 'github', key: 'token', project: sb.project, timeout_seconds: 90 },
    }]);
  }, T);

  it('--timeout is clamped to what the daemon accepts before it is sent', async () => {
    await answer(200, { status: 'ready', ref: REF });
    expect((await sb.run(['request', REF, '--timeout', '1', '--json'])).code).toBe(0);
    expect((await sb.run(['request', REF, '--timeout', '86400', '--json'])).code).toBe(0);
    expect(proxy!.requests.map((q) => q.body.timeout_seconds)).toEqual([10, 600]);
  }, T);

  it('ready with --env: checks the project first, then binds, and reports the variable', async () => {
    registerProject();
    await answer(200, { status: 'ready', ref: REF });
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'ready', ref: REF, env: 'GITHUB_TOKEN' });
    expect(projectEntry().env).toEqual({ GITHUB_TOKEN: REF });
    expect(proxy!.requests[0].body.routed).toBeUndefined();

    const text = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`ready: ${REF}`);
    expect(text.stdout).toContain('Bound to GITHUB_TOKEN for this project');
    expect(text.stdout).not.toContain('through the proxy');
  }, T * 2);

  it('approved with --via-proxy: asks for a routed credential, records the route, and never declares the value', async () => {
    sb.writeConfig(LOOPBACK_CONFIG);
    registerProject();
    await answer(200, { status: 'approved', ref: 'aquaman://stripe/secret_key' });
    const args = ['request', 'aquaman://stripe/secret_key', '--env', 'STRIPE_SECRET_KEY', '--via-proxy', 'STRIPE_API_BASE', '--base-path', '/v1'];

    const r = await sb.run([...args, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      status: 'approved',
      ref: 'aquaman://stripe/secret_key',
      env: 'STRIPE_SECRET_KEY',
      via_proxy: { url_env: 'STRIPE_API_BASE', base_path: '/v1' },
    });
    expect(proxy!.requests[0].body).toMatchObject({ service: 'stripe', key: 'secret_key', routed: true });
    expect(projectEntry().routes).toEqual({ STRIPE_SECRET_KEY: { url_env: 'STRIPE_API_BASE', base_path: '/v1' } });

    const text = await sb.run(args);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Bound to STRIPE_SECRET_KEY for this project, through the proxy');
  }, T * 2);

  it('declined: exit 2, on stderr, with the reason and no command that would finish what the person refused', async () => {
    await answer(200, { status: 'declined', ref: REF, reason: 'the person said no' });
    const text = await sb.run(['request', REF]);
    expect(text.code).toBe(2);
    expect(text.stderr.trim()).toBe(`declined: ${REF} (the person said no)`);
    expect(text.stdout).toBe('');

    registerProject();
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ status: 'declined', ref: REF, reason: 'the person said no' });
    expect(out.fix).toBeUndefined();
    // Nothing was bound for a credential that was refused.
    expect(projectEntry().env).toEqual({});
  }, T * 2);

  it('pending: exit 3, and the by-hand fix ends with the same binding this command would have made', async () => {
    registerProject();
    await answer(200, { status: 'pending', ref: REF, reason: 'no desktop session', fix: 'aquaman credentials add github token && aquaman broker allow aquaman://github/token' });
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({
      status: 'pending',
      ref: REF,
      reason: 'no desktop session',
      fix: `aquaman credentials add github token && aquaman broker allow aquaman://github/token && aquaman coder bind GITHUB_TOKEN=${REF}`,
    });
    expect(projectEntry().env).toEqual({});

    const text = await sb.run(['request', REF]);
    expect(text.code).toBe(3);
    expect(text.stderr).toContain(`pending: ${REF} (no desktop session)`);
    expect(text.stderr).toContain('Fix: aquaman credentials add github token && aquaman broker allow aquaman://github/token');
    expect(text.stderr).not.toContain('coder bind');
  }, T * 2);

  it('pending through the proxy: the by-hand fix keeps the route flags', async () => {
    sb.writeConfig(LOOPBACK_CONFIG);
    registerProject();
    await answer(200, { status: 'pending', ref: 'aquaman://openai/api_key', fix: 'aquaman credentials add openai api_key' });
    const r = await sb.run(['request', 'aquaman://openai/api_key', '--env', 'OPENAI_API_KEY', '--via-proxy', 'OPENAI_BASE_URL', '--json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).fix).toBe('aquaman credentials add openai api_key && aquaman coder bind OPENAI_API_KEY=aquaman://openai/api_key --via-proxy OPENAI_BASE_URL');
  }, T);

  it('a refusal from the proxy is exit 4 and carries the proxy\'s own error, code and fix', async () => {
    await answer(404, { error: 'This proxy does not serve the credential broker', code: 'broker_disabled', fix: 'Run aquaman daemon' });
    const r = await sb.run(['request', REF, '--json']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'error', ref: REF, error: 'This proxy does not serve the credential broker', code: 'broker_disabled', fix: 'Run aquaman daemon' });

    const text = await sb.run(['request', REF]);
    expect(text.code).toBe(4);
    expect(text.stderr).toContain(`error: ${REF}`);
    expect(text.stderr).toContain('This proxy does not serve the credential broker');
    expect(text.stderr).toContain('Fix: Run aquaman daemon');
  }, T);

  it('exit 4 when what is on the socket does not speak JSON, refuses the connection, or is not a socket', async () => {
    proxy = await fakeProxy(sb.socket, (_req, res) => { res.writeHead(502); res.end('<html>bad gateway</html>'); });
    const notJson = await sb.run(['request', REF, '--json']);
    expect(notJson.code).toBe(4);
    expect(JSON.parse(notJson.stdout)).toMatchObject({ status: 'error', code: 'bad_response', error: 'Proxy returned a non-JSON response (HTTP 502)' });

    // The socket exists but this user may not connect to it (a sandbox, or another user's proxy).
    fs.chmodSync(sb.socket, 0o000);
    const blocked = await sb.run(['request', REF, '--json']);
    expect(blocked.code).toBe(4);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ status: 'error', code: 'socket_blocked', error: expect.stringContaining('was denied (EACCES)') });
    fs.chmodSync(sb.socket, 0o600);

    await proxy.close();
    proxy = undefined;
    fs.writeFileSync(sb.socket, 'not a socket');
    const notSocket = await sb.run(['request', REF, '--json']);
    expect(notSocket.code).toBe(4);
    const out = JSON.parse(notSocket.stdout);
    expect(out).toMatchObject({ status: 'error', ref: REF, fix: expect.stringContaining('aquaman init --agent <agent> --no-hooks') });
    expect(['proxy_error', 'proxy_unreachable']).toContain(out.code);
  }, T * 2);

  it('a bad --env name is exit 1 and nothing is sent', async () => {
    await answer(200, { status: 'stored', ref: REF });
    const r = await sb.run(['request', REF, '--env', '1-BAD NAME', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', error: 'Invalid --env name: 1-BAD NAME', fix: expect.stringContaining('GITHUB_TOKEN') });
    expect(proxy!.requests).toEqual([]);
  }, T);

  it('--env without aquaman-coder is exit 1 with the install command, and nobody is asked', async () => {
    await answer(200, { status: 'stored', ref: REF });
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'error', ref: REF, error: 'aquaman-coder is not installed, so --env cannot bind anything', fix: 'npm install -g aquaman-coder' });
    expect(proxy!.requests).toEqual([]);
  }, T);

  it('--env outside a registered project is exit 1 with the coder\'s own reason, before any dialog', async () => {
    registerProject();
    await answer(200, { status: 'stored', ref: REF });
    // The parent of the project: a binding here would cover every sibling.
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json'], { cwd: sb.root });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe('error');
    expect(out.error).toContain('No aquaman project covers');
    expect(out.fix).toContain('aquaman init --agent');
    expect(proxy!.requests).toEqual([]);
    expect(projectEntry().env).toEqual({});
  }, T);

  it('when the project check fails without saying why, the generic reason and fix are used', async () => {
    sb.installFakeCoder('echo "segfault" >&2\nexit 3');
    await answer(200, { status: 'stored', ref: REF });
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      status: 'error',
      ref: REF,
      error: 'No project covers the current directory',
      fix: 'Run from the project directory, after: aquaman init --agent <agent> --no-hooks',
    });
    expect(sb.coderCalls()).toEqual([['bind', `GITHUB_TOKEN=${REF}`, '--check', '--json']]);
    expect(proxy!.requests).toEqual([]);
  }, T);

  it('stored, but the binding then fails: still exit 0, with the reason and the command that finishes the job', async () => {
    // Passes the check, fails the real bind.
    sb.installFakeCoder('case "$*" in *--check*) echo \'{"ok":true}\'; exit 0;; esac\necho "projects.yaml is read-only" >&2\nexit 1');
    await answer(200, { status: 'stored', ref: REF });
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      status: 'stored',
      ref: REF,
      env_error: 'projects.yaml is read-only',
      fix: `aquaman coder bind GITHUB_TOKEN=${REF}`,
    });
    expect(sb.coderCalls()).toEqual([
      ['bind', `GITHUB_TOKEN=${REF}`, '--check', '--json'],
      ['bind', `GITHUB_TOKEN=${REF}`, '--json'],
    ]);
  }, T);

  it('through the proxy, a binding that fails keeps the route flags in its fix, and one that prints no JSON still reports the URL variable', async () => {
    sb.writeConfig(LOOPBACK_CONFIG);
    await answer(200, { status: 'stored', ref: 'aquaman://openai/api_key' });
    const args = ['request', 'aquaman://openai/api_key', '--env', 'OPENAI_API_KEY', '--via-proxy', 'OPENAI_BASE_URL', '--base-path', '/v1', '--json'];

    sb.installFakeCoder('case "$*" in *--check*) exit 0;; esac\necho "nope"\nexit 1');
    const failed = await sb.run(args);
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      status: 'stored',
      env_error: 'nope',
      fix: 'aquaman coder bind OPENAI_API_KEY=aquaman://openai/api_key --via-proxy OPENAI_BASE_URL --base-path /v1',
    });
    expect(sb.coderCalls()[0]).toEqual(['bind', 'OPENAI_API_KEY=aquaman://openai/api_key', '--check', '--via-proxy', 'OPENAI_BASE_URL', '--base-path', '/v1', '--json']);

    sb.installFakeCoder('echo "bound"\nexit 0');
    const quiet = await sb.run(args);
    expect(quiet.code).toBe(0);
    expect(JSON.parse(quiet.stdout)).toMatchObject({ status: 'stored', env: 'OPENAI_API_KEY', via_proxy: { url_env: 'OPENAI_BASE_URL' } });
  }, T * 2);

  it('--base-path without --via-proxy is refused in words, on stderr, with exit 1', async () => {
    const r = await sb.run(['request', REF, '--env', 'GITHUB_TOKEN', '--base-path', '/v1']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`error: ${REF}`);
    expect(r.stderr).toContain('--via-proxy needs --env, and --base-path needs --via-proxy');
    expect(r.stderr).toContain('Fix: aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL');
    expect(r.stdout).toBe('');
  }, T);
});

describe('cli-core: aquaman get against a proxy that misbehaves', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  it('rejects a --timeout that is not a positive whole number of milliseconds, before contacting the proxy', async () => {
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { value: 'ghp_must_not_be_read' }));
    for (const bad of ['0', '1.5', 'soon']) {
      const r = await sb.run(['get', REF, '--timeout', bad]);
      expect(r.code, bad).toBe(1);
      expect(r.stderr, bad).toContain(`Invalid --timeout: ${bad} (milliseconds, a positive integer)`);
      expect(r.stdout, bad).toBe('');
    }
    expect(proxy.requests).toEqual([]);
  }, T * 2);

  it('prints nothing on stdout and exits 1 when the proxy answers with something that is not JSON', async () => {
    proxy = await fakeProxy(sb.socket, (_req, res) => { res.writeHead(200); res.end('ghp_plain_text_is_not_a_reply'); });
    const r = await sb.run(['get', REF]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Error: Proxy returned a non-JSON response (HTTP 200)');
    expect(r.stderr).not.toContain('ghp_plain_text');
  }, T);

  it('gives up after --timeout and says a prompting vault may need longer', async () => {
    proxy = await fakeProxy(sb.socket, () => { /* never answers */ });
    const r = await sb.run(['get', REF, '--timeout', '400']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Error: Broker request timed out after 400ms');
    expect(r.stderr).toContain('Fix: A vault that prompts');
    expect(proxy.requests[0]).toMatchObject({ method: 'POST', url: '/broker/resolve', body: { service: 'github', key: 'token' } });
  }, T);

  it('explains a proxy that does not serve the broker, passes on the proxy\'s own fix, and copes with a reply that has neither value nor error', async () => {
    let reply: { status: number; body: unknown } = { status: 404, body: { error: 'Credential broker is disabled', code: 'broker_disabled' } };
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, reply.status, reply.body));

    const disabled = await sb.run(['get', REF]);
    expect(disabled.code).toBe(1);
    expect(disabled.stderr).toContain('Error: Credential broker is disabled');
    expect(disabled.stderr).toContain('Fix: the proxy on this socket does not serve the broker.');
    expect(disabled.stderr).toContain('run `aquaman daemon` instead');

    reply = { status: 404, body: { error: 'Credential not found: github/token', fix: 'Run: aquaman credentials add github token' } };
    const missing = await sb.run(['get', REF]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Error: Credential not found: github/token');
    expect(missing.stderr).toContain('Fix: Run: aquaman credentials add github token');

    // A 200 whose value is not a string is not a credential.
    reply = { status: 200, body: { value: 42 } };
    const odd = await sb.run(['get', REF]);
    expect(odd.code).toBe(1);
    expect(odd.stdout).toBe('');
    expect(odd.stderr.trim()).toBe('Error: Broker error (HTTP 200)');
  }, T * 2);

  it('names a socket it may not connect to, and one that is not a socket at all', async () => {
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { value: 'ghp_must_not_be_read' }));
    fs.chmodSync(sb.socket, 0o000);
    const blocked = await sb.run(['get', REF]);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain(`Error: Connecting to ${sb.socket} was denied (EACCES)`);
    expect(blocked.stderr).toContain('Fix: If this runs inside a sandbox, allowlist the socket');
    fs.chmodSync(sb.socket, 0o600);
    await proxy.close();
    proxy = undefined;

    fs.writeFileSync(sb.socket, 'not a socket');
    const notSocket = await sb.run(['get', REF]);
    expect(notSocket.code).toBe(1);
    expect(notSocket.stdout).toBe('');
    expect(notSocket.stderr).toMatch(/^Error: /);
  }, T * 2);
});
