/**
 * `POST /_service/consent`: a command asks whether aquaman may add a login
 * item (a launchd agent or a systemd user unit) for the daemon, and the daemon
 * puts that question to the person at the screen.
 *
 * The command that installs the unit may be run by an agent with no terminal,
 * and a login item is something that starts at every login. So the yes comes
 * from a dialog the daemon shows, with fixed wording and nothing in it that
 * the caller chose. The endpoint answers a status and nothing else; the
 * command does the installing.
 *
 * It shares the limits of `/broker/request`, through the same counters: one
 * dialog at a time, a bounded number per window, and no repeat for a while
 * after a decline.
 *
 * What this is not: a boundary against software running as the same user,
 * which can write a launch agent itself. It keeps aquaman's own commands from
 * adding a login item nobody saw.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { clampPromptTimeout, type CredentialPrompter, type PromptResult } from './credential-prompt.js';

/** Starts with `/_`, which no service name can, and which the route token is refused on. */
export const SERVICE_CONSENT_PATH = '/_service/consent';

/** What a person runs when no dialog can ask them. */
export const SERVICE_CONSENT_MANUAL = 'Run in a terminal: aquaman service install';

/** The cooldown entry for a declined login item. Not a credential reference, so it cannot collide with one. */
const LOGIN_ITEM_KEY = 'service:login-item';

/** The dialog counters of the proxy that owns them. */
export interface PromptLimiter {
  readonly cooldownMs: number;
  readonly windowMs: number;
  readonly maxPerWindow: number;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  times(): number[];
  setTimes(times: number[]): void;
  readonly declinedAt: Map<string, number>;
}

export interface ServiceConsentContext {
  fromLoopback: boolean;
  /** Absent on a proxy that shows no dialogs (OpenClaw-hosted, or the broker switched off). */
  prompter: CredentialPrompter | undefined;
  limiter: PromptLimiter;
  /** Record the outcome; `error` is absent for an approval. */
  audit(error?: string): void;
}

/**
 *   200 { status: "approved" }  the person allowed it
 *   200 { status: "declined" }  the person said no (or did so recently); no `fix`
 *   200 { status: "pending" }   nobody could be asked; `fix` says what a person runs
 *   404 { code }                no dialogs on this proxy, or not the Unix socket
 */
export async function handleServiceConsent(req: IncomingMessage, res: ServerResponse, ctx: ServiceConsentContext): Promise<void> {
  res.setHeader('Content-Type', 'application/json');
  const reply = (statusCode: number, body: Record<string, unknown>) => {
    res.statusCode = statusCode;
    res.end(JSON.stringify(body));
  };

  let bodyBuf = '';
  for await (const chunk of req) {
    bodyBuf += (chunk as Buffer).toString('utf-8');
    if (bodyBuf.length > 1024) {
      reply(400, { error: 'Request body too large', fix: 'POST {} or { "timeout_seconds": <number> }' });
      return;
    }
  }
  let body: { timeout_seconds?: unknown } | null = {};
  if (bodyBuf.trim() !== '') {
    try {
      body = JSON.parse(bodyBuf);
    } catch {
      body = null;
    }
  }
  if (body === null || typeof body !== 'object') {
    reply(400, { error: 'Request body is not a JSON object', fix: 'POST {} or { "timeout_seconds": <number> }' });
    return;
  }

  if (!ctx.prompter) {
    reply(404, {
      error: 'Approval dialogs are disabled on this proxy',
      fix: `OpenClaw-hosted proxies never show dialogs. ${SERVICE_CONSENT_MANUAL}`,
      code: 'broker_disabled',
    });
    return;
  }
  if (ctx.fromLoopback) {
    reply(404, {
      error: 'A login item is only approved over the Unix socket',
      fix: SERVICE_CONSENT_MANUAL,
      code: 'service_consent_local_only',
    });
    return;
  }

  const { limiter } = ctx;
  const now = Date.now();
  const declinedAt = limiter.declinedAt.get(LOGIN_ITEM_KEY);
  if (declinedAt !== undefined && now - declinedAt < limiter.cooldownMs) {
    ctx.audit('declined: login item');
    reply(200, { status: 'declined', reason: 'declined a few minutes ago; not asking again yet' });
    return;
  }
  limiter.setTimes(limiter.times().filter((t) => now - t < limiter.windowMs));
  if (limiter.isOpen() || limiter.times().length >= limiter.maxPerWindow) {
    ctx.audit('pending: login item');
    reply(200, {
      status: 'pending',
      reason: limiter.isOpen() ? 'another request is waiting for an answer' : 'too many requests in a short time',
      fix: SERVICE_CONSENT_MANUAL,
    });
    return;
  }

  limiter.setOpen(true);
  limiter.times().push(now);
  let result: PromptResult;
  try {
    result = await ctx.prompter.askLoginItem({ timeoutSeconds: clampPromptTimeout(body.timeout_seconds) });
  } catch (err) {
    result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    limiter.setOpen(false);
  }

  if (result.outcome === 'approved') {
    ctx.audit();
    reply(200, { status: 'approved' });
    return;
  }
  if (result.outcome === 'declined') {
    limiter.declinedAt.set(LOGIN_ITEM_KEY, Date.now());
    // No `fix`: the command that does what the person just refused is not handed back.
    ctx.audit('declined: login item');
    reply(200, { status: 'declined', reason: 'the person at the dialog said no' });
    return;
  }
  ctx.audit('pending: login item');
  reply(200, {
    status: 'pending',
    // Anything but a plain yes or no, a typed value included, counts as no answer.
    reason: result.outcome === 'timeout' ? 'nobody answered the dialog'
      : result.outcome === 'unavailable' ? result.reason
      : 'the dialog did not return an approval',
    fix: SERVICE_CONSENT_MANUAL,
  });
}
