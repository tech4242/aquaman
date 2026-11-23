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
 *     OpenShell driver's Resolve). It owns the approvals, which live in this
 *     process's memory only.
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

  constructor(private store: CredentialStore) {}

  private async load(): Promise<Marked> {
    // Past a cache in front of the backend, where there is one: this read
    // happens because the record may have changed.
    const fresh = (this.store as { getFresh?: (service: string, key: string) => Promise<string | null> }).getFresh;
    const raw = fresh
      ? await fresh.call(this.store, RESERVED_SERVICE, ASK_FIRST_KEY)
      : await this.store.get(RESERVED_SERVICE, ASK_FIRST_KEY);
    let marked: Marked = new Set<string>();
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
    this.cached = marked;
    return marked;
  }

  private async current(): Promise<Marked> {
    return this.cached ?? this.load();
  }

  private async save(set: Set<string>): Promise<void> {
    await this.store.set(RESERVED_SERVICE, ASK_FIRST_KEY, JSON.stringify({ v: 1, refs: [...set].sort() }));
    this.cached = set;
  }

  /** Whether `<service>/<key>` is marked. Throws when the vault cannot be read: the caller hands nothing out. */
  async has(name: string): Promise<boolean> {
    const marked = await this.current();
    return marked === 'all' || marked.has(name);
  }

  /** The marked references, or `'all'` for a record that cannot be read as one. */
  async list(): Promise<string[] | 'all'> {
    const marked = await this.current();
    return marked === 'all' ? 'all' : [...marked].sort();
  }

  /** Mark a reference. Returns whether it was not marked before. */
  async mark(name: string): Promise<boolean> {
    const marked = await this.load();
    // Everything is marked already, and writing a list here would unmark the rest.
    if (marked === 'all' || marked.has(name)) return false;
    marked.add(name);
    await this.save(marked);
    return true;
  }

  /**
   * Remove a mark, after a person agreed. Returns whether there was one.
   *
   * On a record that cannot be read as one, every reference counts as marked
   * and the person agreed about this one only. `others` names the references
   * that are in use now (the declared ones); the record is written again
   * with those marked and this one not.
   */
  async unmark(name: string, others: () => string[] = () => []): Promise<boolean> {
    const marked = await this.load();
    if (marked === 'all') {
      await this.save(new Set(others().filter((n) => NAME.test(n) && n !== name)));
      return true;
    }
    if (!marked.delete(name)) return false;
    await this.save(marked);
    return true;
  }

  /** Drop the copy in memory, so the next question is answered from the vault. */
  forget(): void {
    this.cached = undefined;
  }
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
  /** Which listener the request came in on. Aquaman's own knowledge, and all it knows about the caller. */
  via: ReadVia;
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
  /** `<service>/<key>` to the time its approval ends. Memory only: a restarted daemon has none. */
  private approvedUntil = new Map<string, number>();
  /** A dialog that is up, so a second request for the same reference waits for the same answer. */
  private asking = new Map<string, Promise<AskFirstDecision>>();
  private now: () => number;

  constructor(private opts: AskFirstGateOptions) {
    this.marks = new AskFirstMarks(opts.store);
    this.windowSeconds = opts.windowSeconds ?? ASK_FIRST_WINDOW_SECONDS;
    this.now = opts.now ?? Date.now;
  }

  private approved(name: string): boolean {
    const until = this.approvedUntil.get(name);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.approvedUntil.delete(name);
    return false;
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
    try {
      if (!(await this.marks.has(name))) return true;
    } catch {
      return false;
    }
    return this.approved(name) || !this.declinedRecently(readKey(name));
  }

  /**
   * Whether the value of this reference may leave the daemon now. Called
   * after the scope check and before the vault read. Shows the dialog when
   * the reference is marked and nobody has allowed it in the current window.
   * Throws when the marks cannot be read; the caller then hands nothing out.
   */
  async authorize(service: string, key: string, request: AskFirstRequest): Promise<AskFirstDecision> {
    const name = `${service}/${key}`;
    if (!(await this.marks.has(name))) return { ok: true };
    if (this.approved(name)) return { ok: true };
    const ref = `aquaman://${name}`;
    if (request.ask === false) {
      return {
        ok: false,
        code: 'ask_first_required',
        error: `${ref} is marked ask-first, and nobody has allowed it in the current window`,
        fix: `A person allows it in aquaman's dialog. To raise the dialog, run: aquaman get ${ref} > /dev/null`,
      };
    }
    const open = this.asking.get(name);
    if (open) return open;
    const asked = this.ask(service, key, request).finally(() => this.asking.delete(name));
    this.asking.set(name, asked);
    return asked;
  }

  private async ask(service: string, key: string, request: AskFirstRequest): Promise<AskFirstDecision> {
    const name = `${service}/${key}`;
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

    if (this.declinedRecently(readKey(name))) {
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
      result = await prompter.askApproval({
        service,
        key,
        project: request.project,
        timeoutSeconds: clampPromptTimeout(request.timeoutSeconds),
        read: { windowSeconds: this.windowSeconds, via: request.via },
      });
    } catch (err) {
      result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      limiter.setOpen(false);
    }

    if (result.outcome === 'approved') {
      this.approvedUntil.set(name, this.now() + this.windowSeconds * 1000);
      audit(undefined, `ask-first: a person allowed ${name} for ${this.windowSeconds} seconds`);
      return { ok: true };
    }
    if (result.outcome === 'declined') {
      limiter.declinedAt.set(readKey(name), this.now());
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
      this.approvedUntil.delete(name);
      this.opts.audit?.({ service, note: `ask-first: ${name} marked` });
    }
    return added;
  }

  /**
   * Remove a mark. Loosens, so a person decides in the dialog. `declared`
   * lists the references in use, for a record that cannot be read (see
   * `AskFirstMarks.unmark`).
   */
  async unmark(
    service: string,
    key: string,
    request: { project?: string; timeoutSeconds?: number },
    declared: () => string[],
  ): Promise<{ status: 'ready' | 'unmarked' | 'declined' | 'pending'; reason?: string; code?: string }> {
    const name = `${service}/${key}`;
    const { limiter, prompter } = this.opts;
    const audit = (error?: string, note?: string) => this.opts.audit?.({ service, error, note });
    // Read from the vault, not from memory: the answer decides whether anyone is asked.
    this.marks.forget();
    if (!(await this.marks.has(name))) return { status: 'ready' };
    if (!prompter) return { status: 'pending', code: 'prompt_unavailable', reason: 'this daemon was started without a dialog' };

    if (this.declinedRecently(unmarkKey(name))) {
      return { status: 'declined', reason: 'declined a few minutes ago; not asking again yet' };
    }
    const now = this.now();
    limiter.setTimes(limiter.times().filter((t) => now - t < limiter.windowMs));
    if (limiter.isOpen() || limiter.times().length >= limiter.maxPerWindow) {
      return { status: 'pending', reason: limiter.isOpen() ? 'another aquaman dialog is waiting for an answer' : 'too many dialogs in a short time' };
    }
    limiter.setOpen(true);
    limiter.times().push(now);
    let result: PromptResult;
    try {
      result = await prompter.askApproval({ service, key, project: request.project, timeoutSeconds: clampPromptTimeout(request.timeoutSeconds), unmark: true });
    } catch (err) {
      result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      limiter.setOpen(false);
    }

    if (result.outcome === 'approved') {
      await this.marks.unmark(name, declared);
      this.approvedUntil.delete(name);
      audit(undefined, `ask-first: a person removed the mark from ${name}`);
      return { status: 'unmarked' };
    }
    if (result.outcome === 'declined') {
      limiter.declinedAt.set(unmarkKey(name), this.now());
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

  const vaultError = (err: unknown) => reply(500, {
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
      ...(outcome.status === 'pending' ? { fix: `Run in a terminal: aquaman broker ask ${ref} --off` } : {}),
    });
  } catch (err) {
    vaultError(err);
  }
}
