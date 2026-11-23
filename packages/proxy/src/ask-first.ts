/**
 * Ask first: a reference a person marked is handed out only after a person
 * allowed it in the daemon's dialog, and a yes is remembered for a window.
 *
 * Declaring a reference lets every program running as the user read its value
 * from `POST /broker/resolve`. For most references that is the point. For the
 * ones where it is not, the mark puts a person in front of the first read:
 * the daemon shows its dialog, and a yes covers that one reference until the
 * window ends or the daemon stops.
 *
 * Three pieces:
 *
 *   - `AskFirstMarks`: which references are marked. One record in the vault,
 *     under the reserved service, so editing config.yaml or projects.yaml
 *     cannot remove a mark.
 *   - `AskFirstGate`: the check every path that returns a value goes through
 *     before the vault read (`/broker/resolve` on both listeners, the
 *     OpenShell driver's Resolve), and forwarding for a service that
 *     services.yaml defines, whose upstream is whatever that file says. It
 *     owns the approvals, which live in this process's memory only.
 *   - `handleAskFirst`: `POST /broker/ask-first`, where a mark is set (which
 *     tightens, so nobody is asked) and removed (which loosens, so a person
 *     decides in the dialog).
 *
 * What this is not: a boundary between programs of one user. The daemon
 * cannot tell which program is asking, so a yes is a yes for all of them
 * until the window ends, and software that can write to the vault itself can
 * delete the record. The dialog says the first; the docs say both.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CredentialStore } from './core/credentials/store.js';
import { RESERVED_SERVICE, ASK_FIRST_KEY, isReservedService } from './core/credentials/reserved.js';
import { clampPromptTimeout, type CredentialPrompter, type PromptResult, type ReadVia } from './credential-prompt.js';
import type { PromptLimiter } from './service-consent.js';
import { isVaultLocked, VaultLockedError, VAULT_LOCKED_CODE, VAULT_UNLOCK_FIX } from './core/credentials/vault-lock.js';

export const ASK_FIRST_PATH = '/broker/ask-first';

/** How long a yes lasts when config.yaml does not say: eight hours, a working day. */
export const ASK_FIRST_WINDOW_SECONDS = 8 * 60 * 60;
export const ASK_FIRST_WINDOW_MIN_SECONDS = 60;
export const ASK_FIRST_WINDOW_MAX_SECONDS = 24 * 60 * 60;

/**
 * `broker.askFirstWindowSeconds` held inside the allowed range; the default
 * for anything that is not a number. The upper bound is what keeps an edited
 * config.yaml from turning one yes into a standing permission.
 */
export function clampAskFirstWindow(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return ASK_FIRST_WINDOW_SECONDS;
  return Math.min(ASK_FIRST_WINDOW_MAX_SECONDS, Math.max(ASK_FIRST_WINDOW_MIN_SECONDS, Math.round(seconds)));
}

const NAME = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * The most names the record holds. Marking asks nobody and removing a mark
 * takes a dialog each, so without a bound a program could pile up marks
 * faster than a person can clear them, in a record every resolve consults.
 */
export const ASK_FIRST_MAX_MARKS = 256;

/** The record is full: nothing more is marked until a mark is removed. */
export class AskFirstFullError extends Error {
  readonly code = 'ask_first_full';
  readonly fix = 'Remove a mark that is no longer needed (aquaman broker list shows them): aquaman broker ask <ref> --off';

  constructor() {
    super(`The ask-first record holds ${ASK_FIRST_MAX_MARKS} references, which is the most it takes`);
    this.name = 'AskFirstFullError';
  }
}

/** What the record says: these references, or (a record that cannot be read as one) every reference. */
type Marked = Set<string> | 'all';

/**
 * The marks, kept in the vault as one record:
 * `{ v: 1, refs: ["<service>/<key>", ...] }` under the reserved service.
 *
 * A record that is there and cannot be read as one marks every reference.
 * Something was marked and it is no longer possible to say what, so the
 * daemon asks about everything: the person is still in front of each read,
 * and can still say yes. Reading it as "nothing is marked" would let a
 * damaged record switch the dialog off.
 *
 * The record is read once and then answered from memory, because on some
 * backends every read costs a prompt or a process. It is read again after
 * `forget()`: the daemon calls that when it is told the record changed.
 */
export class AskFirstMarks {
  private cached: Marked | undefined;
  /** Counts `forget()`, so a read that was under way when the record changed is not kept. */
  private generation = 0;
  /** Every read and every change of the record, one after another. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private store: CredentialStore) {}

  /**
   * Run `step` after everything queued before it. A change is "read the
   * record, alter it, write it back"; two of them interleaved would each
   * write a list that lacks the other's name, and the daemon would have
   * answered "marked" for a reference that is not.
   */
  private queued<T>(step: () => Promise<T>): Promise<T> {
    const run = this.chain.then(step, step);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Marked> {
    // Past a cache in front of the backend, where there is one: this read
    // happens because the record may have changed.
    const fresh = (this.store as { getFresh?: (service: string, key: string) => Promise<string | null> }).getFresh;
    let marked: Marked = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      const generation = this.generation;
      const raw = fresh
        ? await fresh.call(this.store, RESERVED_SERVICE, ASK_FIRST_KEY)
        : await this.store.get(RESERVED_SERVICE, ASK_FIRST_KEY);
      marked = new Set<string>();
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const record = parsed as { v?: unknown; refs?: unknown } | null;
        if (
          record !== null && typeof record === 'object' && record.v === 1 &&
          Array.isArray(record.refs) && record.refs.every((r) => typeof r === 'string' && NAME.test(r))
        ) {
          marked = new Set(record.refs as string[]);
        } else {
          marked = 'all';
        }
      }
      // Told to forget while the vault was being read: what came back may
      // be the record as it was before the change, so read it again.
      if (generation === this.generation) {
        this.cached = marked;
        break;
      }
    }
    return marked;
  }

  private current(): Promise<Marked> {
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    return this.queued(async () => this.cached ?? this.read());
  }

  private async save(set: Set<string>): Promise<void> {
    const generation = this.generation;
    await this.store.set(RESERVED_SERVICE, ASK_FIRST_KEY, JSON.stringify({ v: 1, refs: [...set].sort() }));
    if (generation === this.generation) this.cached = set;
  }

  /**
   * What a name is compared on: the item the store reads it from, where two
   * names can be one item, and the name itself everywhere else.
   */
  identity(name: string): string {
    if (!this.store.itemIdentity) return name;
    const slash = name.indexOf('/');
    return this.store.itemIdentity(name.slice(0, slash), name.slice(slash + 1));
  }

  /** The marked names that are read from the same item as `name`, `name` itself left out. */
  private sameItemIn(marked: Set<string>, name: string): string[] {
    if (!this.store.itemIdentity) return [];
    const identity = this.identity(name);
    return [...marked].filter((other) => other !== name && this.identity(other) === identity).sort();
  }

  /**
   * Whether `<service>/<key>` is marked: by its own name, or because a
   * marked name is read from the same item. Throws when the vault cannot be
   * read: the caller hands nothing out.
   */
  async has(name: string): Promise<boolean> {
    const marked = await this.current();
    return marked === 'all' || marked.has(name) || this.sameItemIn(marked, name).length > 0;
  }

  /** The marked names, other than `name`, that are the same item as `name`. For the dialog. */
  async sameItemAs(name: string): Promise<string[]> {
    const marked = await this.current();
    return marked === 'all' ? [] : this.sameItemIn(marked, name);
  }

  /** The marked references, or `'all'` for a record that cannot be read as one. */
  async list(): Promise<string[] | 'all'> {
    const marked = await this.current();
    return marked === 'all' ? 'all' : [...marked].sort();
  }

  /**
   * Mark a reference. Returns whether it was not marked before. Throws
   * `AskFirstFullError` when the record holds `ASK_FIRST_MAX_MARKS` names.
   */
  mark(name: string): Promise<boolean> {
    return this.queued(async () => {
      const marked = await this.read();
      // Everything is marked already, and writing a list here would unmark the rest.
      if (marked === 'all' || marked.has(name)) return false;
      if (marked.size >= ASK_FIRST_MAX_MARKS) throw new AskFirstFullError();
      const next = new Set(marked).add(name);
      await this.save(next);
      return true;
    });
  }

  /**
   * Remove a mark, after a person agreed. Returns whether there was one. A
   * marked name that is read from the same item goes with it: the item is
   * what the person was asked about, and it would stay gated otherwise.
   *
   * On a record that cannot be read as one, every reference counts as marked
   * and the person agreed about this one only. `keep` is the list the person
   * was shown, fixed before they were asked; the record is written again
   * with exactly those names marked.
   */
  unmark(name: string, keep?: readonly string[]): Promise<boolean> {
    return this.queued(async () => {
      const marked = await this.read();
      if (marked === 'all') {
        // Without the list nothing is written: an empty one would unmark everything.
        if (keep === undefined) {
          throw new Error('The ask-first record cannot be read as one, and the references that stay marked were not settled before asking. Run the command again');
        }
        await this.save(new Set(keepable(keep, name)));
        return true;
      }
      const gone = [name, ...this.sameItemIn(marked, name)].filter((n) => marked.has(n));
      if (gone.length === 0) return false;
      const next = new Set(marked);
      for (const n of gone) next.delete(n);
      await this.save(next);
      return true;
    });
  }

  /** Drop the copy in memory, so the next question is answered from the vault. */
  forget(): void {
    this.cached = undefined;
    this.generation++;
  }
}

/**
 * The names that stay marked when one mark is removed from a record that
 * cannot be read: the references in use, without the one the person is asked
 * about, each once and in order. More than the record takes is an error, not
 * a shorter list: a name left off would lose its mark without anyone seeing.
 */
export function keepable(names: readonly string[], removed: string): string[] {
  const keep = [...new Set(names.filter((n) => NAME.test(n) && n !== removed))].sort();
  if (keep.length > ASK_FIRST_MAX_MARKS) throw new AskFirstFullError();
  return keep;
}

export type AskFirstCode =
  /** A person said no, now or within the cooldown. Carries no `fix`. */
  | 'ask_first_declined'
  /** The dialog went unanswered, or could not be opened because another one is up or too many were shown. */
  | 'ask_first_unanswered'
  /** The caller asked not to raise a dialog, and nobody has allowed the reference in the current window. */
  | 'ask_first_required'
  /** This daemon cannot show a dialog at all. */
  | 'prompt_unavailable';

export type AskFirstDecision =
  | { ok: true }
  | { ok: false; code: AskFirstCode; error: string; fix?: string };

export interface AskFirstRequest {
  /**
   * How the request reached the daemon. Aquaman's own knowledge, and all it
   * knows about the caller. A request on the loopback listener never raises
   * a dialog: whoever holds the local token could otherwise put one on the
   * person's screen from wherever it runs, and the person in front of the
   * machine has no way to connect it with anything they did.
   */
  via: ReadVia | 'loopback';
  /** With `via: 'forward'`: where the value would be sent, as services.yaml gives it. */
  upstream?: string;
  /** Where the caller says it is. Shown as the caller's own words. */
  project?: string;
  /** How long the dialog stays up. */
  timeoutSeconds?: number;
  /** `false`: answer at once, without a dialog, when nobody has allowed the reference in the current window. */
  ask?: boolean;
}

/** One outcome for the audit log. `error` is absent for a yes. Never a value. */
export interface AskFirstEvent {
  service: string;
  error?: string;
  note?: string;
}

export interface AskFirstGateOptions {
  store: CredentialStore;
  /** Absent on a daemon that cannot ask anyone; a marked reference is then refused. */
  prompter?: CredentialPrompter;
  /** The dialog counters `/broker/request` uses: one budget for every dialog this daemon shows. */
  limiter: PromptLimiter;
  /** `broker.askFirstWindowSeconds`, already clamped. */
  windowSeconds?: number;
  audit?: (event: AskFirstEvent) => void;
  now?: () => number;
}

/** The cooldown entry for a declined read. Not a bare reference, so declining a credential request does not count here. */
const readKey = (name: string) => `read:${name}`;
const unmarkKey = (name: string) => `unmark:${name}`;

export class AskFirstGate {
  readonly marks: AskFirstMarks;
  readonly windowSeconds: number;
  /**
   * The item a reference is read from, to the time its approval ends. Memory
   * only: a restarted daemon has none. Keyed by item, like the cooldowns and
   * the open dialogs, so a yes or a no about one name of an item is the
   * answer for its other names.
   */
  private approvedUntil = new Map<string, number>();
  /** A dialog that is up, so a second request for the same item waits for the same answer. */
  private asking = new Map<string, Promise<AskFirstDecision>>();
  private now: () => number;

  constructor(private opts: AskFirstGateOptions) {
    this.marks = new AskFirstMarks(opts.store);
    this.windowSeconds = opts.windowSeconds ?? ASK_FIRST_WINDOW_SECONDS;
    this.now = opts.now ?? Date.now;
  }

  private approved(id: string): boolean {
    const until = this.approvedUntil.get(id);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.approvedUntil.delete(id);
    return false;
  }

  /**
   * Forget every yes. Called when the vault's session is dropped or handed
   * over again: a person who locked the vault has taken back what they
   * allowed while it was open.
   */
  dropApprovals(): void {
    this.approvedUntil.clear();
  }

  /**
   * A vault the store knows to be locked: no value can be read, so nobody is
   * asked about one, and what was allowed while it was open is not carried
   * over to when it is opened again.
   */
  private refuseWhileLocked(): void {
    if (this.opts.store.vaultState?.() !== 'locked') return;
    this.dropApprovals();
    throw new VaultLockedError('The vault is locked, so no credential can be read. Run: aquaman unlock');
  }

  private declinedRecently(key: string): boolean {
    const at = this.opts.limiter.declinedAt.get(key);
    return at !== undefined && this.now() - at < this.opts.limiter.cooldownMs;
  }

  /**
   * For `/broker/available`: whether a resolve could end in a value. True for
   * a reference that is not marked, one that is allowed right now, and one a
   * person would be asked about. False while a person's no is in force, and
   * when the marks cannot be read.
   */
  async wouldServe(service: string, key: string): Promise<boolean> {
    const name = `${service}/${key}`;
    // A locked vault is reported as that, with its own fix, by the caller.
    this.refuseWhileLocked();
    try {
      if (!(await this.marks.has(name))) return true;
    } catch (err) {
      if (isVaultLocked(err)) throw err;
      return false;
    }
    const id = this.marks.identity(name);
    return this.approved(id) || !this.declinedRecently(readKey(id));
  }

  /**
   * Whether the value of this reference may leave the daemon now. Called
   * after the scope check and before the vault read. Shows the dialog when
   * the reference is marked and nobody has allowed it in the current window.
   * Throws when the marks cannot be read or the vault is locked; the caller
   * then hands nothing out. A caller that waited for a dialog checks its
   * scope again afterwards: the reference may have been revoked meanwhile.
   */
  async authorize(service: string, key: string, request: AskFirstRequest): Promise<AskFirstDecision> {
    const name = `${service}/${key}`;
    // Before anything else: a person is not asked about a value that cannot be read.
    this.refuseWhileLocked();
    if (!(await this.marks.has(name))) return { ok: true };
    const id = this.marks.identity(name);
    if (this.approved(id)) return { ok: true };
    const ref = `aquaman://${name}`;
    if (request.ask === false || request.via === 'loopback') {
      return {
        ok: false,
        code: 'ask_first_required',
        error: `${ref} is marked ask-first, and nobody has allowed it in the current window`,
        fix: `A person allows it in aquaman's dialog. To raise the dialog, run on the machine itself: aquaman get ${ref} > /dev/null`,
      };
    }
    const open = this.asking.get(id);
    if (open) return open;
    const asked = this.ask(service, key, { ...request, via: request.via }).finally(() => this.asking.delete(id));
    this.asking.set(id, asked);
    return asked;
  }

  private async ask(service: string, key: string, request: AskFirstRequest & { via: ReadVia }): Promise<AskFirstDecision> {
    const name = `${service}/${key}`;
    const id = this.marks.identity(name);
    const ref = `aquaman://${name}`;
    const { limiter, prompter } = this.opts;
    const audit = (error?: string, note?: string) => this.opts.audit?.({ service, error, note });
    const unavailable = (reason: string): AskFirstDecision => ({
      ok: false,
      code: 'prompt_unavailable',
      error: `${ref} is marked ask-first, and this daemon cannot show a dialog (${reason})`,
      fix: `A person can remove the mark at a terminal: aquaman broker ask ${ref} --off`,
    });
    if (!prompter) return unavailable('it was started without one');

    if (this.declinedRecently(readKey(id))) {
      // No `fix`: nothing that undoes what the person refused is handed back.
      return { ok: false, code: 'ask_first_declined', error: `A person declined to hand out ${ref} a few minutes ago; not asking again yet` };
    }
    const now = this.now();
    limiter.setTimes(limiter.times().filter((t) => now - t < limiter.windowMs));
    if (limiter.isOpen() || limiter.times().length >= limiter.maxPerWindow) {
      return {
        ok: false,
        code: 'ask_first_unanswered',
        error: `${ref} is marked ask-first, and nobody could be asked: ${limiter.isOpen() ? 'another aquaman dialog is waiting for an answer' : 'too many dialogs in a short time'}`,
        fix: 'Ask again once the open dialog is answered',
      };
    }

    limiter.setOpen(true);
    limiter.times().push(now);
    let result: PromptResult;
    try {
      const sameItemAs = await this.marks.sameItemAs(name);
      result = await prompter.askApproval({
        service,
        key,
        project: request.project,
        timeoutSeconds: clampPromptTimeout(request.timeoutSeconds),
        read: { windowSeconds: this.windowSeconds, via: request.via, ...(request.upstream !== undefined ? { upstream: request.upstream } : {}) },
        ...(sameItemAs.length > 0 ? { sameItemAs } : {}),
      });
    } catch (err) {
      result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      limiter.setOpen(false);
    }

    // The vault was locked while the dialog was up: the yes is not kept and
    // nothing is read.
    if (result.outcome === 'approved') this.refuseWhileLocked();

    if (result.outcome === 'approved') {
      this.approvedUntil.set(id, this.now() + this.windowSeconds * 1000);
      audit(undefined, `ask-first: a person allowed ${name} for ${this.windowSeconds} seconds`);
      return { ok: true };
    }
    if (result.outcome === 'declined') {
      limiter.declinedAt.set(readKey(id), this.now());
      audit(`ask_first_declined: ${name}`);
      return { ok: false, code: 'ask_first_declined', error: `The person at the dialog declined to hand out ${ref}` };
    }
    if (result.outcome === 'unavailable') {
      audit(`prompt_unavailable: ${name}`);
      return unavailable(result.reason);
    }
    // Anything but a plain yes or no, a typed value included, counts as no answer.
    audit(`ask_first_unanswered: ${name}`);
    return {
      ok: false,
      code: 'ask_first_unanswered',
      error: `${ref} is marked ask-first, and nobody answered the dialog`,
      fix: 'Ask again and answer the dialog on this machine',
    };
  }

  /** Mark a reference. Tightens, so nobody is asked. Returns whether it was not marked before. */
  async mark(service: string, key: string): Promise<boolean> {
    const name = `${service}/${key}`;
    const added = await this.marks.mark(name);
    if (added) {
      this.approvedUntil.delete(this.marks.identity(name));
      this.opts.audit?.({ service, note: `ask-first: ${name} marked` });
    }
    return added;
  }

  /**
   * Remove a mark. Loosens, so a person decides in the dialog. `declared`
   * lists the references in use, for a record that cannot be read: there
   * every reference counts as marked, and a yes about one writes the record
   * again with the others. Which others is settled here, before the dialog
   * is shown, and the dialog names them, so the list the person agreed to is
   * the list that is written whatever happens to the declaring files while
   * the dialog is up.
   */
  async unmark(
    service: string,
    key: string,
    request: { project?: string; timeoutSeconds?: number },
    declared: () => string[],
  ): Promise<{ status: 'ready' | 'unmarked' | 'declined' | 'pending'; reason?: string; code?: string; fix?: string }> {
    const name = `${service}/${key}`;
    const id = this.marks.identity(name);
    const { limiter, prompter } = this.opts;
    const audit = (error?: string, note?: string) => this.opts.audit?.({ service, error, note });
    // Read from the vault, not from memory: the answer decides whether anyone is asked.
    this.marks.forget();
    if (!(await this.marks.has(name))) return { status: 'ready' };
    if (!prompter) return { status: 'pending', code: 'prompt_unavailable', reason: 'this daemon was started without a dialog' };

    if (this.declinedRecently(unmarkKey(id))) {
      return { status: 'declined', reason: 'declined a few minutes ago; not asking again yet' };
    }
    let keepMarked: string[] | undefined;
    if ((await this.marks.list()) === 'all') {
      try {
        keepMarked = keepable(declared(), name);
      } catch (err) {
        if (!(err instanceof AskFirstFullError)) throw err;
        return {
          status: 'pending',
          code: err.code,
          reason: `the ask-first record cannot be read, and more than ${ASK_FIRST_MAX_MARKS} references are declared, which is more than it can be written again with`,
          fix: 'Revoke references that are no longer used (aquaman broker revoke <ref>), then run the command again',
        };
      }
    }
    const sameItemAs = await this.marks.sameItemAs(name);
    const now = this.now();
    limiter.setTimes(limiter.times().filter((t) => now - t < limiter.windowMs));
    if (limiter.isOpen() || limiter.times().length >= limiter.maxPerWindow) {
      return { status: 'pending', reason: limiter.isOpen() ? 'another aquaman dialog is waiting for an answer' : 'too many dialogs in a short time' };
    }
    limiter.setOpen(true);
    limiter.times().push(now);
    let result: PromptResult;
    try {
      result = await prompter.askApproval({
        service,
        key,
        project: request.project,
        timeoutSeconds: clampPromptTimeout(request.timeoutSeconds),
        unmark: true,
        ...(keepMarked !== undefined ? { keepMarked } : {}),
        ...(sameItemAs.length > 0 ? { sameItemAs } : {}),
      });
    } catch (err) {
      result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      limiter.setOpen(false);
    }

    if (result.outcome === 'approved') {
      await this.marks.unmark(name, keepMarked);
      this.approvedUntil.delete(id);
      audit(undefined, `ask-first: a person removed the mark from ${name}`);
      return { status: 'unmarked' };
    }
    if (result.outcome === 'declined') {
      limiter.declinedAt.set(unmarkKey(id), this.now());
      audit(`declined: remove the ask-first mark from ${name}`);
      return { status: 'declined', reason: 'the person at the dialog said no' };
    }
    audit(`pending: remove the ask-first mark from ${name}`);
    if (result.outcome === 'unavailable') return { status: 'pending', code: 'prompt_unavailable', reason: result.reason };
    return { status: 'pending', reason: result.outcome === 'timeout' ? 'nobody answered the dialog' : 'the dialog did not return an approval' };
  }

  /** A command changed the record in the vault: the next question is answered from there. */
  reload(): void {
    this.marks.forget();
  }
}

export interface AskFirstContext {
  fromLoopback: boolean;
  /** Absent on a proxy without a broker scope: nothing is handed out there, so there is nothing to mark. */
  gate: AskFirstGate | undefined;
  /** `<service>/<key>` of every declared reference. */
  declared(): string[];
}

/**
 * `POST /broker/ask-first`, Unix socket only.
 *
 *   { service, key, ask: true }    mark; nobody is asked
 *       200 { status: "marked" | "ready" }
 *   { service, key, ask: false }   remove the mark; a person decides in the dialog
 *       200 { status: "unmarked" | "ready" | "declined" | "pending" }
 *   { list: true }                 200 { marked: [refs] | "all", window_seconds }
 *   { reload: true }               200 { status: "reloaded" }  (the record was changed in the vault by a command)
 *   404 { code }                   no broker on this proxy, not the Unix socket, or a reserved name
 *   409 { code: "ask_first_full" } the record holds as many names as it takes
 */
export async function handleAskFirst(req: IncomingMessage, res: ServerResponse, ctx: AskFirstContext): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  const reply = (statusCode: number, body: Record<string, unknown>) => {
    res.statusCode = statusCode;
    res.end(JSON.stringify(body));
  };

  let bodyBuf = '';
  for await (const chunk of req) {
    bodyBuf += (chunk as Buffer).toString('utf-8');
    if (bodyBuf.length > 4096) {
      reply(400, { error: 'Request body too large', fix: 'POST { service, key, ask }' });
      return;
    }
  }
  let body: { service?: unknown; key?: unknown; ask?: unknown; list?: unknown; reload?: unknown; project?: unknown; timeout_seconds?: unknown } | null;
  try {
    body = JSON.parse(bodyBuf);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object') {
    reply(400, { error: 'Request body is not a JSON object', fix: 'POST { service, key, ask }' });
    return;
  }

  const { gate } = ctx;
  if (!gate) {
    reply(404, {
      error: 'The credential broker is disabled on this proxy, so it hands nothing out and has nothing to ask about',
      fix: 'OpenClaw-hosted proxies never hand out credential values. Run: aquaman daemon',
      code: 'broker_disabled',
    });
    return;
  }
  if (ctx.fromLoopback) {
    reply(404, {
      error: 'Ask-first marks are only changed over the Unix socket',
      fix: 'Run on the machine itself: aquaman broker ask <ref>',
      code: 'ask_first_local_only',
    });
    return;
  }

  const vaultError = (err: unknown) => isVaultLocked(err)
    ? reply(503, { error: err.message, fix: err.fix ?? VAULT_UNLOCK_FIX, code: VAULT_LOCKED_CODE })
    : reply(500, {
        error: `Vault backend error reading or writing the ask-first record: ${err instanceof Error ? err.message : String(err)}`,
        fix: 'Check that the configured backend is accessible. Run: aquaman doctor',
      });

  if (body.reload === true) {
    gate.reload();
    reply(200, { status: 'reloaded' });
    return;
  }
  if (body.list === true) {
    try {
      const marked = await gate.marks.list();
      reply(200, { marked: marked === 'all' ? 'all' : marked.map((n) => `aquaman://${n}`), window_seconds: gate.windowSeconds });
    } catch (err) {
      vaultError(err);
    }
    return;
  }

  const { service, key } = body;
  if (
    typeof service !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(service) || service.length > 64 ||
    typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key) || key.length > 64 ||
    typeof body.ask !== 'boolean'
  ) {
    reply(400, { error: 'Expected { service, key, ask: true | false } with names of at most 64 characters', fix: 'POST a JSON body naming one reference' });
    return;
  }
  if (isReservedService(service)) {
    reply(404, {
      error: `aquaman://${service}/${key} is not handed out, so there is nothing to ask about`,
      fix: 'Use a different service name',
      code: 'broker_ref_reserved',
    });
    return;
  }
  const ref = `aquaman://${service}/${key}`;

  try {
    if (body.ask) {
      reply(200, { status: (await gate.mark(service, key)) ? 'marked' : 'ready', ref });
      return;
    }
    const outcome = await gate.unmark(
      service,
      key,
      { project: typeof body.project === 'string' ? body.project : undefined, timeoutSeconds: clampPromptTimeout(body.timeout_seconds) },
      ctx.declared,
    );
    reply(200, {
      ...outcome,
      ref,
      // A `declined` reply carries no command: the one that does what the
      // person refused is not handed back.
      ...(outcome.status === 'pending' ? { fix: outcome.fix ?? `Run in a terminal: aquaman broker ask ${ref} --off` } : {}),
    });
  } catch (err) {
    if (err instanceof AskFirstFullError) {
      reply(409, { error: `${ref} was not marked: ${err.message}`, fix: err.fix, code: err.code });
      return;
    }
    vaultError(err);
  }
}
