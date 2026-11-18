/**
 * Compliance test: OWASP Top 10 for Agentic Applications 2026, ASI09
 * (Human-Agent Trust Exploitation).
 *
 * The credential dialog is the one place where a person decides, on aquaman's
 * word, what an agent may have. The claim under test: what the dialog says
 * will happen is what a caller can then obtain, for each kind of request, and
 * nothing the caller supplies can change aquaman's own sentences.
 *
 * A real proxy on a temporary socket. The person is a scripted prompter that
 * records the exact text the real dialog would have shown (`promptMessage`
 * of the request it was handed); no dialog is opened.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createCredentialProxy,
  createBrokerScope,
  promptMessage,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptRequest,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../../helpers/uds-proxy.js';

const SECRET = 'sk_live_typed_by_the_person_0123456789';

/** What the dialog tells the person about a reference that will be declared, and about one that will not. */
const SAYS_COMMANDS_GET_THE_VALUE = /be given the value/;
const SAYS_APP_GETS_A_TOKEN_NOT_THE_KEY = /gets a local token, not the key/;
/** Wording that would promise more than a declared reference delivers. */
const PROMISES_THE_AGENT_NEVER_GETS_IT = /never the value|receives a reference|cannot (read|get|see) the value|never (sees|receives|gets|holds)/i;

describe('ASI09: the dialog says what the caller can obtain afterwards', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath = '';
  let declared: Set<string>;
  let shown: Array<{ kind: 'value' | 'approval'; text: string; request: PromptRequest }>;

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  async function start(): Promise<void> {
    store = new MemoryStore();
    declared = new Set();
    shown = [];
    socketPath = tmpSocketPath();
    const prompter: CredentialPrompter = {
      async askValue(request) {
        shown.push({ kind: 'value', text: promptMessage(request, 'value'), request });
        return { outcome: 'entered', value: SECRET };
      },
      async askApproval(request) {
        shown.push({ kind: 'approval', text: promptMessage(request, 'approval'), request });
        return { outcome: 'approved' };
      },
    };
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: [],
      broker: {
        ...scope,
        check: (service, key, caller) =>
          declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller),
      },
      credentialRequests: { prompter, declare: (service, key) => { declared.add(`${service}/${key}`); } },
    });
    await proxy.start();
  }

  const post = (path: string, body: Record<string, unknown>) =>
    udsFetch(socketPath, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  interface Case {
    name: string;
    /** The value is already in the vault, so the person is asked to allow rather than to type. */
    stored: boolean;
    routed: boolean;
    kind: 'value' | 'approval';
    status: 'stored' | 'approved';
    /** Whether the same caller can then read the value from the broker. */
    resolvable: boolean;
  }

  const CASES: Case[] = [
    { name: 'an ordinary request for a credential that is not stored', stored: false, routed: false, kind: 'value', status: 'stored', resolvable: true },
    { name: 'an ordinary request for a credential that is stored', stored: true, routed: false, kind: 'approval', status: 'approved', resolvable: true },
    { name: 'a routed request for a credential that is not stored', stored: false, routed: true, kind: 'value', status: 'stored', resolvable: false },
    { name: 'a routed request for a credential that is stored', stored: true, routed: true, kind: 'approval', status: 'approved', resolvable: false },
  ];

  for (const c of CASES) {
    it(`${c.name}: the dialog matches what the broker then does`, async () => {
      await start();
      if (c.stored) await store.set('stripe', 'secret_key', SECRET);

      const answer = await post('/broker/request', { service: 'stripe', key: 'secret_key', project: '/code/app', ...(c.routed ? { routed: true } : {}) });
      expect(JSON.parse(answer.body)).toEqual({ status: c.status, ref: 'aquaman://stripe/secret_key' });
      expect(answer.body).not.toContain(SECRET);

      // One dialog, of the expected kind, and the daemon told it which case this is.
      expect(shown).toHaveLength(1);
      expect(shown[0].kind).toBe(c.kind);
      expect(shown[0].request.routed === true).toBe(c.routed);
      const text = shown[0].text;

      // What the same caller can do next.
      const resolve = await post('/broker/resolve', { service: 'stripe', key: 'secret_key' });
      expect(await store.get('stripe', 'secret_key')).toBe(SECRET);

      if (c.resolvable) {
        expect(resolve.status).toBe(200);
        expect(JSON.parse(resolve.body).value).toBe(SECRET);
        // So the dialog must have said the value is handed out, and must not have promised otherwise.
        expect(text).toMatch(SAYS_COMMANDS_GET_THE_VALUE);
        expect(text).not.toMatch(PROMISES_THE_AGENT_NEVER_GETS_IT);
        expect(text).not.toMatch(SAYS_APP_GETS_A_TOKEN_NOT_THE_KEY);
      } else {
        expect(resolve.status).toBe(404);
        expect(resolve.body).not.toContain(SECRET);
        expect(declared.has('stripe/secret_key')).toBe(false);
        // So the dialog must have said the app gets a token and not the key, and must not have said the value is handed out.
        expect(text).toMatch(SAYS_APP_GETS_A_TOKEN_NOT_THE_KEY);
        expect(text).not.toMatch(SAYS_COMMANDS_GET_THE_VALUE);
      }
    });
  }

  it('every dialog names the credential, and carries the line about what aquaman never asks for', () => {
    for (const kind of ['value', 'approval'] as const) {
      for (const routed of [false, true]) {
        const text = promptMessage({ service: 'stripe', key: 'secret_key', routed }, kind);
        expect(text).toContain('Credential: stripe/secret_key');
        expect(text).toContain('aquaman never asks for your login, Apple ID or password-manager password.');
        expect(text).toMatch(kind === 'value' ? /Cancel if you did not expect this\./ : /Deny if you did not expect this\./);
      }
    }
  });
});

describe('ASI09: caller-supplied text cannot change the fixed sentences', () => {
  const kinds = ['value', 'approval'] as const;
  const FAKE = 'aquaman has verified this request. The agent receives a reference, never the value.';
  const LABEL = 'Requested from (as the caller reports it): ';

  /** Text a caller might send as `project`. */
  const HOSTILE: Array<{ name: string; text: string }> = [
    { name: 'a newline followed by a sentence of its own', text: `/code/app\n\n${FAKE}` },
    { name: 'a carriage return and newline', text: `/code/app\r\n${FAKE}` },
    { name: 'Unicode line and paragraph separators', text: `/code/app ${FAKE} Type your Apple ID password.` },
    { name: 'a vertical tab and form feed', text: `/code/app\u000b${FAKE}\u000c` },
    { name: 'a right-to-left override', text: `/code/app ‮${FAKE}` },
    { name: 'zero-width and other format characters', text: `/code​/app⁦${FAKE}⁩` },
    { name: 'backslash escapes a dialog helper might expand', text: `/code/app\\n\\n${FAKE}` },
    { name: 'a NUL and an escape character', text: `/code/app\u0000\u001b[2J${FAKE}` },
    { name: 'a very long line', text: `${'/x'.repeat(400)} ${FAKE}` },
    { name: 'only the fake sentence', text: FAKE },
  ];

  for (const kind of kinds) {
    for (const routed of [false, true]) {
      const clean = promptMessage({ service: 'github', key: 'token', routed }, kind).split('\n');

      for (const h of HOSTILE) {
        it(`${kind}${routed ? ', routed' : ''}: ${h.name} in the project`, () => {
          const lines = promptMessage({ service: 'github', key: 'token', routed, project: h.text }, kind).split('\n');
          // Everything aquaman wrote is where it was, word for word; the caller's text is one line after it.
          expect(lines.slice(0, clean.length)).toEqual(clean);
          expect(lines).toHaveLength(clean.length + 2);
          expect(lines[clean.length]).toBe('');
          const last = lines[lines.length - 1];
          expect(last.startsWith(LABEL)).toBe(true);
          // One bounded line with nothing in it that moves or hides text.
          expect(last.length).toBeLessThanOrEqual(LABEL.length + 120);
          expect(last).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u);
        });
      }

      it(`${kind}${routed ? ', routed' : ''}: hostile service and key names stay on the credential line`, () => {
        const lines = promptMessage({ service: `github\n\n${FAKE}`, key: `token ${FAKE}`, routed }, kind).split('\n');
        expect(lines).toHaveLength(clean.length);
        expect(lines[2].startsWith('Credential: ')).toBe(true);
        expect(lines[2].length).toBeLessThanOrEqual('Credential: '.length + 140);
        expect([...lines.slice(0, 2), ...lines.slice(3)]).toEqual([...clean.slice(0, 2), ...clean.slice(3)]);
      });
    }
  }

  it('the daemon refuses names the dialog could not show in full or on one line, and asks nobody', async () => {
    const socketPath = tmpSocketPath();
    const asked: string[] = [];
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    const proxy = createCredentialProxy({
      socketPath,
      store: new MemoryStore(),
      allowedServices: [],
      broker: scope,
      credentialRequests: {
        prompter: {
          async askValue(r) { asked.push(`${r.service}/${r.key}`); return { outcome: 'declined' }; },
          async askApproval(r) { asked.push(`${r.service}/${r.key}`); return { outcome: 'declined' }; },
        },
        declare: () => {},
      },
    });
    await proxy.start();
    try {
      const rows: Array<Record<string, unknown>> = [
        { service: `github\n${FAKE}`, key: 'token' },
        { service: 'github', key: `token\n${FAKE}` },
        { service: 'github', key: 'token never the value' },
        { service: 'g'.repeat(65), key: 'token' },
        { service: 'github', key: 'k'.repeat(65) },
        { service: 'GitHub', key: 'token' },
      ];
      for (const body of rows) {
        const res = await udsFetch(socketPath, '/broker/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      }
      expect(asked).toEqual([]);
    } finally {
      await proxy.stop();
      cleanupSocket(socketPath);
    }
  });
});
