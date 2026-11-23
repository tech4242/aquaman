/**
 * Ask first and `credentials.links`: what a reference is does not follow
 * from config.yaml alone.
 *
 * Any program running as the user can write a line into `credentials.links`
 * without a dialog. A line nobody approved reads nothing, so it gives a
 * reference no other identity: it cannot make two names into one item, and it
 * cannot hide the item a name is kept in from the tier that is never handed
 * out over the loopback listener. A link a person approved does make two
 * names one item, and that is taken from the approval in the vault, so it
 * stands when the line is taken out of the file again.
 *
 * A yes to removing a mark removes the names the dialog showed, settled
 * before it was shown, and no others.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from 'aquaman-core';
import { createBrokerScope, AskFirstGate, promptMessage, type CredentialPrompter, type PromptRequest, type PromptResult } from 'aquaman-proxy';
import { LinkedStore } from '../../packages/proxy/src/core/credentials/linked-store.js';
import type { PromptLimiter } from '../../packages/proxy/src/service-consent.js';

function limiter(): PromptLimiter {
  let open = false;
  let times: number[] = [];
  return {
    cooldownMs: 10 * 60 * 1000,
    windowMs: 10 * 60 * 1000,
    maxPerWindow: 6,
    isOpen: () => open,
    setOpen: (o) => { open = o; },
    times: () => times,
    setTimes: (t) => { times = t; },
    declinedAt: new Map(),
  };
}

const SHARED = 'keychain://login/shared-item';

describe('ask first: a link line in config.yaml and what a reference is', () => {
  let inner: MemoryStore;
  let links: ReadonlyMap<string, string>;
  let store: LinkedStore;
  let asked: PromptRequest[];
  let answers: PromptResult[];
  /** Runs while the dialog is up: what a program does to config.yaml meanwhile. */
  let meanwhile: (() => void) | undefined;
  let gate: AskFirstGate;

  const prompter = {
    async askApproval(request: PromptRequest): Promise<PromptResult> {
      asked.push(request);
      meanwhile?.();
      return answers.shift() ?? { outcome: 'declined' };
    },
  } as unknown as CredentialPrompter;

  beforeEach(async () => {
    inner = new MemoryStore();
    await inner.set('scratch', 'token', 'low-value');
    await inner.set('prod', 'deploy_key', 'high-value');
    links = new Map();
    store = new LinkedStore(inner, 'keychain', () => links);
    asked = [];
    answers = [];
    meanwhile = undefined;
    gate = new AskFirstGate({ store, prompter, limiter: limiter() });
  });

  it('a yes to unmark one reference does not unmark another that two unapproved lines point at the same locator while the dialog is up', async () => {
    await gate.mark('scratch', 'token');
    await gate.mark('prod', 'deploy_key');
    meanwhile = () => { links = new Map([['scratch/token', SHARED], ['prod/deploy_key', SHARED]]); };
    answers = [{ outcome: 'approved' }];

    const outcome = await gate.unmark('scratch', 'token', {}, () => []);
    expect(outcome.status).toBe('unmarked');
    // The person saw one name, and nothing about prod/deploy_key.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ service: 'scratch', key: 'token', unmark: true });
    expect(asked[0].sameItemAs).toBeUndefined();

    // The program takes its lines out again.
    links = new Map();
    gate.reload();
    expect(await gate.marks.list()).toEqual(['prod/deploy_key']);
    expect(await gate.marks.has('prod/deploy_key')).toBe(true);
  });

  it('the same two lines written before the command is run change nothing either: unapproved lines do not make two names one item', async () => {
    await gate.mark('scratch', 'token');
    await gate.mark('prod', 'deploy_key');
    links = new Map([['scratch/token', SHARED], ['prod/deploy_key', SHARED]]);
    answers = [{ outcome: 'approved' }];
    expect((await gate.unmark('scratch', 'token', {}, () => [])).status).toBe('unmarked');
    expect(asked[0].sameItemAs).toBeUndefined();
    expect(await gate.marks.list()).toEqual(['prod/deploy_key']);
  });

  it('a mark holds while an unapproved line for the reference is in config.yaml, and when it is gone again', async () => {
    await gate.mark('prod', 'deploy_key');
    links = new Map([['prod/deploy_key', 'keychain://login/whatever']]);
    expect(await gate.marks.has('prod/deploy_key')).toBe(true);
    links = new Map();
    expect(await gate.marks.has('prod/deploy_key')).toBe(true);
  });

  it('a yes about a reference is not a yes for another that an unapproved line points at the same locator', async () => {
    await gate.mark('scratch', 'token');
    await gate.mark('prod', 'deploy_key');
    answers = [{ outcome: 'approved' }];
    expect(await gate.authorize('scratch', 'token', { via: 'socket' })).toEqual({ ok: true });
    links = new Map([['scratch/token', SHARED], ['prod/deploy_key', SHARED]]);
    expect(await gate.authorize('prod', 'deploy_key', { via: 'socket', ask: false })).toMatchObject({ ok: false, code: 'ask_first_required' });
    // And the line reads nothing.
    await expect(store.get('prod', 'deploy_key')).rejects.toThrow('no approval');
  });

  it('a no about a reference is not carried to another by such lines, and is not lifted from the first', async () => {
    await gate.mark('scratch', 'token');
    await gate.mark('prod', 'deploy_key');
    expect(await gate.authorize('prod', 'deploy_key', { via: 'socket' })).toMatchObject({ ok: false, code: 'ask_first_declined' });
    links = new Map([['scratch/token', SHARED], ['prod/deploy_key', SHARED]]);
    expect(await gate.authorize('prod', 'deploy_key', { via: 'socket' })).toMatchObject({ ok: false, code: 'ask_first_declined' });
    expect(asked).toHaveLength(1);
  });

  describe('links a person approved', () => {
    beforeEach(async () => {
      // Two references a person linked to one item; nothing is stored under either name.
      await inner.delete('scratch', 'token');
      await inner.delete('prod', 'deploy_key');
      await store.approveLink('prod', 'deploy_key', SHARED);
      await store.approveLink('scratch', 'token', SHARED);
      links = new Map([['scratch/token', SHARED], ['prod/deploy_key', SHARED]]);
      await gate.mark('prod', 'deploy_key');
    });

    it('the other name of the item is asked about, and the dialog says which mark it is about', async () => {
      expect(await gate.marks.has('scratch/token')).toBe(true);
      await gate.authorize('scratch', 'token', { via: 'socket' });
      expect(asked[0].sameItemAs).toEqual(['prod/deploy_key']);
      expect(promptMessage(asked[0], 'approval').split('\n').at(-1)).toBe('This is the same vault item as the marked credential: prod/deploy_key');
    });

    it('taking the marked name\'s line out of config.yaml does not lift the mark from the item: the approval in the vault says what the name stands for', async () => {
      links = new Map([['scratch/token', SHARED]]);
      expect(await gate.marks.has('scratch/token')).toBe(true);
      expect(await gate.authorize('scratch', 'token', { via: 'socket', ask: false })).toMatchObject({ ok: false, code: 'ask_first_required' });
    });

    it('removing the mark under the other name removes the marked name the dialog showed, and the dialog says so', async () => {
      answers = [{ outcome: 'approved' }];
      expect((await gate.unmark('scratch', 'token', {}, () => [])).status).toBe('unmarked');
      expect(promptMessage(asked[0], 'approval').split('\n').at(-1)).toBe('This is the same vault item as the marked credential, whose mark is removed too: prod/deploy_key');
      expect(await gate.marks.list()).toEqual([]);
    });

    it('a name that becomes the same item while the dialog is up keeps its mark', async () => {
      await gate.mark('other', 'key');
      await store.approveLink('other', 'key', SHARED);
      // Not linked in config.yaml yet, and the approval alone already makes it stand for the item.
      // So start from one that has neither, and give it both while the dialog is up.
      await gate.mark('late', 'key');
      meanwhile = () => { links = new Map([...links, ['late/key', SHARED]]); };
      answers = [{ outcome: 'approved' }];
      expect((await gate.unmark('scratch', 'token', {}, () => [])).status).toBe('unmarked');
      expect(asked[0].sameItemAs).toEqual(['other/key', 'prod/deploy_key']);
      expect(await gate.marks.list()).toEqual(['late/key']);
    });
  });
});

describe('the tier kept off the loopback listener, and a link line on a name of an isolated service', () => {
  // A backend that titles an item aquaman-<service>-<key>, as onepassword.ts does.
  class Joined extends MemoryStore {
    itemIdentity(service: string, key: string): string { return `aquaman-${service}-${key}`; }
  }
  const scopeFor = (links: ReadonlyMap<string, string>) => {
    const store = new LinkedStore(new Joined(), '1password', () => links);
    return createBrokerScope({
      configPath: '/nonexistent/config.yaml',
      projectsPath: '/nonexistent/projects.yaml',
      allowedRefs: ['aquaman://openai-org/id', 'aquaman://github/token'],
      loopbackDeniedServices: ['openai'],
      itemIdentity: (service, key) => store.itemIdentity?.(service, key),
    });
  };

  it('openai-org/id is the item of openai/org-id and is not handed out over loopback', () => {
    expect(scopeFor(new Map()).check('openai-org', 'id', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
    expect(scopeFor(new Map()).check('github', 'token', 'loopback')).toEqual({ allowed: true });
  });

  const lines: Array<[string, Array<[string, string]>]> = [
    ['on the name the check probes with', [['openai/k', 'op://vault/item/field']]],
    ['on the name that is asked for', [['openai-org/id', 'op://vault/item/field']]],
    ['on both', [['openai/k', 'op://vault/a/field'], ['openai-org/id', 'op://vault/a/field']]],
  ];
  for (const [name, entries] of lines) {
    it(`a link line ${name} does not switch that off`, () => {
      expect(scopeFor(new Map(entries)).check('openai-org', 'id', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
    });
  }
});
