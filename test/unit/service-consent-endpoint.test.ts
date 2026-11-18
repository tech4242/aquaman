/**
 * `POST /_service/consent` on a real proxy: the daemon asks the person, in a
 * dialog, whether aquaman may add a login item. The person is a scripted
 * prompter; the real dialog lives in credential-prompt.ts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createCredentialProxy,
  createBrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { SERVICE_CONSENT_PATH } from '../../packages/proxy/src/service-consent.js';

const LOOPBACK_TOKEN = 'aqm_lb_service_consent_test_token_0123456789';

describe('POST /_service/consent', () => {
  let proxy: CredentialProxy;
  let socketPath: string;
  let asked: string[];
  let waits: Array<number | undefined>;
  let log: RequestInfo[];

  afterEach(async () => {
    vi.useRealTimers();
    if (proxy?.isRunning()) await proxy.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  async function start(opts: {
    login?: PromptResult | (() => Promise<PromptResult>);
    withRequests?: boolean;
    withScope?: boolean;
    loopback?: boolean;
    routed?: string[];
    withoutLoginMethod?: boolean;
  } = {}) {
    asked = [];
    waits = [];
    log = [];
    socketPath = tmpSocketPath();
    const prompter: CredentialPrompter = {
      async askValue(r) { asked.push(`value:${r.service}/${r.key}`); return { outcome: 'declined' }; },
      async askApproval(r) { asked.push(`approval:${r.service}/${r.key}`); return { outcome: 'declined' }; },
      async askLoginItem(r) {
        asked.push('login-item');
        waits.push(r.timeoutSeconds);
        const v = opts.login ?? { outcome: 'approved' };
        return typeof v === 'function' ? v() : v;
      },
    };
    if (opts.withoutLoginMethod) delete (prompter as Partial<CredentialPrompter>).askLoginItem;
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store: new MemoryStore(),
      allowedServices: ['github'],
      broker: opts.withScope === false ? undefined : { ...scope, routedRefs: () => new Set((opts.routed ?? []).map((r) => `aquaman://${r}`)) },
      credentialRequests: opts.withRequests === false ? undefined : { prompter, declare: () => {} },
      loopback: opts.loopback ? { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' } : undefined,
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const post = (url: string, body?: string) =>
    udsFetch(socketPath, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const consent = (body: Record<string, unknown> = {}) => post(SERVICE_CONSENT_PATH, JSON.stringify(body));
  const consentAudit = () => log.filter((r) => r.path === SERVICE_CONSENT_PATH);

  it('approved: the person allowed it, and the reply is the status alone', async () => {
    await start();
    const res = await consent();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ status: 'approved' });
    expect(asked).toEqual(['login-item']);
  });

  it('answers on the path with a trailing slash too, with an empty body, and waits the default time', async () => {
    await start();
    expect(JSON.parse((await post(`${SERVICE_CONSENT_PATH}/`)).body)).toEqual({ status: 'approved' });
    expect(waits).toEqual([90]);
  });

  it('passes the caller\'s wait to the dialog, held inside the allowed range', async () => {
    await start();
    await consent({ timeout_seconds: 20 });
    await consent({ timeout_seconds: 1 });
    await consent({ timeout_seconds: 100000 });
    await consent({ timeout_seconds: 'soon' });
    expect(waits).toEqual([20, 10, 600, 90]);
  });

  it('declined: says so without a command that would do what the person refused, and does not ask again for ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await start({ login: { outcome: 'declined' } });
    const first = JSON.parse((await consent()).body);
    expect(first).toEqual({ status: 'declined', reason: 'the person at the dialog said no' });
    expect(first.fix).toBeUndefined();

    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    const again = JSON.parse((await consent()).body);
    expect(again).toEqual({ status: 'declined', reason: 'declined a few minutes ago; not asking again yet' });
    expect(again.fix).toBeUndefined();
    expect(asked).toEqual(['login-item']);

    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    await consent();
    expect(asked).toEqual(['login-item', 'login-item']);
  });

  it.each([
    ['nobody answered', { outcome: 'timeout' } as PromptResult, 'nobody answered the dialog'],
    ['no dialog could be shown', { outcome: 'unavailable', reason: 'the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)' } as PromptResult, 'the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)'],
    // The dialog takes no text; a prompter that returns some has not given an approval.
    ['a typed value came back', { outcome: 'entered', value: 'yes' } as PromptResult, 'the dialog did not return an approval'],
  ])('pending when %s, with the step for a person', async (_name, result, reason) => {
    await start({ login: result });
    expect(JSON.parse((await consent()).body)).toEqual({ status: 'pending', reason, fix: 'Run in a terminal: aquaman service install' });
  });

  it('pending when the prompter throws or has no login-item dialog, and the next request can still be asked', async () => {
    await start({ login: async () => { throw new Error('osascript went away'); } });
    expect(JSON.parse((await consent()).body)).toMatchObject({ status: 'pending', reason: 'osascript went away' });
    expect(JSON.parse((await consent()).body)).toMatchObject({ status: 'pending', reason: 'osascript went away' });
    expect(asked).toEqual(['login-item', 'login-item']);
    await proxy.stop();

    await start({ withoutLoginMethod: true });
    const res = JSON.parse((await consent()).body);
    expect(res.status).toBe('pending');
    expect(res.fix).toBe('Run in a terminal: aquaman service install');
  });

  it('one dialog at a time: a second request while one is open is pending, and so is a credential request', async () => {
    let release!: (r: PromptResult) => void;
    await start({ login: () => new Promise<PromptResult>((resolve) => { release = resolve; }) });
    const first = consent();
    await vi.waitFor(() => expect(asked).toEqual(['login-item']));

    expect(JSON.parse((await consent()).body)).toEqual({ status: 'pending', reason: 'another request is waiting for an answer', fix: 'Run in a terminal: aquaman service install' });
    const credential = JSON.parse((await post('/broker/request', JSON.stringify({ service: 'github', key: 'token' }))).body);
    expect(credential).toMatchObject({ status: 'pending', reason: 'another credential request is waiting for an answer' });
    expect(asked).toEqual(['login-item']);

    release({ outcome: 'approved' });
    expect(JSON.parse((await first).body)).toEqual({ status: 'approved' });
  });

  it('shares the rate limit with /broker/request: six dialogs in ten minutes, whichever endpoint showed them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await start({ login: { outcome: 'timeout' } });
    // Four credential dialogs (each declined, each for a different ref) and two login-item dialogs.
    for (const key of ['a', 'b', 'c', 'd']) await post('/broker/request', JSON.stringify({ service: 'github', key }));
    await consent();
    await consent();
    expect(asked.length).toBe(6);

    expect(JSON.parse((await consent()).body)).toEqual({ status: 'pending', reason: 'too many requests in a short time', fix: 'Run in a terminal: aquaman service install' });
    const credential = JSON.parse((await post('/broker/request', JSON.stringify({ service: 'github', key: 'e' }))).body);
    expect(credential).toMatchObject({ status: 'pending', reason: 'too many credential requests in a short time' });
    expect(asked.length).toBe(6);

    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1000);
    await consent();
    expect(asked.length).toBe(7);
  });

  it('a declined credential does not put the login item in its cooldown, nor the other way round', async () => {
    await start({ login: { outcome: 'declined' } });
    await post('/broker/request', JSON.stringify({ service: 'github', key: 'token' }));
    expect(JSON.parse((await consent()).body).reason).toBe('the person at the dialog said no');
    await post('/broker/request', JSON.stringify({ service: 'github', key: 'other' }));
    expect(asked).toEqual(['value:github/token', 'login-item', 'value:github/other']);
  });

  it.each([
    ['no dialog machinery (an OpenClaw-hosted proxy)', { withRequests: false, withScope: false }],
    ['the broker switched off', { withScope: false }],
    ['a broker scope but no prompter', { withRequests: false }],
  ])('is off with %s, as /broker/request is: 404 broker_disabled and nobody asked', async (_name, opts) => {
    await start(opts);
    const res = await consent();
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Approval dialogs are disabled on this proxy',
      fix: 'OpenClaw-hosted proxies never show dialogs. Run in a terminal: aquaman service install',
      code: 'broker_disabled',
    });
    expect((await post('/broker/request', JSON.stringify({ service: 'github', key: 'token' }))).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it('is refused on the loopback listener: without a token, with the agent hosts\' token, and with a routed program\'s token', async () => {
    await start({ loopback: true, routed: ['github/token'] });
    await (proxy as any).options.store.set('github', 'token', 'ghp_real');
    const origin = `http://${proxy.getLoopbackAddress()}`;
    const routeToken = JSON.parse((await post('/broker/route', JSON.stringify({ service: 'github', key: 'token' }))).body).token as string;
    expect(routeToken).toMatch(/^aqm_rt_/);

    const attempts: Array<[string, Record<string, string>, number, string | undefined]> = [
      ['no token', {}, 401, undefined],
      ['the loopback token', { 'x-aquaman-token': LOOPBACK_TOKEN }, 404, 'service_consent_local_only'],
      ['the loopback token as a bearer', { Authorization: `Bearer ${LOOPBACK_TOKEN}` }, 404, 'service_consent_local_only'],
      ['the route token', { Authorization: `Bearer ${routeToken}` }, 401, undefined],
      ['the route token in every header', { Authorization: `Bearer ${routeToken}`, 'x-api-key': routeToken, 'x-aquaman-token': routeToken }, 401, undefined],
    ];
    for (const [name, headers, status, code] of attempts) {
      for (const url of [SERVICE_CONSENT_PATH, `${SERVICE_CONSENT_PATH}/`]) {
        const res = await fetch(`${origin}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
        expect(res.status, name).toBe(status);
        const body = await res.json() as { status?: string; code?: string };
        expect(body.status, name).toBeUndefined();
        expect(body.code, name).toBe(code);
      }
    }
    expect(asked).toEqual([]);
    // The same request over the socket is asked.
    expect(JSON.parse((await consent()).body)).toEqual({ status: 'approved' });
  });

  it('only POST is the endpoint: a GET is not a consent request and asks nobody', async () => {
    await start();
    const res = await udsFetch(socketPath, SERVICE_CONSENT_PATH);
    expect(res.status).not.toBe(200);
    expect(asked).toEqual([]);
  });

  it.each([
    ['not JSON', 'yes please', 'Request body is not a JSON object'],
    ['a JSON string', '"approved"', 'Request body is not a JSON object'],
    ['null', 'null', 'Request body is not a JSON object'],
    ['too large', JSON.stringify({ pad: 'x'.repeat(2000) }), 'Request body too large'],
  ])('refuses a body that is %s with 400, before asking', async (_name, body, error) => {
    await start();
    const res = await post(SERVICE_CONSENT_PATH, body);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error, fix: 'POST {} or { "timeout_seconds": <number> }' });
    expect(asked).toEqual([]);
    expect(consentAudit()).toEqual([]);
  });

  it('audits every outcome of the dialog: an approval as a success, a no and a non-answer as what they were', async () => {
    const outcomes: PromptResult[] = [{ outcome: 'approved' }, { outcome: 'timeout' }, { outcome: 'declined' }];
    await start({ login: async () => outcomes.shift()! });
    await consent();
    await consent();
    await consent();
    await consent(); // inside the cooldown: nobody asked, still recorded
    await vi.waitFor(() => expect(consentAudit().length).toBe(4));
    expect(consentAudit().map((r) => ({ service: r.service, method: r.method, statusCode: r.statusCode, authenticated: r.authenticated, error: r.error }))).toEqual([
      { service: 'aquaman-service', method: 'SERVICE_CONSENT', statusCode: 200, authenticated: false, error: undefined },
      { service: 'aquaman-service', method: 'SERVICE_CONSENT', statusCode: 200, authenticated: false, error: 'pending: login item' },
      { service: 'aquaman-service', method: 'SERVICE_CONSENT', statusCode: 200, authenticated: false, error: 'declined: login item' },
      { service: 'aquaman-service', method: 'SERVICE_CONSENT', statusCode: 200, authenticated: false, error: 'declined: login item' },
    ]);
    expect(asked.length).toBe(3);
  });

  it('audits a request turned away by the limits', async () => {
    let release!: (r: PromptResult) => void;
    await start({ login: () => new Promise<PromptResult>((resolve) => { release = resolve; }) });
    const first = consent();
    await vi.waitFor(() => expect(asked).toEqual(['login-item']));
    await consent();
    release({ outcome: 'approved' });
    await first;
    await vi.waitFor(() => expect(consentAudit().map((r) => r.error)).toEqual(['pending: login item', undefined]));
  });
});
