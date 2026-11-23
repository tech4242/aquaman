/**
 * Ask first: the record of marks in the vault, and the window a person's yes
 * lasts for. The endpoint and every way around the dialog are in
 * test/compliance/ask-first.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore, CachingStore, type CredentialStore } from 'aquaman-core';
import {
  AskFirstGate,
  AskFirstMarks,
  AskFirstFullError,
  ASK_FIRST_MAX_MARKS,
  RESERVED_SERVICE,
  windowText,
  promptMessage,
  type CredentialPrompter,
  type PromptRequest,
  type PromptResult,
} from 'aquaman-proxy';
import type { PromptLimiter } from '../../packages/proxy/src/service-consent.js';
import { CountingStore } from '../helpers/counting-store.js';

const KEY = 'ask_first';

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

describe('AskFirstMarks: the record in the vault', () => {
  let store: MemoryStore;
  let marks: AskFirstMarks;

  beforeEach(() => {
    store = new MemoryStore();
    marks = new AskFirstMarks(store);
  });

  it('no record marks nothing', async () => {
    expect(await marks.has('github/token')).toBe(false);
    expect(await marks.list()).toEqual([]);
  });

  it('is one item under the reserved service: { v: 1, refs: [...] }, sorted', async () => {
    expect(await marks.mark('slack/bot_token')).toBe(true);
    expect(await marks.mark('github/token')).toBe(true);
    expect(await store.get(RESERVED_SERVICE, KEY)).toBe('{"v":1,"refs":["github/token","slack/bot_token"]}');
    expect(await marks.has('github/token')).toBe(true);
    expect(await marks.has('github/other')).toBe(false);
  });

  it('marking twice and unmarking what is not marked change nothing', async () => {
    await marks.mark('github/token');
    expect(await marks.mark('github/token')).toBe(false);
    expect(await marks.unmark('slack/bot_token')).toBe(false);
    expect(await marks.list()).toEqual(['github/token']);
    expect(await marks.unmark('github/token')).toBe(true);
    expect(await store.get(RESERVED_SERVICE, KEY)).toBe('{"v":1,"refs":[]}');
  });

  it('is read once and then answered from memory, until it is told to forget', async () => {
    const counting = new CountingStore(store);
    const counted = new AskFirstMarks(counting);
    for (let i = 0; i < 5; i++) await counted.has('github/token');
    expect(counting.gets).toBe(1);
    // Written by another process, straight into the vault.
    await store.set(RESERVED_SERVICE, KEY, '{"v":1,"refs":["github/token"]}');
    expect(await counted.has('github/token')).toBe(false);
    counted.forget();
    expect(await counted.has('github/token')).toBe(true);
    expect(counting.gets).toBe(2);
  });

  it('a write reads the vault first, so a mark another process set is kept', async () => {
    await marks.has('github/token');
    await store.set(RESERVED_SERVICE, KEY, '{"v":1,"refs":["slack/bot_token"]}');
    await marks.mark('github/token');
    expect(await marks.list()).toEqual(['github/token', 'slack/bot_token']);
  });

  it('reads past a cache in front of the backend', async () => {
    const cached = new CachingStore(store, 900);
    await store.set(RESERVED_SERVICE, KEY, '{"v":1,"refs":[]}');
    expect(await cached.get(RESERVED_SERVICE, KEY)).toBe('{"v":1,"refs":[]}');
    await store.set(RESERVED_SERVICE, KEY, '{"v":1,"refs":["github/token"]}');
    expect(await cached.get(RESERVED_SERVICE, KEY)).toBe('{"v":1,"refs":[]}');
    expect(await new AskFirstMarks(cached).has('github/token')).toBe(true);
  });

  for (const raw of ['', 'x', 'null', '[]', '{}', '{"v":1}', '{"v":"1","refs":[]}', '{"v":1,"refs":[null]}', '{"v":1,"refs":["no-slash"]}', '{"v":1,"refs":["a/b/c d"]}']) {
    it(`a record that cannot be read as one marks everything: ${JSON.stringify(raw)}`, async () => {
      await store.set(RESERVED_SERVICE, KEY, raw);
      expect(await marks.has('github/token')).toBe(true);
      expect(await marks.has('anything/else')).toBe(true);
      expect(await marks.list()).toBe('all');
      // Marking writes no list over it: that would unmark the rest.
      expect(await marks.mark('github/token')).toBe(false);
      expect(await store.get(RESERVED_SERVICE, KEY)).toBe(raw);
    });
  }

  it('unmarking on such a record writes it again with the references in use still marked', async () => {
    await store.set(RESERVED_SERVICE, KEY, '{broken');
    expect(await marks.unmark('github/token', ['github/token', 'slack/bot_token', 'not a name', 'slack/bot_token'])).toBe(true);
    expect(await store.get(RESERVED_SERVICE, KEY)).toBe('{"v":1,"refs":["slack/bot_token"]}');
    expect(await marks.has('github/token')).toBe(false);
  });

  it('unmarking on such a record without the list of what stays marked writes nothing', async () => {
    await store.set(RESERVED_SERVICE, KEY, '{broken');
    await expect(marks.unmark('github/token')).rejects.toThrow('cannot be read as one');
    expect(await store.get(RESERVED_SERVICE, KEY)).toBe('{broken');
  });

  it('changes are made one after another: marks set together are all in the record', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `svc/key${String(i).padStart(2, '0')}`);
    expect(await Promise.all(names.map((n) => marks.mark(n)))).toEqual(names.map(() => true));
    expect(await marks.list()).toEqual(names);
    await Promise.all([marks.unmark(names[0]), marks.mark('late/key'), marks.unmark(names[1])]);
    expect(await marks.list()).toEqual(['late/key', ...names.slice(2)]);
  });

  it('a change that fails does not stop the ones queued after it', async () => {
    let writes = 0;
    const flaky = new MemoryStore();
    const set = flaky.set.bind(flaky);
    flaky.set = async (...args: Parameters<MemoryStore['set']>) => {
      if (writes++ === 0) throw new Error('vault write failed');
      return set(...args);
    };
    const m = new AskFirstMarks(flaky);
    const first = m.mark('a/b');
    const second = m.mark('c/d');
    await expect(first).rejects.toThrow('vault write failed');
    expect(await second).toBe(true);
    expect(await m.list()).toEqual(['c/d']);
  });

  it('a read that was under way when the record was changed elsewhere is not kept', async () => {
    let release: (() => void) | undefined;
    const slow = new MemoryStore();
    const get = slow.get.bind(slow);
    let hold = true;
    slow.get = async (service: string, key: string) => {
      const value = await get(service, key);
      if (hold) await new Promise<void>((r) => { release = r; });
      return value;
    };
    const m = new AskFirstMarks(slow);
    const reading = m.has('github/token');
    await new Promise((r) => setTimeout(r, 5));
    // Another process writes the record and the daemon is told to read it again.
    await slow.set(RESERVED_SERVICE, KEY, '{"v":1,"refs":["github/token"]}');
    m.forget();
    hold = false;
    release!();
    expect(await reading).toBe(true);
    expect(await m.has('github/token')).toBe(true);
  });

  it(`holds ${ASK_FIRST_MAX_MARKS} names and refuses the next; a name already there still answers`, async () => {
    for (let i = 0; i < ASK_FIRST_MAX_MARKS; i++) await marks.mark(`svc/key${i}`);
    await expect(marks.mark('one/more')).rejects.toBeInstanceOf(AskFirstFullError);
    expect(await marks.mark('svc/key0')).toBe(false);
    expect((await marks.list() as string[]).length).toBe(ASK_FIRST_MAX_MARKS);
    await marks.unmark('svc/key0');
    expect(await marks.mark('one/more')).toBe(true);
  });

  it('on a store where two names can be one item, a name is marked when a marked name is the same item', async () => {
    class JoinedStore extends MemoryStore {
      itemIdentity(service: string, key: string): string { return `${service}-${key}`; }
    }
    const m = new AskFirstMarks(new JoinedStore());
    await m.mark('cloudflare-ai/api_key');
    expect(await m.has('cloudflare/ai-api_key')).toBe(true);
    expect(await m.has('cloudflare/other')).toBe(false);
    expect(await m.sameItemAs('cloudflare/ai-api_key')).toEqual(['cloudflare-ai/api_key']);
    expect(await m.sameItemAs('cloudflare-ai/api_key')).toEqual([]);
    // The list is what was marked, by name.
    expect(await m.list()).toEqual(['cloudflare-ai/api_key']);
    // Removing the mark under the other name removes it: the item is what was asked about.
    expect(await m.unmark('cloudflare/ai-api_key')).toBe(true);
    expect(await m.list()).toEqual([]);
    expect(await m.has('cloudflare-ai/api_key')).toBe(false);
  });

  it('a vault that cannot be read is an error, not "nothing is marked"', async () => {
    const locked = { get: async () => { throw new Error('locked'); } } as unknown as CredentialStore;
    await expect(new AskFirstMarks(locked).has('github/token')).rejects.toThrow('locked');
  });
});

describe('AskFirstGate: the window', () => {
  let store: MemoryStore;
  let clock: number;
  let asked: PromptRequest[];
  let answer: PromptResult;
  let gate: AskFirstGate;

  const prompter: CredentialPrompter = {
    askValue: async () => ({ outcome: 'declined' }),
    askApproval: async (request) => { asked.push(request); return answer; },
    askLoginItem: async () => ({ outcome: 'declined' }),
  };
  const make = (windowSeconds?: number) => new AskFirstGate({ store, prompter, limiter: limiter(), windowSeconds, now: () => clock });
  const read = () => gate.authorize('github', 'token', { via: 'socket' });

  beforeEach(async () => {
    store = new MemoryStore();
    clock = 1_000_000;
    asked = [];
    answer = { outcome: 'approved' };
    gate = make(120);
    await gate.mark('github', 'token');
  });

  it('eight hours when nothing is configured', () => {
    expect(make().windowSeconds).toBe(28_800);
  });

  it('a yes lasts exactly the window, measured from the answer', async () => {
    expect(await read()).toEqual({ ok: true });
    clock += 119_999;
    expect(await read()).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
    clock += 1;
    answer = { outcome: 'declined' };
    expect(await read()).toMatchObject({ ok: false, code: 'ask_first_declined' });
    expect(asked).toHaveLength(2);
  });

  it('the dialog is told the window the gate keeps', async () => {
    await read();
    expect(asked[0].read).toEqual({ windowSeconds: 120, via: 'socket' });
    expect(promptMessage(asked[0], 'approval')).toContain('for the next 2 minutes (or until aquaman is restarted or its vault is locked)');
  });

  it('one yes covers one reference', async () => {
    await gate.mark('github', 'other');
    await read();
    await gate.authorize('github', 'other', { via: 'socket' });
    expect(asked.map((r) => r.key)).toEqual(['token', 'other']);
  });

  it('approvals live in the gate: a new one over the same vault asks again', async () => {
    await read();
    gate = make(120);
    await read();
    expect(asked).toHaveLength(2);
  });

  it('removing a mark ends its approval, so marking it again asks again', async () => {
    await read();
    expect((await gate.unmark('github', 'token', {}, () => [])).status).toBe('unmarked');
    expect(await read()).toEqual({ ok: true });
    await gate.mark('github', 'token');
    await read();
    // The first read, the removal, and the read after the mark came back.
    expect(asked).toHaveLength(3);
  });

  it('a no is not asked about again for ten minutes, and is asked about after that', async () => {
    answer = { outcome: 'declined' };
    await read();
    clock += 10 * 60 * 1000 - 1;
    expect(await read()).toMatchObject({ ok: false, code: 'ask_first_declined' });
    expect(asked).toHaveLength(1);
    expect(await gate.wouldServe('github', 'token')).toBe(false);
    clock += 1;
    expect(await gate.wouldServe('github', 'token')).toBe(true);
    await read();
    expect(asked).toHaveLength(2);
  });

  it('a reference that is not marked is never asked about', async () => {
    expect(await gate.authorize('plain', 'key', { via: 'loopback' })).toEqual({ ok: true });
    expect(await gate.wouldServe('plain', 'key')).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('windowText', () => {
  const rows: Array<[number, string]> = [
    [28_800, '8 hours'], [3600, '1 hour'], [5400, '90 minutes'], [60, '1 minute'], [86_400, '24 hours'], [90, '90 seconds'], [61, '61 seconds'],
  ];
  for (const [seconds, text] of rows) {
    it(`${seconds} seconds is "${text}"`, () => expect(windowText(seconds)).toBe(text));
  }
});
